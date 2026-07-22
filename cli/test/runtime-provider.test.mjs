import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunArgs } from '../core/runtimes/container-cli.mjs';

const baseSpec = {
  name: 'claude-sandbox-demo',
  image: 'agent-sandbox-agents',
  cwd: '/Users/jdk/work/demo',
  memory: '4g',
  cpus: '4',
  rm: true,
  interactive: true,
  mounts: [
    { host: '/Users/jdk/.vivary/demo/dot-config', guest: '/home/agent/.config' },
    { host: '/Users/jdk/work/demo', guest: '/Users/jdk/work/demo' },
  ],
  env: { SBX_SANDBOX_NAME: 'demo' },
  capsAll: false,
  init: true,
  extraArgs: ['-e', 'SBX_OPEN_URL=http://host.docker.internal:7377/'],
  termEnv: ['-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor'],
  command: ['claude'],
};

test('docker run argv matches the legacy layout', () => {
  const argv = renderRunArgs(baseSpec, { runtime: 'docker' });
  assert.deepEqual(argv, [
    'run', '--rm', '-it',
    '--name', 'claude-sandbox-demo',
    '--memory', '4g',
    '--cpus', '4',
    '-v', '/Users/jdk/.vivary/demo/dot-config:/home/agent/.config',
    '-v', '/Users/jdk/work/demo:/Users/jdk/work/demo',
    '-e', 'SBX_SANDBOX_NAME=demo',
    '-w', '/Users/jdk/work/demo',
    '--init',
    '-e', 'SBX_OPEN_URL=http://host.docker.internal:7377/',
    '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
    'agent-sandbox-agents', 'claude',
  ]);
});

test('container run argv omits --init and adds --cap-add ALL when capsAll', () => {
  const argv = renderRunArgs({ ...baseSpec, init: false, capsAll: true }, { runtime: 'container' });
  assert.ok(!argv.includes('--init'), 'no --init for container');
  const i = argv.indexOf('--cap-add');
  assert.equal(argv[i + 1], 'ALL');
});
