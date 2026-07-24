import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGuestExecArgv, buildTartRunArgv, envPairsToObject, guestEnvInstallCmd, guestEnvScript,
  parseMemoryMb, shq, tartVmName, withGateway, writeGuestEnv,
} from '../core/runtimes/tart.mjs';
import { makeTartRuntime, MACOS_BASE } from '../core/runtimes/tart.mjs';
import { collectMacosProvision } from '../core/build.mjs';

test('tartVmName prefixes vivary-', () => {
  assert.equal(tartVmName('demo'), 'vivary-demo');
});

test('parseMemoryMb converts docker-style values to megabytes', () => {
  assert.equal(parseMemoryMb('4g'), 4096);
  assert.equal(parseMemoryMb('2048m'), 2048);
  assert.equal(parseMemoryMb('512'), 512);
  assert.throws(() => parseMemoryMb('lots'), /cannot parse memory/);
});

test('shq single-quotes and escapes embedded quotes', () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq("it's"), "'it'\\''s'");
});

test('envPairsToObject parses docker -e pairs', () => {
  assert.deepEqual(
    envPairsToObject(['-e', 'TERM=xterm', '-e', 'A=b=c']),
    { TERM: 'xterm', A: 'b=c' },
  );
  assert.deepEqual(envPairsToObject([]), {});
});

test('buildTartRunArgv renders headless run with indexed ws tags', () => {
  const argv = buildTartRunArgv({
    name: 'vivary-demo',
    mounts: [{ host: '/w/demo', guest: '/w/demo' }, { host: '/x', guest: '/x', ro: true }],
  });
  assert.deepEqual(argv, [
    'run', 'vivary-demo', '--no-graphics',
    '--dir=/w/demo:tag=ws0',
    '--dir=/x:ro,tag=ws1',
  ]);
});

test('buildGuestExecArgv wraps command in a login shell with env + cwd', () => {
  const argv = buildGuestExecArgv('vivary-demo', ['claude', '--version'], {
    interactive: true,
    env: { TERM: 'xterm', SBX_SANDBOX_NAME: 'demo' },
    cwd: '/w/de mo',
  });
  assert.deepEqual(argv, [
    'exec', '-i', '-t', 'vivary-demo',
    '/usr/bin/env', 'TERM=xterm', 'SBX_SANDBOX_NAME=demo',
    '/bin/zsh', '-lc', "cd '/w/de mo' && exec 'claude' '--version'",
  ]);
});

test('buildGuestExecArgv non-interactive, no cwd', () => {
  assert.deepEqual(
    buildGuestExecArgv('vm', ['true'], {}),
    ['exec', 'vm', '/usr/bin/env', '/bin/zsh', '-lc', "exec 'true'"],
  );
});

// Scripted capture: returns queued results per (cmd,args-prefix) matcher and
// records every call for order assertions.
function fakeIo({ listResults, results = {} }) {
  const calls = [];
  let listCalls = 0;
  const capture = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listResults[Math.min(listCalls++, listResults.length - 1)]), stderr: '' };
    return results[key] || { status: 0, stdout: '', stderr: '' };
  };
  const spawned = [];
  return {
    calls, spawned,
    deps: {
      capture,
      runInherit: (cmd, args) => { calls.push(['RUN', cmd, ...args]); return 0; },
      spawnDetached: (argv, log) => { spawned.push(argv); calls.push(['SPAWN', ...argv]); },
      sleep: () => {},
      hasCmd: () => true,
    },
  };
}

const stoppedVm = (name) => ({ Name: name, Source: 'local', Running: false, State: 'stopped' });
const runningVm = (name) => ({ Name: name, Source: 'local', Running: true, State: 'running' });

test('ensureImage dies loudly when the base VM is missing', () => {
  const io = fakeIo({ listResults: [[]] });
  const rt = makeTartRuntime(io.deps);
  assert.throws(() => rt.ensureImage({ name: 'vivary-demo', memory: '4g', cpus: '4' }),
    /vivary build --runtime tart/);
});

test('ensureImage clones from base and applies tart set when stopped', () => {
  const io = fakeIo({ listResults: [
    [stoppedVm(MACOS_BASE)],                                 // first list: no sandbox VM
    [stoppedVm(MACOS_BASE), stoppedVm('vivary-demo')],       // after clone
  ] });
  const rt = makeTartRuntime(io.deps);
  assert.equal(rt.ensureImage({ name: 'vivary-demo', memory: '4g', cpus: '4' }), 'vivary-demo');
  assert.ok(io.calls.some((c) => c.join(' ') === `tart clone ${MACOS_BASE} vivary-demo`));
  assert.ok(io.calls.some((c) => c.join(' ') === 'tart set vivary-demo --cpu 4 --memory 4096'));
});

test('run boots, waits for IP + agent, mounts workspace, then execs the command', () => {
  const io = fakeIo({
    listResults: [[stoppedVm('vivary-demo')]],
    results: { 'ip vivary-demo': { status: 0, stdout: '192.168.65.2\n', stderr: '' } },
  });
  const rt = makeTartRuntime(io.deps);
  const spec = {
    name: 'vivary-demo', interactive: true, cwd: '/w/demo',
    mounts: [{ host: '/w/demo', guest: '/w/demo' }],
    env: { SBX_SANDBOX_NAME: 'demo' },
    termEnv: ['-e', 'TERM=xterm'],
    command: ['claude', '--version'],
  };
  const status = rt.run(spec);
  assert.equal(status, 0);
  const flat = io.calls.map((c) => c.join(' '));
  const iSpawn = flat.findIndex((c) => c.startsWith('SPAWN run vivary-demo --no-graphics'));
  const iIp = flat.findIndex((c) => c.startsWith('tart ip vivary-demo'));
  const iAgent = flat.findIndex((c) => c === 'tart exec vivary-demo true');
  const iMount = flat.findIndex((c) => c === 'tart exec vivary-demo sudo /sbin/mount_virtiofs ws0 /w/demo');
  const iExec = flat.findIndex((c) => c.startsWith('RUN tart exec -i -t vivary-demo /usr/bin/env TERM=xterm SBX_SANDBOX_NAME=demo'));
  assert.ok(iSpawn >= 0 && iSpawn < iIp && iIp < iAgent && iAgent < iMount && iMount < iExec,
    `boot order wrong: ${JSON.stringify(flat)}`);
});

test('run detached skips the exec; run on an already-running VM skips the boot', () => {
  const io = fakeIo({ listResults: [[runningVm('vivary-demo')]] });
  const rt = makeTartRuntime(io.deps);
  const r = rt.run({ name: 'vivary-demo', mounts: [], env: {}, command: ['x'] }, { detached: true });
  assert.deepEqual(r, { status: 0 });
  assert.ok(!io.calls.some((c) => c[0] === 'SPAWN'), 'must not boot a running VM');
});

test('isRunning/runningSet/purge/stop map to tart CLI', () => {
  const io = fakeIo({ listResults: [[runningVm('vivary-demo'), stoppedVm('vivary-other')]] });
  const rt = makeTartRuntime(io.deps);
  assert.equal(rt.isRunning('demo'), true);
  assert.ok(rt.runningSet().has('vivary-demo'));
  rt.stop('vivary-demo');
  rt.purge('vivary-demo');
  const flat = io.calls.map((c) => c.join(' '));
  assert.ok(flat.includes('tart stop vivary-demo'));
  assert.ok(flat.includes('tart delete vivary-demo'));
});

test('bootVm stops the VM when boot-readiness wait throws (no orphaned half-booted VM)', () => {
  const io = fakeIo({
    listResults: [[]],
    results: { 'ip vivary-x': { status: 1, stdout: '', stderr: 'no ip' } },
  });
  const rt = makeTartRuntime(io.deps);
  assert.throws(
    () => rt.run({ name: 'vivary-x', mounts: [], env: {}, command: ['x'] }),
    /no IP/,
  );
  const flat = io.calls.map((c) => c.join(' '));
  assert.ok(flat.includes('tart stop vivary-x'), `expected a stop call: ${JSON.stringify(flat)}`);
});

test('collectMacosProvision flattens plugin steps in plugin order', () => {
  const plugins = [
    { name: 'a', macosProvision: ['echo one', 'echo two'] },
    { name: 'b' },
    { name: 'c', macosProvision: ['echo three'] },
  ];
  assert.deepEqual(collectMacosProvision(plugins), [
    { plugin: 'a', line: 'echo one' },
    { plugin: 'a', line: 'echo two' },
    { plugin: 'c', line: 'echo three' },
  ]);
});

test('buildTartRunArgv appends spec.tartRunArgs after --dir', () => {
  const argv = buildTartRunArgv({
    name: 'vivary-demo',
    mounts: [{ host: '/w', guest: '/w' }],
    tartRunArgs: ['--no-clipboard'],
  });
  assert.deepEqual(argv, [
    'run', 'vivary-demo', '--no-graphics', '--dir=/w:tag=ws0', '--no-clipboard',
  ]);
});

test('buildTartRunArgv without tartRunArgs is unchanged', () => {
  assert.deepEqual(
    buildTartRunArgv({ name: 'v', mounts: [] }),
    ['run', 'v', '--no-graphics'],
  );
});

test('withGateway substitutes __GATEWAY__ from the guest default route', () => {
  const capture = (cmd, args) => {
    assert.equal(cmd, 'tart'); assert.equal(args[0], 'exec');
    return { status: 0, stdout: '192.168.65.1\n', stderr: '' };
  };
  const out = withGateway({ HTTPS_PROXY: 'http://a:b@__GATEWAY__:3128', PLAIN: 'x' }, 'vm', capture);
  assert.deepEqual(out, { HTTPS_PROXY: 'http://a:b@192.168.65.1:3128', PLAIN: 'x' });
});

test('withGateway is a no-op (no exec) when there is no placeholder', () => {
  let called = false;
  const capture = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  const env = { A: '1' };
  assert.equal(withGateway(env, 'vm', capture), env);
  assert.equal(called, false);
});

test('guestEnvScript exports every var, shell-quoted', () => {
  const s = guestEnvScript({ SBX_OPEN_URL: 'http://192.168.65.1:7377/', T: "a'b" });
  assert.match(s, /^# generated by vivary/);
  assert.match(s, /^export SBX_OPEN_URL='http:\/\/192\.168\.65\.1:7377\/'$/m);
  assert.match(s, /^export T='a'\\''b'$/m); // embedded quote survives
});

test('guestEnvScript puts /usr/local/bin on PATH (ssh sessions skip path_helper)', () => {
  const s = guestEnvScript({ A: '1' });
  // without this the `open` shim is shadowed by the guest's own /usr/bin/open
  assert.match(s, /case ":\$PATH:" in \*:\/usr\/local\/bin:\*\)/);
  assert.match(s, /export PATH="\/usr\/local\/bin:\$PATH"/);
});

test('guestEnvInstallCmd writes the snippet and hooks each rc file once', () => {
  const cmd = guestEnvInstallCmd('export A=1\n');
  // the payload travels base64-encoded (no quoting hazards in the exec line)
  assert.match(cmd, new RegExp(Buffer.from('export A=1\n').toString('base64')));
  assert.match(cmd, /base64 -d \| sudo tee \/etc\/vivary-env\.sh/);
  assert.match(cmd, /sudo chmod 644 \/etc\/vivary-env\.sh/);
  for (const rc of ['/etc/zshenv', '/etc/profile']) {
    // grep guard makes the append idempotent across boots
    assert.match(cmd, new RegExp(`grep -qF '/etc/vivary-env\\.sh' ${rc}`));
    assert.match(cmd, new RegExp(`sudo tee -a ${rc}`));
  }
});

test('writeGuestEnv skips the guest round-trip for an empty env', () => {
  let called = false;
  const capture = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  assert.equal(writeGuestEnv('vm', {}, capture), true);
  assert.equal(called, false);
});

test('writeGuestEnv reports a failed install instead of dying', () => {
  const capture = () => ({ status: 1, stdout: '', stderr: 'nope' });
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(writeGuestEnv('vm', { A: '1' }, capture), false);
  } finally {
    console.error = orig;
  }
  assert.match(errs.join('\n'), /could not persist the guest login env/);
});
