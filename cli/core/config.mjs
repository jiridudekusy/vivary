// Project/global JSON config: <workspace>/.vivary.json (committable, full
// sandbox settings) and ~/.vivary/vivary.json (global defaults, used ONLY
// when no project file exists — the two never merge).
//
// Precedence: CLI flags > .vivary.json > (only without a project file)
// ~/.vivary/vivary.json > built-in defaults. A project file also overrides
// sticky flags stored in sandbox.json — the overlay is in-memory per
// invocation, so nothing file-derived is ever persisted as sticky.
//
// SECURITY: the agent inside the sandbox can write .vivary.json in the
// workspace. It must not self-escalate (--sudo, egress allow rules) by
// editing it, so every content change goes through a host-side approval
// gate: sandbox.json stores `configApproved` (sha256 of the file bytes) and
// ~/.vivary/<name>/vivary-approved.json keeps the approved copy for diffing.
// Nothing inside the sandbox can reach either (the sandbox state dir root is
// never mounted). Non-TTY runs die loudly on an unapproved change.
//
// The parse/validate/resolve/diff/write-back helpers are pure (throw instead
// of exiting) and exported for unit tests; the load*/approve* wrappers do IO.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IS_TTY, SANDBOXES_DIR, ask, die } from './util.mjs';

export const PROJECT_CONFIG_NAME = '.vivary.json';
export const APPROVED_COPY_NAME = 'vivary-approved.json';
export const globalConfigFile = () => path.join(SANDBOXES_DIR, 'vivary.json');

const SCALAR_KEYS = ['agent', 'runtime', 'memory', 'cpus'];

// --- pure: validation ----------------------------------------------------------

// Validate a parsed config object. `scope` is 'project' | 'global' (the
// global file supports the same keys except `egress` — policy is
// project-scoped). `knownFlags` maps flag name -> parseArgs type
// ('boolean' | 'optional' | 'string'); unknown keys and unknown flags fail
// loudly (typo protection), never silently.
export function validateConfig(cfg, { scope = 'project', file = PROJECT_CONFIG_NAME, knownFlags = {} } = {}) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${file}: must be a JSON object`);
  }
  const known = new Set([...SCALAR_KEYS, 'flags', ...(scope === 'project' ? ['egress'] : [])]);
  for (const key of Object.keys(cfg)) {
    if (!known.has(key)) {
      throw new Error(`${file}: unknown key '${key}' (known: ${[...known].join(', ')})`);
    }
  }
  for (const key of SCALAR_KEYS) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'string') {
      throw new Error(`${file}: '${key}' must be a string`);
    }
  }
  if (cfg.flags !== undefined) {
    if (cfg.flags === null || typeof cfg.flags !== 'object' || Array.isArray(cfg.flags)) {
      throw new Error(`${file}: 'flags' must be an object of plugin flags`);
    }
    for (const [flag, value] of Object.entries(cfg.flags)) {
      const type = knownFlags[flag];
      if (!type) {
        throw new Error(`${file}: unknown flag '${flag}' in 'flags' (known: ${Object.keys(knownFlags).sort().join(', ')})`);
      }
      const ok = type === 'boolean' ? typeof value === 'boolean'
        : type === 'string' ? typeof value === 'string'
        : ['boolean', 'number', 'string'].includes(typeof value); // 'optional'
      if (!ok) throw new Error(`${file}: flag '${flag}' has invalid value ${JSON.stringify(value)} (expected ${type})`);
    }
  }
  if (cfg.egress !== undefined) {
    if (cfg.egress === null || typeof cfg.egress !== 'object' || Array.isArray(cfg.egress)) {
      throw new Error(`${file}: 'egress' must be an object`);
    }
    for (const key of Object.keys(cfg.egress)) {
      if (!['presets', 'allow'].includes(key)) {
        throw new Error(`${file}: unknown key 'egress.${key}' (known: presets, allow)`);
      }
      const v = cfg.egress[key];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`${file}: 'egress.${key}' must be an array of strings`);
      }
    }
  }
  return cfg;
}

// Parse + validate raw file bytes; throws with the file name on bad JSON.
export function parseConfig(raw, opts) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${opts?.file || PROJECT_CONFIG_NAME}: invalid JSON — ${e.message}`);
  }
  return validateConfig(parsed, opts);
}

// --- pure: precedence -----------------------------------------------------------

// Resolve the effective invocation config. `project` and `global` are the
// PARSED file contents (or null); the two files never merge — a project file
// completely replaces the global defaults layer. Returns:
//   { agent, runtime, memory, cpus,   — CLI > file (undefined = use defaults)
//     flags,                          — file flags overlaid with CLI flags
//     egress }                        — project file's egress section or null
export function resolveEffectiveConfig({ cliFlags = {}, project = null, global: globalCfg = null } = {}) {
  const fileCfg = project ?? globalCfg ?? {};
  const core = new Set([...SCALAR_KEYS, 'name', 'workspace']);
  const flags = { ...(fileCfg.flags || {}) };
  for (const [k, v] of Object.entries(cliFlags)) {
    if (v !== undefined && !core.has(k)) flags[k] = v;
  }
  const effective = { flags, egress: project?.egress ?? null };
  for (const key of SCALAR_KEYS) {
    effective[key] = cliFlags[key] !== undefined ? cliFlags[key] : fileCfg[key];
  }
  return effective;
}

// --- pure: approval hash + diff -------------------------------------------------

export function configHash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Minimal line-based unified diff (full file, no hunk trimming — configs are
// small). LCS over lines; ' ' context, '-' removed, '+' added.
export function unifiedDiff(oldText, newText, oldLabel = 'approved', newLabel = 'current') {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS length table
  const m = a.length;
  const n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) lines.push(`- ${a[i++]}`);
  while (j < n) lines.push(`+ ${b[j++]}`);
  return lines.join('\n');
}

// --- pure: write-back (union only) ----------------------------------------------

// Compute the union write-back of CLI-typed values into an existing project
// config: sticky flags newly enabled on the CLI and memory/cpus/agent given
// on the CLI and differing from the file. Extension only — nothing in the
// file is ever removed or downgraded (falsy CLI flag values are skipped).
// Returns { config, changed } with key order preserved (new keys appended in
// schema order).
export function computeWriteBack(fileCfg, cliFlags, stickyFlagNames = []) {
  const next = structuredClone(fileCfg);
  let changed = false;
  for (const key of ['agent', 'memory', 'cpus']) {
    const v = cliFlags[key];
    if (v !== undefined && v !== next[key]) {
      next[key] = v;
      changed = true;
    }
  }
  for (const flag of stickyFlagNames) {
    const v = cliFlags[flag];
    if (v === undefined || !v) continue; // union only: never write false/0/off
    if (next.flags?.[flag] !== v) {
      next.flags = { ...(next.flags || {}) };
      next.flags[flag] = v;
      changed = true;
    }
  }
  return { config: next, changed };
}

// --- IO wrappers ----------------------------------------------------------------

// Load + validate a config file. Returns { file, raw, config } or null when
// the file does not exist. Any problem (bad JSON, unknown keys) dies loudly.
export function loadConfigFile(file, opts) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return { file, raw, config: parseConfig(raw, { ...opts, file }) };
  } catch (e) {
    die(e.message);
  }
  return null; // unreachable (die exits)
}

export function loadProjectConfig(workspace, knownFlags) {
  return loadConfigFile(path.join(workspace, PROJECT_CONFIG_NAME),
    { scope: 'project', knownFlags });
}

export function loadGlobalConfig(knownFlags) {
  return loadConfigFile(globalConfigFile(), { scope: 'global', knownFlags });
}

// Record approval: verbatim copy for future diffs + hash in sandbox.json.
// `saveSandbox` is passed in to avoid a config->sandbox import cycle.
export function markApproved(cfg, project, dir, saveSandbox) {
  fs.writeFileSync(path.join(dir, APPROVED_COPY_NAME), project.raw);
  cfg.configApproved = configHash(project.raw);
  saveSandbox(cfg);
}

// The approval gate, run on every start/up/shell that sees a project file.
// Unchanged (hash == approved) -> silent. Changed or first sight -> show the
// diff against the approved copy; TTY prompts [y/N], non-TTY dies loudly.
// Purely host-side: nothing inside the sandbox can approve.
export async function approveProjectConfig(cfg, project, dir, saveSandbox) {
  const hash = configHash(project.raw);
  if (cfg.configApproved === hash) return;
  const approvedFile = path.join(dir, APPROVED_COPY_NAME);
  const prev = fs.existsSync(approvedFile) ? fs.readFileSync(approvedFile, 'utf8') : '';
  console.log(prev
    ? `==> ${PROJECT_CONFIG_NAME} changed since last approval:`
    : `==> New ${PROJECT_CONFIG_NAME} found (not yet approved):`);
  console.log(unifiedDiff(prev, project.raw,
    prev ? 'approved' : '(none approved yet)', project.file));
  console.log('    The file is agent-writable — review the change before applying it.');
  if (!IS_TTY) {
    die(`${project.file} is not approved for sandbox '${cfg.name}'.\n` +
        'Run an interactive command (e.g. vivary start) to review and approve it.');
  }
  const answer = (await ask('Apply this configuration? [y/N]: ')).trim();
  if (!/^y/i.test(answer)) die('configuration not approved');
  markApproved(cfg, project, dir, saveSandbox);
  console.log('==> Configuration approved.');
}

// Union write-back of CLI flags into an existing project file. The user
// typed the flags, so the result is auto-approved (file, hash and approved
// copy updated together). No project file -> no write-back.
export function writeBackCliFlags(cfg, project, cliFlags, stickyFlagNames, dir, saveSandbox) {
  if (!project) return;
  const { config, changed } = computeWriteBack(project.config, cliFlags, stickyFlagNames);
  if (!changed) return;
  const raw = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(project.file, raw);
  markApproved(cfg, { ...project, raw, config }, dir, saveSandbox);
  console.log(`==> ${PROJECT_CONFIG_NAME} extended with CLI flags (auto-approved).`);
}
