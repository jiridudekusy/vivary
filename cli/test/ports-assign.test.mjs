// Unit tests for stable per-sandbox host ports and cross-runtime instance
// lookup — the two things that made a second docker sandbox unstartable and
// left a container running after `vivary rm --purge`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// assignStablePort reads other sandboxes from SANDBOXES_DIR, so point that at a
// temp dir BEFORE importing the module (the constant is captured at load time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-ports-test-'));
process.env.SANDBOXES_DIR = tmp;
const { assignStablePort } = await import('../core/sandbox.mjs');
const { RUNTIME_NAMES, runtimesRunning } = await import('../core/runtimes/index.mjs');

const writeSandbox = (name, json) => {
  fs.mkdirSync(path.join(tmp, name), { recursive: true });
  fs.writeFileSync(path.join(tmp, name, 'sandbox.json'), JSON.stringify({ name, ...json }));
};

const freeAll = async () => true;

test('a persisted port is returned as-is (aliases and known_hosts stay valid)', async () => {
  writeSandbox('keeper', { sshPort: 2299 });
  const cfg = { name: 'keeper', sshPort: 2299 };
  assert.equal(await assignStablePort(cfg, { key: 'sshPort', base: 2222, isFree: freeAll }), 2299);
});

test('the preferred port is taken when nothing claims it', async () => {
  writeSandbox('first', {});
  const cfg = { name: 'first' };
  assert.equal(
    await assignStablePort(cfg, { key: 'sshPort', base: 2222, preferred: 2222, isFree: freeAll }),
    2222);
  // persisted, so the next run does not reshuffle it
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'first/sandbox.json'), 'utf8')).sshPort, 2222);
});

test('a port another sandbox already owns is skipped', async () => {
  writeSandbox('other', { sshPort: 2222 });
  writeSandbox('second', {});
  const cfg = { name: 'second' };
  const port = await assignStablePort(cfg, { key: 'sshPort', base: 2222, preferred: 2222, isFree: freeAll });
  assert.notEqual(port, 2222); // this is the collision that broke `vivary up`
  assert.ok(port >= 2222 && port < 2222 + 900);
});

test('ports are avoided across ALL port keys, not just the same one', async () => {
  writeSandbox('tsowner', { tsSshPort: 2223 });
  writeSandbox('third', {});
  const cfg = { name: 'third' };
  const port = await assignStablePort(cfg, {
    key: 'sshPort', base: 2222, preferred: 2223, isFree: freeAll,
  });
  assert.notEqual(port, 2223);
});

test('a port busy on the host is skipped even when no sandbox claims it', async () => {
  writeSandbox('fourth', {});
  const busy = new Set();
  const cfg = { name: 'fourth' };
  // refuse the first two candidates, accept the third
  let seen = 0;
  const isFree = async (p) => {
    seen++;
    if (seen <= 2) { busy.add(p); return false; }
    return true;
  };
  const port = await assignStablePort(cfg, { key: 'sshPort', base: 2222, preferred: 2222, isFree });
  assert.equal(busy.has(port), false);
  assert.equal(seen, 3);
});

test('the assignment is deterministic for a given name', async () => {
  writeSandbox('stable', {});
  const a = await assignStablePort({ name: 'stable' }, { key: 'sshPort', base: 2222, isFree: freeAll });
  const b = await assignStablePort({ name: 'stable' }, { key: 'sshPort', base: 2222, isFree: freeAll });
  assert.equal(a, b);
});

// --- cross-runtime lookup -------------------------------------------------------

test('runtimesRunning asks every runtime and tolerates missing ones', () => {
  assert.deepEqual(RUNTIME_NAMES, ['docker', 'container', 'tart']);
  // no such sandbox anywhere -> empty, and no throw even if a CLI is absent
  assert.deepEqual(runtimesRunning('vivary-no-such-sandbox-xyz'), []);
});

test('runtimesRunning honours an explicit runtime subset', () => {
  assert.deepEqual(runtimesRunning('vivary-no-such-sandbox-xyz', ['tart']), []);
});
