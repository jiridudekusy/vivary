// Change a sandbox's settings and approve its project file WITHOUT starting
// it, and say what a change takes to apply:
//   vivary set <name> --memory 8g --headed=off --profile a,b [--json]
//   vivary approve <name> [--sha <sha256>] [--json]
//   vivary config <name> --json        (configJson below)
// `vivary web` drives these as CHILD processes — a die() there ends the child,
// not the server — so the web and the CLI share one implementation.
//
// `set` writes the sandbox's OWN layer, exactly what `vivary up --flag` makes
// sticky. A value set by the project .vivary.json is above that layer, so
// changing it here would do nothing: refused, with where to change it instead.
// List flags (--publish, --volume) are not settable here: they hand out host
// ports and host paths, and stay on `vivary up` on the Mac.
import { IS_TTY, die, parseArgs } from './util.mjs';
import {
  PROJECT_CONFIG_NAME, approveProjectConfig, configHash, listProfileNames, loadProjectConfig, markApproved,
} from './config.mjs';
import { effectiveSandbox, loadProfiles } from './effective.mjs';
import { profileNames } from './layers.mjs';
import { pluginFlagDefs } from './plugins.mjs';
import {
  applyProfileFlag, applyStickyFlags, containerConfigSnapshot, diffContainerConfig, loadSandbox, resolveName,
  sandboxDir, saveSandbox,
} from './sandbox.mjs';
import { resolveRuntime } from './runtimes/index.mjs';

const MEMORY = /^[1-9][0-9]{0,4}[mMgG]$/;
const CPUS = /^[1-9][0-9]?$/;

// Flags `set` can change: sticky, and not a list.
export const settable = (def) => !!def?.sticky && def.type !== 'list';

// Check a requested change against the layers. Returns the problems (empty =
// fine). `resolved` is the current resolution (effectiveSandbox().resolved).
export function planSet(changes, { defs, resolved }) {
  const errors = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'memory' || key === 'cpus') {
      if (!(key === 'memory' ? MEMORY : CPUS).test(String(value))) {
        errors.push(`${key}: '${value}' is not a valid ${key === 'memory' ? 'size (e.g. 8g, 512m)' : 'CPU count'}`);
      } else if (resolved[key]?.source === 'project') {
        errors.push(`${key} is set by ${PROJECT_CONFIG_NAME} — change it there`);
      }
    } else if (key === 'profile') {
      // checked by loadProfiles (an unknown name dies loudly)
    } else if (!defs[key]) {
      errors.push(`unknown setting '${key}'`);
    } else if (!settable(defs[key])) {
      errors.push(`--${key} is not settable here — use vivary up --${key} on the Mac`);
    } else if (resolved.flags[key]?.source === 'project') {
      errors.push(`--${key} is set by ${PROJECT_CONFIG_NAME} — change it there`);
    }
  }
  return errors;
}

// What it takes for the change to apply. A kept container bakes its snapshot
// (env, mounts, caps, size) in, so a snapshot difference means --recreate;
// anything else is picked up by the next start (postUp etc.).
export function effectOf({ changed, drift, exists, running }) {
  if (!changed) return 'none';
  if (!exists) return 'next-start';
  if (drift.length) return 'recreate';
  return running ? 'restart' : 'next-start';
}

// The sandbox as its next start resolves it: values, and how the container it
// would want differs from the one it has.
function resolvedState(name) {
  const eff = effectiveSandbox(name);
  const r = eff.resolved;
  const runtime = eff.projectConfig?.runtime || eff.runtime;
  const snap = containerConfigSnapshot({ ...eff, runtime }, { memory: r.memory.value, cpus: r.cpus.value });
  const values = {
    memory: snap.memory,
    cpus: snap.cpus,
    profiles: profileNames(eff.profiles, eff.projectConfig?.profiles),
    ...Object.fromEntries(Object.entries(r.flags).map(([f, x]) => [f, x.value ?? false])),
  };
  return { eff, runtime, values, drift: diffContainerConfig(eff.containerConfig, snap) };
}

const show = (v) => (Array.isArray(v) ? (v.join(', ') || 'none') : v === true ? 'on' : v === false ? 'off' : String(v));

export function describeEffect(name, effect, drift) {
  switch (effect) {
    case 'none': return 'Nothing changed.';
    case 'next-start': return 'Applies at the next start.';
    case 'restart': return `Applies after a restart: vivary down ${name} && vivary up ${name}`;
    default:
      return 'Needs a rebuild of the container — it bakes these in:\n'
        + `${drift.map((c) => `      ${c.key}: ${show(c.from)} -> ${show(c.to)}`).join('\n')}\n`
        + `    vivary up ${name} --recreate   (anything installed inside the container is lost)`;
  }
}

export async function cmdSet(argv) {
  const defs = pluginFlagDefs();
  const spec = { name: 'string', memory: 'string', cpus: 'string', profile: 'list', json: 'boolean' };
  for (const [flag, def] of Object.entries(defs)) if (settable(def)) spec[flag] = def.type;
  const { flags, positionals } = parseArgs(argv, spec);
  const name = resolveName(flags.name || positionals[0], process.cwd());
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  const { json, name: _ignored, ...changes } = flags;
  if (!Object.keys(changes).length) die('nothing to set — e.g.: vivary set <name> --memory 8g --headed=off');

  const before = resolvedState(name);
  const errors = planSet(changes, { defs, resolved: before.eff.resolved });
  if (errors.length) die(errors.join('\n'));
  if (changes.profile) loadProfiles(changes.profile.filter((n) => n !== 'none'), defs);

  applyStickyFlags(cfg, changes);
  for (const key of ['memory', 'cpus']) {
    if (changes[key] !== undefined && cfg[key] !== changes[key]) {
      cfg[key] = changes[key];
      saveSandbox(cfg);
    }
  }
  applyProfileFlag(cfg, changes.profile);

  const after = resolvedState(name);
  const diff = Object.keys(after.values)
    .filter((k) => JSON.stringify(before.values[k]) !== JSON.stringify(after.values[k]))
    .map((k) => ({ key: k, from: before.values[k], to: after.values[k] }));
  const rt = resolveRuntime(after.runtime);
  const exists = rt.exists(name);
  const running = rt.isRunning(name);
  const effect = effectOf({ changed: diff.length > 0, drift: after.drift, exists, running });
  if (json) {
    console.log(JSON.stringify({ name, changed: diff, effect, drift: after.drift, exists, running }));
    return;
  }
  if (diff.length) console.log(`==> ${name}: ${diff.map((c) => `${c.key} ${show(c.from)} -> ${show(c.to)}`).join(', ')}`);
  console.log(`    ${describeEffect(name, effect, after.drift)}`);
}

// `vivary config <name> --json`: everything the web shows and edits.
export function configJson(name) {
  const cfg = effectiveSandbox(name) || die(`sandbox '${name}' does not exist`);
  const defs = pluginFlagDefs();
  const { resolved, projectConfig } = cfg;
  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
  return {
    name,
    workspace: cfg.workspace,
    runtime: projectConfig?.runtime || cfg.runtime,
    agent: resolved.agent.value || cfg.agent || 'claude',
    memory: { value: resolved.memory.value || process.env.SANDBOX_MEMORY || '4g', source: resolved.memory.source },
    cpus: { value: resolved.cpus.value || process.env.SANDBOX_CPUS || '4', source: resolved.cpus.source },
    profiles: {
      own: cfg.profiles || [],
      fromProject: (projectConfig?.profiles || []).filter((p) => !(cfg.profiles || []).includes(p)),
      available: listProfileNames(),
    },
    flags: Object.entries(resolved.flags).sort(([a], [b]) => a.localeCompare(b)).map(([flag, r]) => ({
      name: flag,
      type: defs[flag].type,
      value: r.value ?? false,
      source: r.source,
      settable: settable(defs[flag]),
      live: defs[flag].snapshot === false,
      help: oneLine(defs[flag].help),
    })),
    egress: resolved.egress,
    hasProject: projectConfig !== null,
    // Settings the kept container does not have yet (it bakes them in).
    pendingRecreate: resolvedState(name).drift,
  };
}

export async function cmdApprove(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string', sha: 'string', json: 'boolean' });
  const name = resolveName(flags.name || positionals[0], process.cwd());
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  // Dies on invalid JSON or unknown keys: a file that would not load cannot be approved.
  const project = loadProjectConfig(cfg.workspace, pluginFlagDefs())
    || die(`${cfg.workspace} has no ${PROJECT_CONFIG_NAME}`);
  const hash = configHash(project.raw);
  const done = (status) => {
    if (flags.json) console.log(JSON.stringify({ name, status, sha: hash }));
    else console.log(status === 'already' ? `==> ${PROJECT_CONFIG_NAME} is already approved.` : '==> Configuration approved.');
  };
  if (cfg.configApproved === hash) return done('already');
  if (flags.sha) {
    // The content the user reviewed, and nothing else: the file is
    // agent-writable and may have changed since.
    if (flags.sha !== hash) die(`${project.file} changed since it was reviewed — review it again`);
    markApproved(cfg, project, sandboxDir(name), saveSandbox);
    return done('approved');
  }
  if (!IS_TTY) die('not a terminal: pass --sha <sha256 of the content you reviewed>');
  await approveProjectConfig(cfg, project, sandboxDir(name), saveSandbox);
}
