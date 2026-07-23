import path from 'node:path';
import { getPlugins } from '../plugins.mjs';
import { brokerEnvArgs } from '../broker.mjs';
import { runtimeKind } from './index.mjs';

export async function buildRunSpec(ctx, {
  rm, interactive, image, command = [], termEnv = [],
  plugins = getPlugins(), brokerEnv = brokerEnvArgs,
} = {}) {
  const { cfg, flags, dir } = ctx;
  const runtime = cfg.runtime;
  // vm-tart sandboxes take NO plugin/broker contributions in Phase 2 — the
  // extraArgs escape hatch is docker-shaped, and host integration for macOS
  // guests lands in later phases (plugin migration to structured intent).
  const vm = runtimeKind(runtime) === 'vm-tart';
  const extraArgs = [];
  if (!vm) {
    for (const p of plugins) {
      if (p.runArgs) extraArgs.push(...(await p.runArgs(ctx) || []));
    }
    extraArgs.push(...(await brokerEnv(cfg)));
  }
  return {
    name: ctx.cname,
    image,
    cwd: cfg.workspace,
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    rm, interactive,
    mounts: vm
      ? [{ host: cfg.workspace, guest: cfg.workspace }]
      : [
          { host: path.join(dir, 'dot-config'), guest: '/home/agent/.config' },
          { host: cfg.workspace, guest: cfg.workspace },
        ],
    env: { SBX_SANDBOX_NAME: cfg.name },
    init: !vm && runtime === 'docker',
    capsAll: !vm && runtime !== 'docker' && plugins.some((p) => p.needsCaps?.(cfg)),
    extraArgs,
    termEnv,
    command,
  };
}
