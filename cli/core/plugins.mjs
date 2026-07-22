// Plugin loader and registry.
//
// A plugin is plugins/<name>/plugin.mjs exporting (all fields optional
// except name):
//   name       unique id
//   order      number — deterministic ordering (dockerfile fragments,
//              entrypoint hooks, wizard steps); default 50
//   flags      { 'flag-name': { type: 'boolean'|'optional'|'string',
//                sticky: true, cfgKey: 'hostOpen', normalize(v) -> stored,
//                help: '...' } }
//   agents     { claude: { cmd: 'claude' } }
//   launchers  { slaude: 'claude' }   — extra bin names -> agent
//   needsBroker(cfg) -> bool          — inject SBX_OPEN_URL/TOKEN env
//   runArgs(ctx) -> [args]            — every start/up/shell (may be async)
//   upArgs(ctx) -> [args]             — extra args for `up` (detached mode)
//   postUp(ctx, net) / preUp(ctx)     — up lifecycle (ssh registration etc.)
//   onCreate(ctx, {interactive})      — sandbox creation (import wizards)
//   onPurge(name)                     — cleanup on rm --purge
//   broker(req helpers) -> handled?   — HTTP routes on the host broker
//   commands   { broker: fn(argv) }   — extra CLI subcommands
//
// Container-side parts live next to plugin.mjs:
//   image.dockerfile   fragment appended to the composed Dockerfile
//   rootfs/            files COPY'd into the image under /
//   entrypoint.d/      startup hooks (self-gated by their env variable)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_DIR, die } from './util.mjs';

export const PLUGINS_DIR = path.join(CLI_DIR, 'plugins');
let loaded = null;

export async function loadPlugins() {
  if (loaded) return loaded;
  const plugins = [];
  for (const name of fs.readdirSync(PLUGINS_DIR).sort()) {
    const file = path.join(PLUGINS_DIR, name, 'plugin.mjs');
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file))).default;
    if (!mod?.name) die(`plugin ${name} has no name`);
    mod.dir = path.join(PLUGINS_DIR, name);
    mod.order = mod.order ?? 50;
    plugins.push(mod);
  }
  plugins.sort((a, b) => a.order - b.order);
  loaded = plugins;
  return plugins;
}

export function getPlugins() {
  if (!loaded) die('plugins not loaded');
  return loaded;
}

// Aggregated flag spec for parseArgs (core spec + all plugin flags).
export function pluginFlagSpec() {
  const spec = {};
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) spec[flag] = def.type;
  }
  return spec;
}

// Full flag definitions by flag name (for config validation/normalization).
export function pluginFlagDefs() {
  const defs = {};
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) defs[flag] = def;
  }
  return defs;
}

// All agents / launchers across plugins.
export function agentRegistry() {
  const agents = {};
  const launchers = {};
  for (const p of getPlugins()) {
    Object.assign(agents, p.agents || {});
    Object.assign(launchers, p.launchers || {});
  }
  return { agents, launchers };
}

// Plugin-contributed CLI commands.
export function pluginCommands() {
  const commands = {};
  for (const p of getPlugins()) Object.assign(commands, p.commands || {});
  return commands;
}

// Help lines for plugin flags.
export function pluginHelp() {
  const lines = [];
  for (const p of getPlugins()) {
    for (const [flag, def] of Object.entries(p.flags || {})) {
      if (def.help) lines.push(`  --${flag}${def.type === 'optional' ? '[=N]' : ''}\n${def.help.replace(/^/gm, '                       ')}`);
    }
  }
  return lines.join('\n');
}
