import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunArgs, renderExecArgs } from '../core/runtimes/container-cli.mjs';
import { resolveRuntime } from '../core/runtimes/index.mjs';
import { buildRunSpec } from '../core/runtimes/spec.mjs';
import clipboardPlugin from '../plugins/clipboard/plugin.mjs';

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

// Full argv order for the Apple `container` layout, derived from the
// pre-refactor `runArgs()` in `git show 04e3085:cli/core/lifecycle.mjs`
// (the legacy source of truth, not the renderer under test): container gets
// NO `--init` (only docker needs it for signal reaping), and `--cap-add ALL`
// is appended after plugin/broker extraArgs and before termEnv — legacy built
// it the same way, since `runArgs()` pushed `--cap-add ALL` only after the
// plugin-runArgs/brokerEnvArgs loop, and callers appended termEnvArgs() last.
test('container run argv matches the legacy layout (full order)', () => {
  const argv = renderRunArgs({ ...baseSpec, init: false, capsAll: true }, { runtime: 'container' });
  assert.deepEqual(argv, [
    'run', '--rm', '-it',
    '--name', 'claude-sandbox-demo',
    '--memory', '4g',
    '--cpus', '4',
    '-v', '/Users/jdk/.vivary/demo/dot-config:/home/agent/.config',
    '-v', '/Users/jdk/work/demo:/Users/jdk/work/demo',
    '-e', 'SBX_SANDBOX_NAME=demo',
    '-w', '/Users/jdk/work/demo',
    // no --init here (container)
    '-e', 'SBX_OPEN_URL=http://host.docker.internal:7377/',
    '--cap-add', 'ALL',
    '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
    'agent-sandbox-agents', 'claude',
  ]);
});

test('a ro mount renders host:guest:ro', () => {
  const argv = renderRunArgs({
    ...baseSpec,
    mounts: [{ host: '/Users/jdk/work/demo', guest: '/workspace', ro: true }],
  }, { runtime: 'docker' });
  assert.ok(argv.includes('-v'));
  assert.ok(argv.includes('/Users/jdk/work/demo:/workspace:ro'));
});

test('capsAll on docker renders no --cap-add (docker guard)', () => {
  const argv = renderRunArgs({ ...baseSpec, capsAll: true }, { runtime: 'docker' });
  assert.ok(!argv.includes('--cap-add'), 'docker must never get --cap-add');
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

// Fake plugins + fake brokerEnv keep this test hermetic: no loadPlugins(),
// no real plugin registry, no filesystem writes (e.g. agent-claude's
// projectHistoryMounts mkdir-ing into the real ~/.claude/projects).
const fakePlugins = [
  { runArgs: () => ['-v', 'plug:/plug'] },
  { needsCaps: () => true },
];
const fakeBrokerEnv = async () => ['-e', 'SBX_OPEN_URL=http://x/'];

test('buildRunSpec reproduces core mounts, env and cwd', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: { memory: '4g', cpus: '4' },
    dir: '/vivary/demo',
    cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['bash'],
    plugins: fakePlugins, brokerEnv: fakeBrokerEnv,
  });
  assert.equal(spec.name, 'claude-sandbox-demo');
  assert.equal(spec.cwd, '/w/demo');
  assert.deepEqual(spec.env.SBX_SANDBOX_NAME, 'demo');
  assert.ok(spec.mounts.some((m) => m.guest === '/w/demo' && m.host === '/w/demo'));
  assert.ok(spec.mounts.some((m) => m.guest === '/home/agent/.config'));
  assert.equal(spec.init, true);        // docker
});

test('buildRunSpec extraArgs: plugin runArgs (in order) then brokerEnv', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: {},
    dir: '/vivary/demo',
    cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['bash'],
    plugins: fakePlugins, brokerEnv: fakeBrokerEnv,
  });
  assert.deepEqual(spec.extraArgs, ['-v', 'plug:/plug', '-e', 'SBX_OPEN_URL=http://x/']);
});

test('buildRunSpec extraArgs: multiple runArgs-plugins concatenate in array order, then brokerEnv', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: {},
    dir: '/vivary/demo',
    cname: 'claude-sandbox-demo',
  };
  const multiPlugins = [
    { runArgs: () => ['-v', 'a:a'] },
    { runArgs: () => ['-v', 'b:b'] },
    { needsCaps: () => true },
  ];
  const brokerOut = ['-e', 'SBX_OPEN_URL=http://y/'];
  const fakeBrokerEnv2 = async () => brokerOut;
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['bash'],
    plugins: multiPlugins, brokerEnv: fakeBrokerEnv2,
  });
  assert.deepEqual(spec.extraArgs, ['-v', 'a:a', '-v', 'b:b', ...brokerOut]);
});

test('buildRunSpec capsAll: true for non-docker runtime with a needsCaps plugin', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'container' },
    flags: {},
    dir: '/vivary/demo',
    cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['bash'],
    plugins: fakePlugins, brokerEnv: fakeBrokerEnv,
  });
  assert.equal(spec.capsAll, true);
});

test('buildRunSpec capsAll: false when runtime is docker even with a needsCaps plugin', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: {},
    dir: '/vivary/demo',
    cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['bash'],
    plugins: fakePlugins, brokerEnv: fakeBrokerEnv,
  });
  assert.equal(spec.capsAll, false);
});

test('start-shaped spec renders a run argv ending in image + command', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'container' },
    flags: {}, dir: '/state/demo', cname: 'claude-sandbox-demo',
  };
  // Hermetic like the buildRunSpec tests above: no loadPlugins(), no real
  // plugin registry (getPlugins() dies with "plugins not loaded" otherwise).
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'agent-sandbox-agents', command: ['claude'],
    plugins: fakePlugins, brokerEnv: fakeBrokerEnv,
  });
  const argv = renderRunArgs(spec, { runtime: 'container' });
  assert.equal(argv[0], 'run');
  assert.equal(argv[argv.length - 2], 'agent-sandbox-agents');
  assert.equal(argv[argv.length - 1], 'claude');
  assert.ok(!argv.includes('--init'));   // container
});

test('resolveRuntime(tart) returns the vm-tart provider', () => {
  const rt = resolveRuntime('tart');
  assert.equal(rt.name, 'tart');
  assert.equal(rt.kind, 'vm-tart');
  assert.equal(rt.instanceName('demo'), 'vivary-demo');
});

test('renderExecArgs reproduces the legacy attach argv (env object -> -e pairs)', () => {
  const argv = renderExecArgs('claude-sandbox-demo', ['claude', '--resume'], {
    interactive: true,
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', SBX_OPEN_URL: 'http://x/' },
  });
  assert.deepEqual(argv, [
    'exec', '-it',
    '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor', '-e', 'SBX_OPEN_URL=http://x/',
    'claude-sandbox-demo', 'claude', '--resume',
  ]);
});

test('renderExecArgs non-interactive omits -it; empty env adds nothing', () => {
  assert.deepEqual(renderExecArgs('c', ['bash'], {}), ['exec', 'c', 'bash']);
});

test('container-cli instanceName is the legacy containerName', () => {
  assert.equal(resolveRuntime('docker').instanceName('demo'), 'claude-sandbox-demo');
});

test('buildRunSpec for tart: workspace-only mounts, no plugin/broker args', async () => {
  const trap = [{ runArgs: () => { throw new Error('plugins must not run for tart'); }, needsCaps: () => true }];
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'tart' },
    flags: {}, dir: '/state/demo', cname: 'vivary-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: true, image: 'ignored', command: ['claude'],
    plugins: trap, brokerEnv: async () => { throw new Error('broker must not run for tart'); },
  });
  assert.deepEqual(spec.mounts, [{ host: '/w/demo', guest: '/w/demo' }]);
  assert.deepEqual(spec.extraArgs, []);
  assert.equal(spec.capsAll, false);
  assert.equal(spec.init, false);
  assert.equal(spec.name, 'vivary-demo');
});

test('clipboard vmContribute disables native sharing unless --clipboard', () => {
  assert.deepEqual(clipboardPlugin.vmContribute({ cfg: { clipboard: false } }), { runArgs: ['--no-clipboard'] });
  assert.deepEqual(clipboardPlugin.vmContribute({ cfg: { clipboard: true } }), { runArgs: [] });
});
