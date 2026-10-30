// `vivary config [name]` — a sandbox's settings as its next start resolves
// them, each with the layer it came from. `vivary profile [ls|show <name>]` —
// the named profiles and who uses them. With several layers stacked
// (layers.mjs), "why is this on?" needs an answer that is not reading four
// JSON files.
import fs from 'node:fs';
import path from 'node:path';
import { die, parseArgs } from './util.mjs';
import { PROJECT_CONFIG_NAME, listProfileNames, loadProfile, profilesDir } from './config.mjs';
import { profileNames } from './layers.mjs';
import { pluginFlagDefs } from './plugins.mjs';
import { effectiveSandbox } from './effective.mjs';
import { listSandboxNames, loadSandbox, resolveName } from './sandbox.mjs';

const on = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
const show = (v) => (Array.isArray(v) ? v.join(', ') : v === true ? 'on' : v === false ? 'off' : String(v));

// Rows for `vivary config`: the scalars, every flag that is on or was turned
// off by someone (an off nobody asked for is noise), dockerd and egress.
export function configRows(cfg, resolved) {
  const rows = [];
  const runtimeSource = cfg.projectConfig?.runtime ? 'project' : 'sandbox';
  rows.push(['agent', resolved.agent.value || cfg.agent || 'claude', resolved.agent.value ? resolved.agent.source : 'sandbox']);
  rows.push(['runtime', cfg.projectConfig?.runtime || cfg.runtime, runtimeSource]);
  rows.push(['memory', resolved.memory.value || process.env.SANDBOX_MEMORY || '4g', resolved.memory.source]);
  rows.push(['cpus', resolved.cpus.value || process.env.SANDBOX_CPUS || '4', resolved.cpus.source]);
  for (const [flag, r] of Object.entries(resolved.flags).sort(([a], [b]) => a.localeCompare(b))) {
    if (!on(r.value) && r.source === 'built-in') continue;
    rows.push([flag, show(r.value), r.source]);
  }
  if (resolved.dockerd.sources.length) {
    rows.push(['dockerd', JSON.stringify(resolved.dockerd.value), resolved.dockerd.sources.join(' + ')]);
  }
  if (resolved.egress) {
    const e = resolved.egress;
    rows.push(['egress policy', `presets: ${e.presets.join(', ') || '—'}; allow: ${e.allow.join(', ') || '—'}`, '']);
  }
  return rows;
}

function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((cell, c) => String(cell).padEnd(w[c] + 2)).join('').trimEnd()).join('\n');
}

export function cmdConfig(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = resolveName(flags.name || positionals[0], process.cwd());
  const cfg = effectiveSandbox(name) || die(`sandbox '${name}' does not exist`);
  const { resolved, projectConfig } = cfg;
  const hasProject = projectConfig !== null;
  const profiles = profileNames(cfg.profiles, projectConfig?.profiles);

  console.log(`Sandbox   ${name}  (${cfg.workspace})`);
  const layers = ['CLI', ...(hasProject ? [PROJECT_CONFIG_NAME] : []), 'sandbox',
    ...profiles.slice().reverse().map((p) => `profile:${p}`), ...(hasProject ? [] : ['default'])];
  console.log(`Layers    ${layers.join(' > ')}`);
  if (hasProject) console.log(`          (~/.vivary/vivary.json not used: the workspace has its own ${PROJECT_CONFIG_NAME})`);
  if (profiles.length) {
    const own = cfg.profiles || [];
    const fromFile = (projectConfig?.profiles || []).filter((p) => !own.includes(p));
    console.log(`Profiles  ${[...own.map((p) => `${p} (sandbox)`), ...fromFile.map((p) => `${p} (${PROJECT_CONFIG_NAME})`)].join(', ')}`);
  }
  console.log('');
  console.log(table([['SETTING', 'VALUE', 'FROM'], ...configRows(cfg, resolved)]));
}

// Which sandboxes use a profile: their own list, or their approved project file.
function usersOf(profile) {
  const users = [];
  for (const name of listSandboxNames().sort()) {
    const cfg = loadSandbox(name);
    if (!cfg) continue;
    if ((cfg.profiles || []).includes(profile)) {
      users.push(name);
      continue;
    }
    try {
      const approved = JSON.parse(fs.readFileSync(path.join(path.dirname(profilesDir()), name, 'vivary-approved.json'), 'utf8'));
      if (fs.existsSync(path.join(cfg.workspace, PROJECT_CONFIG_NAME)) && (approved.profiles || []).includes(profile)) {
        users.push(`${name} (${PROJECT_CONFIG_NAME})`);
      }
    } catch { /* no approved project file */ }
  }
  return users;
}

export function cmdProfile(argv) {
  const [action = 'ls', name] = argv;
  if (action === 'ls' || action === 'list') {
    const names = listProfileNames();
    if (!names.length) {
      console.log(`No profiles yet. A profile is ${profilesDir()}/<name>.json with the same keys as\n`
        + `${PROJECT_CONFIG_NAME} (agent, runtime, memory, cpus, flags, egress, dockerd); use it with\n`
        + '--profile <name> (sticky, repeatable — the last one listed wins).');
      return;
    }
    const knownFlags = pluginFlagDefs();
    const rows = [['PROFILE', 'SETS', 'USED BY']];
    for (const n of names) {
      const { config } = loadProfile(n, knownFlags);
      const sets = [...Object.keys(config).filter((k) => k !== 'flags'), ...Object.keys(config.flags || {})];
      rows.push([n, sets.join(', ') || '—', usersOf(n).join(', ') || '—']);
    }
    console.log(table(rows));
    return;
  }
  if (action === 'show') {
    if (!name) die('usage: vivary profile show <name>');
    const p = loadProfile(name, pluginFlagDefs());
    console.log(`# ${p.file}`);
    console.log(p.raw.trimEnd());
    return;
  }
  die(`unknown action '${action}' (expected: ls, show <name>)`);
}
