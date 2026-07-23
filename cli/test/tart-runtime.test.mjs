import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGuestExecArgv, buildTartRunArgv, envPairsToObject, parseMemoryMb, shq, tartVmName,
} from '../core/runtimes/tart.mjs';

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
