import path from 'node:path';
import { getPlugins } from '../plugins.mjs';
import { brokerEnvArgs } from '../broker.mjs';

export async function buildRunSpec(ctx, {
  rm, interactive, image, command = [], termEnv = [],
  plugins = getPlugins(), brokerEnv = brokerEnvArgs,
} = {}) {
  const { cfg, flags, dir } = ctx;
  const runtime = cfg.runtime;
  const extraArgs = [];
  for (const p of plugins) {
    if (p.runArgs) extraArgs.push(...(await p.runArgs(ctx) || []));
  }
  extraArgs.push(...(await brokerEnv(cfg)));
  return {
    name: ctx.cname,
    image,
    cwd: cfg.workspace,
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    rm, interactive,
    mounts: [
      { host: path.join(dir, 'dot-config'), guest: '/home/agent/.config' },
      { host: cfg.workspace, guest: cfg.workspace },
    ],
    env: { SBX_SANDBOX_NAME: cfg.name },
    init: runtime === 'docker',
    capsAll: runtime !== 'docker' && plugins.some((p) => p.needsCaps?.(cfg)),
    extraArgs,
    termEnv,
    command,
  };
}
