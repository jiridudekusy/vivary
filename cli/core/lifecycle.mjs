// Sandbox lifecycle commands: start/up/down/shell/ls/rm/create.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IMAGE, IS_TTY, SANDBOXES_DIR, ask, die, parseArgs, sanitizeName } from './util.mjs';
import { termEnvArgs, termEnvVars } from './runtime.mjs';
import { resolveRuntime, runtimeKind, runtimesRunning } from './runtimes/index.mjs';
import { buildRunSpec, sandboxMemory } from './runtimes/spec.mjs';
import {
  DEFAULT_MEMORY_BUDGET, checkMemoryBudget, formatBudgetRefusal, formatBytes, hostSnapshot,
  openFilesWarning, parseBudget, requestedMemoryBytes, runningVmMemory,
} from './host.mjs';
import {
  applyStickyFlags, containerConfigSnapshot, createSandbox, diffContainerConfig,
  ensureSandbox, formatConfigChanges, listSandboxNames, loadSandbox,
  overlayConfigFlags, resolveName, sandboxDir, saveSandbox,
} from './sandbox.mjs';
import { agentRegistry, getPlugins, pluginFlagDefs, pluginFlagSpec } from './plugins.mjs';
import {
  PROJECT_CONFIG_NAME, approveProjectConfig, loadGlobalConfig, loadMemoryBudget, loadProjectConfig,
  markApproved, resolveEffectiveConfig, writeBackCliFlags,
} from './config.mjs';
import { brokerEnvArgs, brokerEnvVars } from './broker.mjs';

const CORE_FLAGS = {
  name: 'string', workspace: 'string', agent: 'string', runtime: 'string',
  memory: 'string', cpus: 'string',
  // Containers PERSIST by default: whatever the agent installed inside (apt
  // packages, kind, kubectl, docker images on Apple `container`) survives a
  // down/up instead of being thrown away with --rm. --ephemeral restores the
  // old throwaway behaviour; --recreate rebuilds a kept container once.
  ephemeral: 'optional', recreate: 'boolean',
  // One-off, never sticky: a standing exemption would defeat the budget.
  'ignore-memory-budget': 'boolean',
};

function flagSpec() {
  return { ...CORE_FLAGS, ...pluginFlagSpec() };
}

// Precedence for the scalars buildRunSpec/cmdStart read:
//   CLI > project .vivary.json > sticky sandbox.json > global defaults > built-in
//
// The sticky tier sits ABOVE the global defaults, unlike plugin flags where the
// file always wins. `~/.vivary/vivary.json` is a fallback for sandboxes that
// said nothing; it has no business resizing one that was explicitly given
// `--memory 20g`. A project .vivary.json still wins — committed, deliberate,
// per-project intent. `agent` skips the sticky tier: it is resolved from
// sandbox.json by cmdStart already.
export function resolveScalars(cliFlags = {}, projectConfig, cfg = {}, effective = {}) {
  const flags = { ...cliFlags };
  for (const key of ['agent', 'memory', 'cpus']) {
    if (flags[key] !== undefined) continue;
    if (projectConfig?.[key] !== undefined) flags[key] = projectConfig[key];
    else if (key !== 'agent' && cfg[key] !== undefined) flags[key] = cfg[key];
    else if (effective[key] !== undefined) flags[key] = effective[key];
  }
  return flags;
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

  // --ephemeral is a CORE flag, so applyStickyFlags (which walks plugin flags)
  // does not see it — persist it here. Accepts off/0 so it can be turned back.
  if (cliFlags.ephemeral !== undefined) {
    const v = cliFlags.ephemeral;
    const next = !(v === 'off' || v === '0' || v === false);
    if (cfg.ephemeral !== next) {
      cfg.ephemeral = next;
      saveSandbox(cfg);
    }
  }

  // memory/cpus are STICKY, like the plugin flags. They size the machine, so
  // `--memory 20g` once must keep meaning 20g: without this the next flagless
  // `up` silently fell back to the 4g default — and, since the persistent
  // container's config snapshot records the size, that showed up as `up`
  // REFUSING to start ("memory: 20g -> 4g") rather than as a quiet downgrade.
  // applyStickyFlags only walks plugin flags, so these are persisted here.
  for (const key of ['memory', 'cpus']) {
    if (cliFlags[key] !== undefined && cfg[key] !== cliFlags[key]) {
      cfg[key] = cliFlags[key];
      saveSandbox(cfg);
    }
  }

  // Backfill scalars where no CLI flag was given (buildRunSpec reads
  // memory/cpus from flags; cmdStart reads the agent).
  //
  // For memory/cpus the sticky value outranks the GLOBAL default, unlike plugin
  // flags where the file always wins. `~/.vivary/vivary.json` is a fallback for
  // sandboxes that said nothing — it has no business resizing a sandbox that
  // was explicitly given `--memory 20g`. A PROJECT .vivary.json still wins:
  // that is committed, deliberate, per-project intent.
  // Net order: CLI > project file > sticky sandbox.json > global > built-in.
  const flags = resolveScalars(cliFlags, project?.config, cfg, effective);
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
  // Persistent (default): the container is always `sleep infinity` and the agent
  // runs via exec, so one container shape serves up/start/shell. Interactive
  // commands put it back to sleep on exit — an `up` sandbox is left running,
  // because `up` is the explicit "keep it running" request.
  if (!vm && !cfg.ephemeral) {
    const { started } = await ensureUpContainer(ctx, rt, { recreate: !!flags.recreate });
    const code = rt.exec(ctx.cname, [agent.cmd, ...rest], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    });
    if (started && !cfg.desiredRunning) {
      rt.stop(ctx.cname);
      console.log(`==> Sandbox '${cfg.name}' stopped (container kept — installed state preserved).`);
    }
    process.exit(code);
  }
  enforceHostLimits(ctx);
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
  if (!vm && !cfg.ephemeral) {
    const { started } = await ensureUpContainer(ctx, rt, { recreate: !!flags.recreate });
    const code = rt.exec(ctx.cname, ['bash'], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    });
    if (started && !cfg.desiredRunning) {
      rt.stop(ctx.cname);
      console.log(`==> Sandbox '${cfg.name}' stopped (container kept — installed state preserved).`);
    }
    process.exit(code);
  }
  enforceHostLimits(ctx);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [vm ? 'zsh' : 'bash'], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  applyVmContribute(spec, contrib);
  await vmBootAndPostUp(rt, spec, ctx);
  process.exit(rt.run(spec));
}

// Host limits, checked before ANY sandbox VM boots — `up`, `resume`, and
// `start`/`shell` when they have to start one. Memory is enforced; open files
// are only warned about (see openFilesWarning).
//
// The budget sums CONFIGURED sizes, not RSS: a Linux guest fills its RAM with
// page cache and Virtualization.framework does not take it back, so the
// configured size is where every VM ends up. Several sandboxes that each looked
// small at boot are how the Mac got taken down.
//
// Throws rather than die()s, so `resume` reports a sandbox that does not fit and
// goes on to the next one — a smaller one may still fit.
export function enforceHostLimits(ctx) {
  if (process.platform !== 'darwin') return;
  const { cfg, flags } = ctx;
  const host = hostSnapshot();
  const warning = openFilesWarning(host.files);
  if (warning) console.error(`==> ${warning}`);
  // docker sandboxes live inside Docker Desktop's fixed-size VM (counted for
  // the others' sake by runningVmMemory): starting one adds no VM of its own.
  if (cfg.runtime === 'docker') return;
  const setting = loadMemoryBudget(pluginFlagDefs()) ?? DEFAULT_MEMORY_BUDGET;
  const budget = parseBudget(setting, host.memBytes);
  const requestBytes = requestedMemoryBytes(sandboxMemory(flags), cfg.runtime);
  const committed = runningVmMemory();
  const { ok, total } = checkMemoryBudget({ budgetBytes: budget.bytes, committed, requestBytes });
  if (ok) return;
  if (flags['ignore-memory-budget']) {
    console.error(`==> WARNING: VMs will be configured for ${formatBytes(total)}, over the `
      + `${formatBytes(budget.bytes)} budget (${budget.label}) — starting anyway (--ignore-memory-budget)`);
    return;
  }
  throw new Error(formatBudgetRefusal({
    name: cfg.name, runtime: cfg.runtime, mode: ctx.mode,
    requestBytes, committed, budget, total, setting,
  }));
}

// Bring a PERSISTENT container into the running state, creating it only if it
// is not there yet. Returns { started } — true when this call is what started
// it, which is how `start`/`shell` know to put it back to sleep afterwards
// (an `up` sandbox must keep running; see cmdUp).
//
// `spec` is built by the caller even on the restart path: buildRunSpec is where
// plugins do their host-side prep as a side effect (egress ensures ASHP and
// re-syncs the rules, npmrc re-derives its import, egress copies the CA), and
// a restart needs all of that just as much as a fresh run. Only the rendered
// argv is discarded.
async function ensurePersistentContainer(rt, ctx, spec, { recreate = false } = {}) {
  const { cfg, flags } = ctx;
  const snapshot = containerConfigSnapshot(cfg, flags);

  if (rt.exists(cfg.name)) {
    if (recreate) {
      console.log(`==> --recreate: discarding the kept container '${ctx.cname}'`);
      rt.rm(ctx.cname);
    } else {
      const changes = diffContainerConfig(cfg.containerConfig, snapshot);
      if (changes.length) {
        die(`sandbox '${cfg.name}' has a kept container built with different settings:\n`
          + `${formatConfigChanges(changes)}\n`
          + '    A container bakes its env, mounts and caps at creation, so restarting it\n'
          + '    would silently ignore these. Rebuild it with:\n'
          + `      vivary ${ctx.mode} --recreate\n`
          + '    (anything installed INSIDE the container is lost; sandbox state in\n'
          + `     ${sandboxDir(cfg.name)} and the workspace are untouched)`);
      }
      const r = rt.start(ctx.cname);
      if (r.status !== 0) die(`failed to start kept container: ${r.stderr || r.stdout}`);
      console.log(`==> Restarted kept container '${ctx.cname}' (installed state preserved)`);
      return { started: true };
    }
  }

  const r = rt.run(spec, { detached: true });
  if (r.status !== 0) die(`${cfg.runtime} run failed: ${r.stderr || r.stdout}`);
  cfg.containerConfig = snapshot;
  saveSandbox(cfg);
  return { started: true };
}

// `up` leaves a container running for something to attach to LATER — that is
// what separates it from `start`/`shell`, which bring their own session. With
// neither sshd nor a tailnet publish there is nothing to attach with, so the
// sandbox would sit there burning RAM and be reachable only by going back to
// the very Mac that started it. Refuse instead of leaving that to be discovered
// from an iPad.
//
// `ssh` is read through the ssh plugin so a sandbox created before ssh became a
// flag still counts as one (it infers from the existing keypair).
export function requireReachable(cfg, plugins = getPlugins()) {
  if (cfg.tailscale || cfg.ssh) return;
  // Any plugin may provide a way in — ssh infers one from a pre-flag keypair,
  // paseo is one in its own right. Asking all of them beats special-casing one.
  if (plugins.some((p) => p.inferReachable?.(cfg))) return;
  die(`'${cfg.name}' would have no way in: \`up\` runs a container for something to\n`
    + '    attach to later, and neither sshd nor a tailnet publish is enabled.\n'
    + '    Pick at least one (both are sticky, so this is a one-off):\n'
    + `      vivary up --ssh              # ssh / IDE / Claude Desktop from this Mac\n`
    + `      vivary up --tailscale        # also reachable from your iPad, phone, ...\n`
    + `      vivary up --paseo            # drive its agents from the Paseo app\n`
    + '    Or work in it directly without a long-running container: vivary shell');
}

// Create-or-restart the sandbox's long-lived container in the FULL `up` shape,
// then run the postUp hooks.
//
// Every command that materialises a persistent container goes through here, and
// that matters: the ssh plugin contributes SANDBOX_SSH, the ssh state mount and
// the published port from `upArgs`, NOT `runArgs`. A container first created by
// `start`/`shell` without upArgs therefore had no sshd at all — and since env is
// baked at creation, a later `vivary up` just restarted it and SSH never came
// on (tailnet ssh answered "Connection refused"). One shape for all commands is
// what keeps that from happening again.
async function ensureUpContainer(ctx, rt, { recreate = false } = {}) {
  const { cfg } = ctx;
  // Before preUp: a refused start must not leave plugin side effects behind.
  enforceHostLimits(ctx);
  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.preUp) await p.preUp(ctx);
    }
  }
  const spec = await buildRunSpec(ctx, {
    rm: !!cfg.ephemeral, interactive: false, image: IMAGE, command: ['sleep', 'infinity'],
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

  let started = true;
  if (!vm && !cfg.ephemeral) {
    ({ started } = await ensurePersistentContainer(rt, ctx, spec, { recreate }));
  } else {
    const r = rt.run(spec, { detached: true });
    if (r.status !== 0) die(`${cfg.runtime} run failed: ${r.stderr || r.stdout}`);
  }
  for (const p of getPlugins()) {
    if (!vm && p.postUp) await p.postUp(ctx);
    if (vm && p.vmPostUp) await p.vmPostUp(ctx);
  }
  return { started };
}

export async function cmdUp(argv) {
  const { cfg, flags } = await prepare(argv);
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'up', rt);
  if (rt.isRunning(cfg.name)) {
    die(`'${ctx.cname}' is already running (stop it with: vivary down ${cfg.name})`);
  }
  requireReachable(cfg);

  await ensureUpContainer(ctx, rt, { recreate: !!flags.recreate });
  // `up` means "I want this running" — remembered so `vivary resume` can bring
  // exactly these back after a host reboot, and cleared by `down`.
  if (!cfg.desiredRunning) {
    cfg.desiredRunning = true;
    saveSandbox(cfg);
  }
  console.log(`==> Sandbox '${cfg.name}' is up (runtime: ${cfg.runtime})`);
  console.log(`    Stop with: vivary down ${cfg.name}`);
}

export function cmdDown(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  // Stop it wherever it actually runs, not where sandbox.json says (a project
  // .vivary.json can override the runtime for a start — see runtimesRunning).
  // Down is an explicit "stay off" — don't let `resume` bring it back.
  if (cfg.desiredRunning) {
    cfg.desiredRunning = false;
    saveSandbox(cfg);
  }
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

// `vivary resume` — bring back every sandbox that was up when the host went
// down. A Mac reboot stops the runtime without any chance to record intent, so
// the intent is recorded up front instead: `up` sets desiredRunning, `down`
// clears it. Runs the ordinary up path per sandbox, so it works whether the
// kept container survived or has to be created from scratch.
export async function cmdResume(argv = []) {
  const { flags } = parseArgs(argv, { 'dry-run': 'boolean' });
  const wanted = listSandboxNames().sort()
    .map((name) => loadSandbox(name))
    .filter((cfg) => cfg && cfg.desiredRunning);

  if (!wanted.length) {
    console.log('No sandboxes are marked to run (vivary up marks one, vivary down clears it).');
    return;
  }

  const todo = wanted.filter((cfg) => !runtimesRunning(cfg.name).length);
  const already = wanted.length - todo.length;
  if (already) console.log(`==> Already running: ${already}`);
  if (!todo.length) {
    console.log('==> Nothing to resume.');
    return;
  }
  if (flags['dry-run']) {
    console.log(`==> Would resume: ${todo.map((c) => c.name).join(', ')}`);
    return;
  }

  const failed = [];
  for (const cfg of todo) {
    console.log(`\n==> Resuming '${cfg.name}' (${cfg.workspace})`);
    try {
      // Go through the normal up path from the sandbox's own workspace so the
      // project .vivary.json and its approval gate apply exactly as usual.
      await cmdUp(['--name', cfg.name]);
    } catch (e) {
      // One broken sandbox (deleted workspace, unapproved config) must not
      // stop the rest — report at the end instead.
      failed.push({ name: cfg.name, err: e?.message || String(e) });
      console.error(`    FAILED: ${e?.message || e}`);
    }
  }
  if (failed.length) {
    console.error(`\n==> ${failed.length} of ${todo.length} failed to resume: `
      + failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  } else {
    console.log(`\n==> Resumed ${todo.length} sandbox(es).`);
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
  // Host-side pointers at the (now gone) instance — ssh_config alias etc. Runs
  // on EVERY rm, and after onPurge, which may still need to read them.
  for (const p of getPlugins()) {
    if (p.onRemove) await p.onRemove(name);
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
