// Sandbox registry: per-sandbox config, creation, sticky flags.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IS_TTY, SANDBOXES_DIR, die, readJson, sanitizeName } from './util.mjs';
import { detectRuntime } from './runtime.mjs';
import { getPlugins } from './plugins.mjs';

export function sandboxDir(name) {
  return path.join(SANDBOXES_DIR, name);
}

// Load sandbox config; migrates legacy sandbox.env (bash era) to sandbox.json.
export function loadSandbox(name) {
  const dir = sandboxDir(name);
  const jsonFile = path.join(dir, 'sandbox.json');
  const json = readJson(jsonFile);
  if (json) return json;
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
function normalizeFlag(def, value) {
  if (value === undefined) return undefined;
  if (def.normalize) return def.normalize(value);
  return !!value;
}

// Apply sticky plugin flags to a sandbox config, persisting changes.
export function applyStickyFlags(cfg, flags) {
  let changed = false;
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky || flags[flag] === undefined) continue;
      const key = def.cfgKey || flag;
      const next = normalizeFlag(def, flags[flag]);
      if (cfg[key] !== next) {
        cfg[key] = next;
        changed = true;
      }
    }
  }
  if (changed) saveSandbox(cfg);
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
