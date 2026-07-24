// Sandbox registry: per-sandbox config, creation, sticky flags.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IS_TTY, SANDBOXES_DIR, die, readJson, sanitizeName } from './util.mjs';
import { detectRuntime } from './runtime.mjs';
import { getPlugins } from './plugins.mjs';

export function sandboxDir(name) {
  return path.join(SANDBOXES_DIR, name);
}

// Rename the own-modules sticky key in place. Unlike .vivary.json (agent-
// writable, so an old flag name dies loudly there), sandbox.json is host-only
// state: migrating it silently is safe, and NOT migrating would quietly turn
// the overlays off for every existing sandbox.
export function migrateLegacyKeys(json, jsonFile, write = fs.writeFileSync) {
  if (json.ownModules === undefined || json.nodeModules !== undefined) return json;
  const { ownModules, ...rest } = json;
  const migrated = { ...rest, nodeModules: ownModules };
  write(jsonFile, JSON.stringify(migrated, null, 2));
  return migrated;
}

// Load sandbox config; migrates legacy sandbox.env (bash era) to sandbox.json.
export function loadSandbox(name) {
  const dir = sandboxDir(name);
  const jsonFile = path.join(dir, 'sandbox.json');
  const json = readJson(jsonFile);
  if (json) return migrateLegacyKeys(json, jsonFile);
  const envFile = path.join(dir, 'sandbox.env');
  if (fs.existsSync(envFile)) {
    const env = Object.fromEntries(
      fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
    const migrated = {
      name,
      workspace: env.WORKSPACE,
      runtime: detectRuntime(),
      agent: 'claude',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(jsonFile, JSON.stringify(migrated, null, 2));
    return migrated;
  }
  return null;
}

export function saveSandbox(cfg) {
  fs.writeFileSync(path.join(sandboxDir(cfg.name), 'sandbox.json'), JSON.stringify(cfg, null, 2));
}

export function listSandboxNames() {
  if (!fs.existsSync(SANDBOXES_DIR)) return [];
  return fs.readdirSync(SANDBOXES_DIR).filter((n) => {
    const dir = path.join(SANDBOXES_DIR, n);
    return fs.statSync(dir).isDirectory()
      && (fs.existsSync(path.join(dir, 'sandbox.json')) || fs.existsSync(path.join(dir, 'sandbox.env')));
  });
}

export function allowedWorkspaces() {
  return listSandboxNames().map((n) => loadSandbox(n)?.workspace).filter(Boolean)
    .map((w) => path.resolve(w));
}

// Resolve sandbox name: explicit arg, or derived from cwd basename. When the
// name maps to an existing sandbox with a different workspace, fail loudly.
export function resolveName(explicit, workspace) {
  const name = explicit || sanitizeName(path.basename(workspace));
  const existing = loadSandbox(name);
  if (existing && path.resolve(existing.workspace) !== path.resolve(workspace) && !explicit) {
    die(`sandbox '${name}' already exists for workspace ${existing.workspace}.\n` +
        `Run from that directory, or pick a name: vivary start --name <other-name>`);
  }
  return name;
}

// Normalize a raw flag value using the plugin flag definition. Default:
// boolean presence. 'optional' flags may carry a value (--flag=N).
//
// `origin` tells normalize where the value came from: 'cli' means a human typed
// it, 'file' means it came from .vivary.json — which the agent inside the
// sandbox can write. Flags that hand out host access (mounts) trust the two
// differently, so the distinction has to survive down to normalize.
function normalizeFlag(def, value, origin = 'cli') {
  if (value === undefined) return undefined;
  if (def.normalize) return def.normalize(value, { origin });
  return !!value;
}

// Sticky values may be arrays (list flags like --publish), so a reference
// compare would report a change on every run and rewrite sandbox.json.
function sameStickyValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// Apply sticky plugin flags to a sandbox config, persisting changes.
export function applyStickyFlags(cfg, flags) {
  let changed = false;
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky || flags[flag] === undefined) continue;
      const key = def.cfgKey || flag;
      const next = normalizeFlag(def, flags[flag]);
      if (!sameStickyValue(cfg[key], next)) {
        cfg[key] = next;
        changed = true;
      }
    }
  }
  if (changed) saveSandbox(cfg);
}

// In-memory overlay of config-file flags (.vivary.json / global defaults)
// onto the sandbox config for this invocation. Intentionally NOT persisted:
// sticky values in sandbox.json only ever come from CLI flags, so removing a
// flag from the file takes effect on the next run (values may still reach
// sandbox.json via unrelated saves — e.g. tailscale persisting its port —
// which is harmless: overlaid values passed the approval gate).
// `fileFlags` arrives with CLI flags already overlaid on top (that is the
// effective set for this invocation), so `cliFlags` is what tells the two apart
// — without it a value the human typed would be judged as agent-written.
export function overlayConfigFlags(cfg, fileFlags = {}, cliFlags = {}) {
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky || fileFlags[flag] === undefined) continue;
      const origin = cliFlags[flag] === undefined ? 'file' : 'cli';
      cfg[def.cfgKey || flag] = normalizeFlag(def, fileFlags[flag], origin);
    }
  }
}

export async function createSandbox(name, workspace, opts) {
  const dir = sandboxDir(name);
  if (loadSandbox(name)) die(`sandbox '${name}' already exists at ${dir}`);
  fs.mkdirSync(path.join(dir, 'dot-config'), { recursive: true });
  console.log(`==> Created sandbox state dir: ${dir}`);

  const cfg = {
    name,
    workspace,
    runtime: opts.runtime || detectRuntime(),
    agent: opts.agent || 'claude',
    createdAt: new Date().toISOString(),
  };
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky) continue;
      cfg[def.cfgKey || flag] = normalizeFlag(def, opts[flag]) ?? false;
    }
  }
  saveSandbox(cfg);

  const interactive = !!opts.interactive && IS_TTY;
  for (const p of getPlugins()) {
    if (p.onCreate) await p.onCreate({ cfg, dir, HOME }, { interactive });
  }

  console.log(`==> Sandbox '${name}' created (runtime: ${cfg.runtime}, workspace: ${workspace})`);
  return cfg;
}

// Load or auto-create (with defaults) the sandbox for start/up/shell.
export async function ensureSandbox(explicitName, opts) {
  const workspace = path.resolve(opts.workspace || process.cwd());
  const name = resolveName(explicitName, workspace);
  let cfg = loadSandbox(name);
  if (!cfg) {
    cfg = await createSandbox(name, workspace, { ...opts, interactive: false });
  }
  if (!fs.existsSync(cfg.workspace)) die(`workspace ${cfg.workspace} no longer exists`);
  fs.mkdirSync(path.join(sandboxDir(name), 'dot-config'), { recursive: true });
  return cfg;
}
