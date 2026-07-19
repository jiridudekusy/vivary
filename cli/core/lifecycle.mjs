// Sandbox lifecycle commands: start/up/down/shell/ls/rm/create.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IMAGE, IS_TTY, SANDBOXES_DIR, ask, capture, die, parseArgs, runInherit, sanitizeName } from './util.mjs';
import { containerName, isRunning, runningSet, termEnvArgs } from './runtime.mjs';
import { applyStickyFlags, createSandbox, ensureSandbox, listSandboxNames, loadSandbox, sandboxDir } from './sandbox.mjs';
import { agentRegistry, getPlugins, pluginFlagSpec } from './plugins.mjs';
import { brokerEnvArgs } from './broker.mjs';

const CORE_FLAGS = {
  name: 'string', workspace: 'string', agent: 'string', runtime: 'string',
  memory: 'string', cpus: 'string',
};

function flagSpec() {
  return { ...CORE_FLAGS, ...pluginFlagSpec() };
}

function makeCtx(cfg, flags, mode) {
  return {
    cfg,
    flags,
    mode, // 'start' | 'up' | 'shell'
    dir: sandboxDir(cfg.name),
    runtime: cfg.runtime,
    cname: containerName(cfg.name),
    HOME,
    log: (msg) => console.log(msg),
  };
}

// Core mounts + plugin runArgs.
async function runArgs(ctx) {
  const { cfg, flags, dir } = ctx;
  const args = [
    '--name', ctx.cname,
    '--memory', flags.memory || process.env.SANDBOX_MEMORY || '4g',
    '--cpus', flags.cpus || process.env.SANDBOX_CPUS || '4',
    '-v', `${path.join(dir, 'dot-config')}:/home/agent/.config`,
    '-v', `${cfg.workspace}:${cfg.workspace}`,
    '-e', `SBX_SANDBOX_NAME=${cfg.name}`,
    '-w', cfg.workspace,
  ];
  if (cfg.runtime === 'docker') args.push('--init');
  for (const p of getPlugins()) {
    if (p.runArgs) args.push(...(await p.runArgs(ctx) || []));
  }
  args.push(...(await brokerEnvArgs(cfg)));
  // Apple `container` strips capabilities by default; plugins that need them
  // (dockerd: NET_ADMIN etc., bind-modules: SYS_ADMIN) declare needsCaps.
  // The sandbox is its own VM, so this stays contained.
  if (cfg.runtime !== 'docker' && getPlugins().some((p) => p.needsCaps?.(cfg))) {
    args.push('--cap-add', 'ALL');
  }
  return args;
}

async function prepare(argv, opts = {}) {
  const { flags, positionals, rest } = parseArgs(argv, flagSpec(), opts);
  const cfg = await ensureSandbox(flags.name || positionals[0], {
    ...flags, agent: opts.forcedAgent || flags.agent,
  });
  applyStickyFlags(cfg, flags);
  return { cfg, flags, rest };
}

export async function cmdStart(argv, forcedAgent) {
  const { cfg, flags, rest } = await prepare(argv, { unknownToRest: true, forcedAgent });
  const { agents } = agentRegistry();
  const agentName = forcedAgent || flags.agent || cfg.agent || 'claude';
  const agent = agents[agentName]
    || die(`unknown agent '${agentName}' (available: ${Object.keys(agents).join(', ')})`);
  const ctx = makeCtx(cfg, flags, 'start');

  if (isRunning(cfg.runtime, cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    process.exit(runInherit(cfg.runtime, [
      'exec', ...(IS_TTY ? ['-it'] : []), ...termEnvArgs(),
      ...(await brokerEnvArgs(cfg)), ctx.cname, agent.cmd, ...rest,
    ]));
  }

  console.log(`==> Runtime: ${cfg.runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);
  const args = ['run', '--rm', ...(IS_TTY ? ['-it'] : []),
    ...(await runArgs(ctx)), ...termEnvArgs()];
  args.push(IMAGE, agent.cmd, ...rest);
  process.exit(runInherit(cfg.runtime, args));
}

export async function cmdShell(argv) {
  const { cfg, flags } = await prepare(argv);
  const ctx = makeCtx(cfg, flags, 'shell');

  if (isRunning(cfg.runtime, cfg.name)) {
    process.exit(runInherit(cfg.runtime, [
      'exec', ...(IS_TTY ? ['-it'] : []), ...termEnvArgs(),
      ...(await brokerEnvArgs(cfg)), ctx.cname, 'bash',
    ]));
  }

  console.log(`==> Runtime: ${cfg.runtime} | shell | workspace: ${cfg.workspace}`);
  const args = ['run', '--rm', ...(IS_TTY ? ['-it'] : []),
    ...(await runArgs(ctx)), ...termEnvArgs()];
  process.exit(runInherit(cfg.runtime, [...args, IMAGE, 'bash']));
}

export async function cmdUp(argv) {
  const { cfg, flags } = await prepare(argv);
  const ctx = makeCtx(cfg, flags, 'up');

  if (isRunning(cfg.runtime, cfg.name)) {
    die(`'${ctx.cname}' is already running (stop it with: vivary down ${cfg.name})`);
  }

  for (const p of getPlugins()) {
    if (p.preUp) await p.preUp(ctx);
  }

  const args = ['run', '-d', '--rm', ...(await runArgs(ctx))];
  for (const p of getPlugins()) {
    if (p.upArgs) args.push(...(await p.upArgs(ctx) || []));
  }

  args.push(IMAGE, 'sleep', 'infinity');
  const r = capture(cfg.runtime, args);
  if (r.status !== 0) die(`${cfg.runtime} run failed: ${r.stderr || r.stdout}`);

  console.log(`==> Sandbox '${cfg.name}' is up (runtime: ${cfg.runtime})`);
  for (const p of getPlugins()) {
    if (p.postUp) await p.postUp(ctx);
  }
  console.log(`    Stop with: vivary down ${cfg.name}`);
}

export function cmdDown(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  if (!isRunning(cfg.runtime, name)) {
    console.log(`Sandbox '${name}' is not running.`);
    return;
  }
  capture(cfg.runtime, ['stop', containerName(name)]);
  console.log(`==> Sandbox '${name}' stopped (state and chats are preserved).`);
}

export function cmdList() {
  const names = listSandboxNames();
  if (!names.length) {
    console.log(`No sandboxes in ${SANDBOXES_DIR}`);
    return;
  }
  const running = { docker: runningSet('docker'), container: runningSet('container') };
  const rows = [['NAME', 'AGENT', 'RUNTIME', 'STATUS', 'WORKSPACE']];
  for (const name of names.sort()) {
    const cfg = loadSandbox(name);
    if (!cfg) continue;
    const status = running[cfg.runtime]?.has(containerName(name)) ? 'running' : 'stopped';
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
  const cname = containerName(name);
  if (isRunning(cfg.runtime, name)) capture(cfg.runtime, ['stop', cname]);
  capture(cfg.runtime, ['rm', cname]);
  console.log(`==> Container removed. Chat history remains in ${path.join(HOME, '.claude/projects')}.`);
  if (flags.purge) {
    // Explicit --purge in a non-interactive context counts as confirmation.
    const answer = IS_TTY
      ? (await ask(`Really delete sandbox state ${sandboxDir(name)} (credentials, settings, skills)? [y/N]: `)).trim()
      : 'y';
    if (/^y/i.test(answer)) {
      fs.rmSync(sandboxDir(name), { recursive: true, force: true });
      for (const p of getPlugins()) {
        if (p.onPurge) p.onPurge(name);
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
