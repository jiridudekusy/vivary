// Sandbox registry: per-sandbox config, creation, sticky flags.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IS_TTY, SANDBOXES_DIR, die, hostPortFree, readJson, sanitizeName } from './util.mjs';
import { detectRuntime } from './runtime.mjs';
import { getPlugins } from './plugins.mjs';
import { normalizeFlag } from './layers.mjs';

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

// Keys whose in-memory value came from a layer (project file, profiles,
// defaults) for this invocation, with the sandbox's own value underneath.
const OVERLAY = Symbol('vivary.overlay');

// sandbox.json holds only what the sandbox itself was told (sticky CLI flags,
// state). A key still carrying an overlaid value is written back as the
// sandbox's own: otherwise any unrelated save (a port, desiredRunning) turned a
// profile's or .vivary.json's value into the sandbox's — and removing it from
// the profile then changed nothing. A key a plugin changed after the overlay
// (paseo turning tailscale on) is the sandbox's own decision and is saved.
export function saveSandbox(cfg) {
  const out = { ...cfg };
  for (const [key, o] of Object.entries(cfg[OVERLAY] || {})) {
    if (!sameStickyValue(cfg[key], o.value)) continue;
    if (o.own === undefined) delete out[key];
    else out[key] = o.own;
  }
  fs.writeFileSync(path.join(sandboxDir(cfg.name), 'sandbox.json'), JSON.stringify(out, null, 2));
}

export function listSandboxNames() {
  if (!fs.existsSync(SANDBOXES_DIR)) return [];
  return fs.readdirSync(SANDBOXES_DIR).filter((n) => {
    const dir = path.join(SANDBOXES_DIR, n);
    return fs.statSync(dir).isDirectory()
      && (fs.existsSync(path.join(dir, 'sandbox.json')) || fs.existsSync(path.join(dir, 'sandbox.env')));
  });
}

// sandbox.json keys holding a host port vivary published for a sandbox. Every
// assignment checks all of them across all sandboxes, so two features (plain
// sshd publish, tailnet-facing sshd publish) can never hand out the same port.
const PORT_KEYS = ['sshPort', 'tsSshPort', 'paseoPort', 'tsPaseoPort', 'novncPort', 'tsNovncPort'];

// Stable per-sandbox host port, persisted in sandbox.json so ~/.ssh/config and
// known_hosts stay valid across restarts. `preferred` is taken when nothing
// claims it (a single-sandbox setup keeps the familiar 2222); otherwise a
// deterministic name-derived candidate, stepped until one is free. A FIXED port
// was the bug: two sandboxes on docker at once died with "Bind for
// 0.0.0.0:2222 failed: port is already allocated".
export async function assignStablePort(cfg, {
  key, base, span = 900, preferred = null, isFree = hostPortFree,
} = {}) {
  if (cfg[key]) return cfg[key];
  const used = new Set(listSandboxNames()
    .filter((n) => n !== cfg.name)
    .flatMap((n) => {
      const json = readJson(path.join(sandboxDir(n), 'sandbox.json')) || {};
      return PORT_KEYS.map((k) => json[k]).filter(Boolean);
    }));
  const hashed = [...cfg.name].reduce((a, c) => a + c.charCodeAt(0), 0) % span;
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...Array.from({ length: span }, (_, i) => base + ((hashed + i) % span)),
  ];
  for (const port of candidates) {
    if (used.has(port)) continue;
    if (!(await isFree(port))) continue;
    cfg[key] = port;
    saveSandbox(cfg);
    return port;
  }
  return die(`no free host port for '${key}' in range ${base}-${base + span - 1}`);
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

// Sticky values may be arrays (list flags like --publish), so a reference
// compare would report a change on every run and rewrite sandbox.json.
function sameStickyValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// Apply sticky plugin flags to a sandbox config, persisting changes.
// --- persistent containers: config snapshot -----------------------------------
//
// A persistent container bakes its -e env, mounts, caps and memory/cpus at
// CREATION; restarting it re-runs the entrypoint (so hooks re-apply) but cannot
// change any of that. So a later flag change would silently not take effect —
// "I turned on --docker and it does nothing". We therefore snapshot the knobs
// that shape the container and diff them on every restart.
//
// Deliberately snapshotting the FLAGS rather than the rendered run argv: the
// argv carries volatile values (-it by TTY, TERM, the ASHP proxy IP, the broker
// port) that would report changes on every run.
export function containerConfigSnapshot(cfg, flags = {}, plugins = getPlugins()) {
  const snap = {
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    runtime: cfg.runtime,
    workspace: cfg.workspace,
  };
  for (const p of plugins) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      // snapshot:false — a sticky flag the plugin can apply to a running
      // container itself (it re-adds the key via containerSnapshot where not).
      if (!def.sticky || def.snapshot === false) continue;
      const key = def.cfgKey || flag;
      snap[key] = cfg[key] ?? false;
    }
    // Something a plugin bakes into the container that no flag reflects —
    // e.g. node-modules moving its store onto a volume. A key the saved
    // snapshot lacks is a change, so a kept container built before such a
    // switch is refused (with the --recreate hint) instead of silently
    // running the old layout.
    Object.assign(snap, p.containerSnapshot?.(cfg) || {});
  }
  return snap;
}

// Changed keys between the snapshot a container was created with and the one
// this invocation wants. Exported for tests.
export function diffContainerConfig(saved, current) {
  const changes = [];
  if (!saved) return changes;   // created before snapshots existed — no claim
  for (const key of [...new Set([...Object.keys(saved), ...Object.keys(current)])].sort()) {
    const a = JSON.stringify(saved[key] ?? false);
    const b = JSON.stringify(current[key] ?? false);
    if (a !== b) changes.push({ key, from: saved[key] ?? false, to: current[key] ?? false });
  }
  return changes;
}

export function formatConfigChanges(changes) {
  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return changes.map((c) => `      ${c.key}: ${show(c.from)} -> ${show(c.to)}`).join('\n');
}

// Store a CLI value as the sandbox's own. An explicit off (`--headed=off`,
// `--node-modules=0`) is remembered in flagsOff: a stored false otherwise
// looks like "never said", and a profile would turn the flag back on.
function setOwnFlag(cfg, key, value) {
  let changed = !sameStickyValue(cfg[key], value);
  cfg[key] = value;
  const off = new Set(cfg.flagsOff || []);
  const had = off.has(key);
  if (Array.isArray(value) ? value.length : value) off.delete(key);
  else off.add(key);
  if (had !== off.has(key)) changed = true;
  if (off.size) cfg.flagsOff = [...off].sort();
  else delete cfg.flagsOff;
  return changed;
}

// Apply sticky plugin flags from the command line, persisting changes.
export function applyStickyFlags(cfg, flags) {
  let changed = false;
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky || flags[flag] === undefined) continue;
      if (setOwnFlag(cfg, def.cfgKey || flag, normalizeFlag(def, flags[flag]))) changed = true;
    }
  }
  if (changed) saveSandbox(cfg);
}

// `--profile a,b` replaces the sandbox's profile list; `--profile none`
// empties it. Persisted only when it changes.
export function applyProfileFlag(cfg, value) {
  if (value === undefined) return;
  const names = value.filter((n) => n !== 'none');
  if (JSON.stringify(cfg.profiles || []) === JSON.stringify(names)) return;
  if (names.length) cfg.profiles = names;
  else delete cfg.profiles;
  saveSandbox(cfg);
}

// Put the resolved values (resolveLayers) on cfg for this invocation — that is
// what plugins read. Not persisted: see saveSandbox.
export function applyResolvedFlags(cfg, resolved) {
  const overlay = {};
  for (const { key, value, source } of Object.values(resolved.flags)) {
    if (value === undefined || source === 'sandbox' || source === 'cli') continue;
    overlay[key] = { own: cfg[key], value };
    cfg[key] = value;
  }
  Object.defineProperty(cfg, OVERLAY, { value: overlay, enumerable: false, configurable: true });
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
  const profiles = (opts.profile || []).filter((n) => n !== 'none');
  if (profiles.length) cfg.profiles = profiles;
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (!def.sticky) continue;
      const key = def.cfgKey || flag;
      if (opts[flag] === undefined) cfg[key] = false;
      else setOwnFlag(cfg, key, normalizeFlag(def, opts[flag]));
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
