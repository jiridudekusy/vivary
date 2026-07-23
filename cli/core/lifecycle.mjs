// Sandbox lifecycle commands: start/up/down/shell/ls/rm/create.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IMAGE, IS_TTY, SANDBOXES_DIR, ask, die, parseArgs, sanitizeName } from './util.mjs';
import { termEnvArgs, termEnvVars } from './runtime.mjs';
import { resolveRuntime, runtimeKind } from './runtimes/index.mjs';
import { buildRunSpec } from './runtimes/spec.mjs';
import {
  applyStickyFlags, createSandbox, ensureSandbox, listSandboxNames, loadSandbox,
  overlayConfigFlags, resolveName, sandboxDir, saveSandbox,
} from './sandbox.mjs';
import { agentRegistry, getPlugins, pluginFlagDefs, pluginFlagSpec } from './plugins.mjs';
import {
  PROJECT_CONFIG_NAME, approveProjectConfig, loadGlobalConfig, loadProjectConfig,
  markApproved, resolveEffectiveConfig, writeBackCliFlags,
} from './config.mjs';
import { brokerEnvArgs, brokerEnvVars } from './broker.mjs';

const CORE_FLAGS = {
  name: 'string', workspace: 'string', agent: 'string', runtime: 'string',
  memory: 'string', cpus: 'string',
};

function flagSpec() {
  return { ...CORE_FLAGS, ...pluginFlagSpec() };
}

function makeCtx(cfg, flags, mode, rt) {
  return {
    cfg,
    flags,
    mode, // 'start' | 'up' | 'shell'
    dir: sandboxDir(cfg.name),
    runtime: cfg.runtime,
    cname: rt.instanceName(cfg.name),
    HOME,
    log: (msg) => console.log(msg),
  };
}

// vm-tart plugins contribute extra `tart run` flags (e.g. clipboard's
// --no-clipboard). No-op for container runtimes.
async function vmRunArgs(ctx) {
  if (runtimeKind(ctx.cfg.runtime) !== 'vm-tart') return [];
  const parts = await Promise.all(getPlugins().map((p) => p.vmRunArgs?.(ctx) || []));
  return parts.flat();
}

// Sticky plugin flag names (the only flags that belong in .vivary.json).
function stickyFlagNames() {
  return Object.entries(pluginFlagDefs())
    .filter(([, def]) => def.sticky).map(([flag]) => flag);
}

async function prepare(argv, opts = {}) {
  const { flags: cliFlags, positionals, rest } = parseArgs(argv, flagSpec(), opts);
  const workspace = path.resolve(cliFlags.workspace || process.cwd());

  // Config files: project .vivary.json wins entirely over the global
  // defaults (~/.vivary/vivary.json) — the two never merge. Loading dies
  // loudly on invalid JSON / unknown keys.
  const knownFlags = pluginFlagSpec();
  const project = loadProjectConfig(workspace, knownFlags);
  const globalCfg = project ? null : loadGlobalConfig(knownFlags);
  const effective = resolveEffectiveConfig({
    cliFlags, project: project?.config, global: globalCfg?.config,
  });

  // The sandbox is created from CLI flags only; file-driven values are
  // applied AFTER the approval gate, so nothing from an unapproved (agent-
  // writable) file is ever persisted or acted upon.
  const cfg = await ensureSandbox(cliFlags.name || positionals[0], {
    ...cliFlags, agent: opts.forcedAgent || cliFlags.agent,
  });
  const dir = sandboxDir(cfg.name);
  if (project) await approveProjectConfig(cfg, project, dir, saveSandbox);

  applyStickyFlags(cfg, cliFlags); // CLI flags stay sticky, as before
  writeBackCliFlags(cfg, project, cliFlags, stickyFlagNames(), dir, saveSandbox);

  // File values override sticky sandbox.json values for this invocation
  // (in-memory; effective.flags already has CLI flags overlaid on top).
  overlayConfigFlags(cfg, effective.flags);
  if (effective.runtime && effective.runtime !== cfg.runtime) {
    cfg.runtime = effective.runtime;
  }
  // Egress policy (presets/allow) rides along for the egress plugin —
  // non-enumerable so no saveSandbox() call can leak it into sandbox.json.
  Object.defineProperty(cfg, 'egressPolicy', {
    value: effective.egress, enumerable: false, configurable: true,
  });

  // Backfill file-provided scalars where no CLI flag was given (buildRunSpec
  // reads memory/cpus from flags; cmdStart reads the agent).
  const flags = { ...cliFlags };
  for (const key of ['agent', 'memory', 'cpus']) {
    if (flags[key] === undefined && effective[key] !== undefined) flags[key] = effective[key];
  }
  return { cfg, flags, rest };
}

export async function cmdStart(argv, forcedAgent) {
  const { cfg, flags, rest } = await prepare(argv, { unknownToRest: true, forcedAgent });
  const { agents } = agentRegistry();
  const agentName = forcedAgent || flags.agent || cfg.agent || 'claude';
  const agent = agents[agentName]
    || die(`unknown agent '${agentName}' (available: ${Object.keys(agents).join(', ')})`);
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'start', rt);
  if (rt.isRunning(cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    const vm = runtimeKind(cfg.runtime) === 'vm-tart';
    // vm-tart: no broker env in Phase 2 (host integration lands later),
    // mirroring the buildRunSpec gate on the fresh-start path.
    process.exit(rt.exec(ctx.cname, [agent.cmd, ...rest], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(vm ? {} : await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    }));
  }
  console.log(`==> Runtime: ${cfg.runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [agent.cmd, ...rest], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  spec.tartRunArgs = await vmRunArgs(ctx);
  process.exit(rt.run(spec));
}

export async function cmdShell(argv) {
  const { cfg, flags } = await prepare(argv);
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'shell', rt);
  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  // vm-tart: guest shell is zsh (macOS native); containers use bash.
  if (rt.isRunning(cfg.name)) {
    // vm-tart: no broker env in Phase 2 (host integration lands later),
    // mirroring the buildRunSpec gate on the fresh-start path.
    process.exit(rt.exec(ctx.cname, [vm ? 'zsh' : 'bash'], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(vm ? {} : await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    }));
  }

  console.log(`==> Runtime: ${cfg.runtime} | shell | workspace: ${cfg.workspace}`);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [vm ? 'zsh' : 'bash'], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  spec.tartRunArgs = await vmRunArgs(ctx);
  process.exit(rt.run(spec));
}

export async function cmdUp(argv) {
  const { cfg, flags } = await prepare(argv);
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'up', rt);
  if (rt.isRunning(cfg.name)) {
    die(`'${ctx.cname}' is already running (stop it with: vivary down ${cfg.name})`);
  }

  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  // vm-tart: no plugin hooks in Phase 2 (hooks assume a Linux container).
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.preUp) await p.preUp(ctx);
    }
  }

  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: IMAGE, command: ['sleep', 'infinity'],
  });
  spec.image = rt.ensureImage(spec);
  spec.tartRunArgs = await vmRunArgs(ctx);
  // Legacy appended --cap-add ALL before upArgs; here upArgs land in extraArgs and
  // cap-add renders after them. Inert: run flags are position-independent for
  // docker and Apple container, and no upArgs plugin emits caps.
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.upArgs) spec.extraArgs.push(...(await p.upArgs(ctx) || []));
    }
  }

  const r = rt.run(spec, { detached: true });
  if (r.status !== 0) die(`${cfg.runtime} run failed: ${r.stderr || r.stdout}`);

  console.log(`==> Sandbox '${cfg.name}' is up (runtime: ${cfg.runtime})`);
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.postUp) await p.postUp(ctx);
    }
  }
  if (vm) {
    for (const p of getPlugins()) {
      if (p.vmPostUp) await p.vmPostUp(ctx);
    }
  }
  console.log(`    Stop with: vivary down ${cfg.name}`);
}

export function cmdDown(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  const rt = resolveRuntime(cfg.runtime);
  if (!rt.isRunning(name)) {
    console.log(`Sandbox '${name}' is not running.`);
    return;
  }
  rt.stop(rt.instanceName(name));
  console.log(`==> Sandbox '${name}' stopped (state and chats are preserved).`);
}

export function cmdList() {
  const names = listSandboxNames();
  if (!names.length) {
    console.log(`No sandboxes in ${SANDBOXES_DIR}`);
    return;
  }
  const running = {
    docker: resolveRuntime('docker').runningSet(),
    container: resolveRuntime('container').runningSet(),
    tart: resolveRuntime('tart').runningSet(),
  };
  const rows = [['NAME', 'AGENT', 'RUNTIME', 'STATUS', 'WORKSPACE']];
  for (const name of names.sort()) {
    const cfg = loadSandbox(name);
    if (!cfg) continue;
    const rt = running[cfg.runtime] ? resolveRuntime(cfg.runtime) : null;
    const status = rt && running[cfg.runtime].has(rt.instanceName(name)) ? 'running' : 'stopped';
    rows.push([name, cfg.agent || 'claude', cfg.runtime || '?', status, cfg.workspace || '?']);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const row of rows) {
    console.log(row.map((cell, c) => String(cell).padEnd(widths[c] + 2)).join('').trimEnd());
  }
}

export async function cmdRm(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string', purge: 'boolean' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  const rt = resolveRuntime(cfg.runtime);
  const cname = rt.instanceName(name);
  if (rt.isRunning(name)) rt.stop(cname);
  if (rt.kind === 'vm-tart') {
    console.log(`==> macOS VM '${cname}' kept — its disk holds the sandbox state (logins, chats).`);
  } else {
    rt.rm(cname);
    console.log(`==> Container removed. Chat history remains in ${path.join(HOME, '.claude/projects')}.`);
  }
  if (flags.purge) {
    // Explicit --purge in a non-interactive context counts as confirmation.
    const answer = IS_TTY
      ? (await ask(`Really delete sandbox state ${sandboxDir(name)} (credentials, settings, skills)? [y/N]: `)).trim()
      : 'y';
    if (/^y/i.test(answer)) {
      if (rt.purge) {
        rt.purge(cname);
        console.log(`==> macOS VM '${cname}' deleted.`);
      }
      fs.rmSync(sandboxDir(name), { recursive: true, force: true });
      for (const p of getPlugins()) {
        if (p.onPurge) await p.onPurge(name);
      }
      console.log('==> Sandbox state purged.');
    }
  } else {
    console.log(`    Sandbox state kept in ${sandboxDir(name)} (use 'vivary rm ${name} --purge' to delete).`);
  }
}

export async function cmdCreate(argv) {
  const { flags, positionals } = parseArgs(argv, flagSpec());
  const workspace = path.resolve(flags.workspace || positionals[1] || process.cwd());
  const name = flags.name || positionals[0] || sanitizeName(path.basename(workspace));
  await createSandbox(name, workspace, { ...flags, interactive: true });
  console.log(`    Start it:  vivary start ${name}`);
}

// `vivary init` — generate <workspace>/.vivary.json from the sandbox's
// current effective config (creating the sandbox with defaults when none
// exists yet) and mark it approved. The intended creation path for the file.
export async function cmdInit(argv) {
  const { flags, positionals } = parseArgs(argv, flagSpec());
  const workspace = path.resolve(flags.workspace || process.cwd());
  const file = path.join(workspace, PROJECT_CONFIG_NAME);
  if (fs.existsSync(file)) {
    die(`${file} already exists — edit it directly; the change is reviewed on the next start`);
  }
  const name = resolveName(flags.name || positionals[0], workspace);
  let cfg = loadSandbox(name);
  if (!cfg) cfg = await createSandbox(name, workspace, { ...flags, interactive: false });
  applyStickyFlags(cfg, flags); // CLI flags of this invocation count too

  const fileFlags = {};
  for (const [flag, def] of Object.entries(pluginFlagDefs())) {
    if (!def.sticky) continue;
    const v = cfg[def.cfgKey || flag];
    if (v) fileFlags[flag] = v; // only enabled features — the file stays minimal
  }
  const project = {
    agent: flags.agent || cfg.agent || 'claude',
    runtime: flags.runtime || cfg.runtime,
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    flags: fileFlags,
    ...(fileFlags.egress ? { egress: { presets: [], allow: [] } } : {}),
  };
  const raw = JSON.stringify(project, null, 2) + '\n';
  fs.writeFileSync(file, raw);
  markApproved(cfg, { file, raw, config: project }, sandboxDir(name), saveSandbox);
  console.log(`==> Wrote ${file} (approved for sandbox '${name}').`);
}
