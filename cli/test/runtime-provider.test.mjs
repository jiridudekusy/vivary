import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderRunArgs } from '../core/runtimes/container-cli.mjs';
import { resolveRuntime } from '../core/runtimes/index.mjs';
import { buildRunSpec } from '../core/runtimes/spec.mjs';
import { loadPlugins } from '../core/plugins.mjs';

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

test('resolveRuntime returns a container-cli provider for docker and container', () => {
  for (const n of ['docker', 'container']) {
    const rt = resolveRuntime(n);
    assert.equal(rt.name, n);
    assert.equal(rt.kind, 'container-cli');
    assert.equal(typeof rt.run, 'function');
  }
});

test('provider.runArgv delegates to the renderer', () => {
  const rt = resolveRuntime('docker');
  const argv = rt.runArgv(baseSpec);
  assert.equal(argv[0], 'run');
  assert.ok(argv.includes('--init'));
});

test('buildRunSpec reproduces core mounts, env and cwd', async () => {
  // Load plugins to allow getPlugins() to work
  await loadPlugins();

  // Create a temporary directory for the test
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-test-'));

  try {
    const ctx = {
      cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
      flags: { memory: '4g', cpus: '4' },
      dir: tmpDir,
      cname: 'claude-sandbox-demo',
    };
    const spec = await buildRunSpec(ctx, { rm: true, interactive: false, image: 'img', command: ['bash'] });
    assert.equal(spec.name, 'claude-sandbox-demo');
    assert.equal(spec.cwd, '/w/demo');
    assert.deepEqual(spec.env.SBX_SANDBOX_NAME, 'demo');
    assert.ok(spec.mounts.some((m) => m.guest === '/w/demo' && m.host === '/w/demo'));
    assert.ok(spec.mounts.some((m) => m.guest === '/home/agent/.config'));
    assert.equal(spec.init, true);        // docker
  } finally {
    // Clean up the temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
