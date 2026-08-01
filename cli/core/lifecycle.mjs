// Sandbox lifecycle commands: start/up/down/shell/ls/rm/create.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IMAGE, IS_TTY, SANDBOXES_DIR, ask, die, parseArgs, sanitizeName } from './util.mjs';
import { termEnvArgs, termEnvVars } from './runtime.mjs';
import { resolveRuntime, runtimeKind, runtimesRunning } from './runtimes/index.mjs';
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

// vm-tart plugins contribute extra `tart run` flags, guest exec env, and
// virtiofs mounts via `vmContribute(ctx) -> {runArgs?, env?, mounts?}`. No-op
// for container runtimes. The hook also runs whatever host-side prep the
// contribution needs (egress: ensure ASHP + per-sandbox agent + policy + CA),
// and is idempotent so it's safe on both the fresh-start and attach paths.
// env values may contain the literal __GATEWAY__ — the tart provider resolves
// it to the guest's default gateway once the VM is up.
async function vmContribute(ctx) {
  const merged = { runArgs: [], env: {}, mounts: [] };
  if (runtimeKind(ctx.cfg.runtime) !== 'vm-tart') return merged;
  for (const p of getPlugins()) {
    if (!p.vmContribute) continue;
    const c = (await p.vmContribute(ctx)) || {};
    merged.runArgs.push(...(c.runArgs || []));
    Object.assign(merged.env, c.env || {});
    merged.mounts.push(...(c.mounts || []));
  }
  return merged;
}

// vm-tart: `up` runs the vmPostUp hooks (host-open shim, ssh registration,
// published-port info) after boot. A cold `start`/`shell` boots the very same
// VM, so it needs them too — without this, `open` in a guest started that way
// silently falls back to the guest's own /usr/bin/open. Idempotent, and a no-op
// on container runtimes (no ensureUp).
async function vmBootAndPostUp(rt, spec, ctx) {
  if (runtimeKind(ctx.cfg.runtime) !== 'vm-tart' || !rt.ensureUp) return;
  rt.ensureUp(spec);
  for (const p of getPlugins()) {
    if (p.vmPostUp) await p.vmPostUp(ctx);
  }
}

// Fold a vmContribute result into a RunSpec (no-op shape for containers).
function applyVmContribute(spec, c) {
  spec.tartRunArgs = c.runArgs;
  spec.env = { ...spec.env, ...c.env };
  spec.mounts = [...spec.mounts, ...c.mounts];
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
  // Full defs (not just types): the validator needs `list` to know which flags
  // also accept an array of strings in the file.
  const knownFlags = pluginFlagDefs();
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
  overlayConfigFlags(cfg, effective.flags, cliFlags);
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
  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  // vm-tart host integration (clipboard/egress/host-open) rides vmContribute;
  // containers use -e broker env. Gather once for both the attach & fresh paths.
  const contrib = await vmContribute(ctx);
  if (rt.isRunning(cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    process.exit(rt.exec(ctx.cname, [agent.cmd, ...rest], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(vm ? contrib.env : await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    }));
  }
  console.log(`==> Runtime: ${cfg.runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [agent.cmd, ...rest], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  applyVmContribute(spec, contrib);
  await vmBootAndPostUp(rt, spec, ctx);
  process.exit(rt.run(spec));
}

export async function cmdShell(argv) {
  const { cfg, flags } = await prepare(argv);
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'shell', rt);
  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  // vm-tart: guest shell is zsh (macOS native); containers use bash.
  const contrib = await vmContribute(ctx);
  if (rt.isRunning(cfg.name)) {
    process.exit(rt.exec(ctx.cname, [vm ? 'zsh' : 'bash'], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(vm ? contrib.env : await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    }));
  }

  console.log(`==> Runtime: ${cfg.runtime} | shell | workspace: ${cfg.workspace}`);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [vm ? 'zsh' : 'bash'], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  applyVmContribute(spec, contrib);
  await vmBootAndPostUp(rt, spec, ctx);
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
  applyVmContribute(spec, await vmContribute(ctx));
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
  // Stop it wherever it actually runs, not where sandbox.json says (a project
  // .vivary.json can override the runtime for a start — see runtimesRunning).
  const running = runtimesRunning(name);
  if (!running.length) {
    console.log(`Sandbox '${name}' is not running.`);
    return;
  }
  for (const rtName of running) {
    const rt = resolveRuntime(rtName);
    rt.stop(rt.instanceName(name));
    const where = rtName === cfg.runtime ? '' : ` (runtime: ${rtName}, sandbox.json says ${cfg.runtime})`;
    console.log(`==> Sandbox '${name}' stopped${where} (state and chats are preserved).`);
  }
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
    // Look in every runtime, not only the recorded one: a .vivary.json runtime
    // override starts the sandbox elsewhere, which used to read as 'stopped'.
    const holders = Object.keys(running)
      .filter((n) => running[n].has(resolveRuntime(n).instanceName(name)));
    const elsewhere = holders.filter((n) => n !== cfg.runtime);
    const runtimeCell = elsewhere.length
      ? `${cfg.runtime || '?'} (as ${elsewhere.join(', ')})`
      : cfg.runtime || '?';
    rows.push([name, cfg.agent || 'claude', runtimeCell,
      holders.length ? 'running' : 'stopped', cfg.workspace || '?']);
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
  // Sweep every runtime the sandbox is actually in, not just the recorded one:
  // a .vivary.json runtime override starts it elsewhere, and removing only the
  // recorded runtime left that container running (state purged, container up).
  const targets = [...new Set([cfg.runtime, ...runtimesRunning(name)])];
  const vmTargets = targets.filter((n) => runtimeKind(n) === 'vm-tart');
  const stray = targets.filter((n) => n !== cfg.runtime);
  for (const rtName of targets) {
    const rt = resolveRuntime(rtName);
    const cname = rt.instanceName(name);
    if (rt.isRunning(name)) rt.stop(cname);
    if (rt.kind !== 'vm-tart') rt.rm(cname); // silent when there is nothing there
  }
  if (stray.length) {
    console.log(`==> Also found under runtime(s) ${stray.join(', ')} — removed there too.`);
  }
  if (targets.some((n) => runtimeKind(n) !== 'vm-tart')) {
    console.log(`==> Container removed. Chat history remains in ${path.join(HOME, '.claude/projects')}.`);
  }
  for (const rtName of vmTargets) {
    console.log(`==> macOS VM '${resolveRuntime(rtName).instanceName(name)}' kept — `
      + 'its disk holds the sandbox state (logins, chats).');
  }
  if (flags.purge) {
    // Explicit --purge in a non-interactive context counts as confirmation.
    const answer = IS_TTY
      ? (await ask(`Really delete sandbox state ${sandboxDir(name)} (credentials, settings, skills)? [y/N]: `)).trim()
      : 'y';
    if (/^y/i.test(answer)) {
      for (const rtName of vmTargets) {
        const rt = resolveRuntime(rtName);
        const cname = rt.instanceName(name);
        if (rt.purge?.(cname).status === 0) console.log(`==> macOS VM '${cname}' deleted.`);
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
  const { flags: cliFlags, positionals } = parseArgs(argv, flagSpec());
  const workspace = path.resolve(cliFlags.workspace || positionals[1] || process.cwd());
  const name = cliFlags.name || positionals[0] || sanitizeName(path.basename(workspace));

  // Seed the new sandbox from the global defaults (~/.vivary/vivary.json), so
  // `create` matches what start/up would use and the onCreate wizards see the
  // real flags. That file is host-owned (never mounted, not agent-writable),
  // hence no approval gate. A project .vivary.json wins over the global file
  // entirely — but it IS agent-writable, so it must pass the approval gate,
  // which needs the sandbox to exist; it is therefore applied on first start.
  const knownFlags = pluginFlagDefs();
  const project = loadProjectConfig(workspace, knownFlags);
  const globalCfg = project ? null : loadGlobalConfig(knownFlags);
  const opts = { ...cliFlags, interactive: true };
  if (globalCfg) {
    const effective = resolveEffectiveConfig({ cliFlags, global: globalCfg.config });
    for (const [flag, value] of Object.entries(effective.flags)) {
      if (opts[flag] === undefined) opts[flag] = value;
    }
    for (const key of ['agent', 'runtime']) {
      if (opts[key] === undefined && effective[key] !== undefined) opts[key] = effective[key];
    }
    console.log(`==> Defaults from ${globalCfg.file}`);
  }

  await createSandbox(name, workspace, opts);
  if (project) {
    console.log(`    ${PROJECT_CONFIG_NAME} found — applied (after approval) on first start.`);
  }
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
