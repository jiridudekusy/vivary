// The broker resolves a request's token to its sandbox. It used to scan every
// sandbox dir and read every token file on every request — the broker was then
// the busiest file-opener on the Mac and the first to die of ENFILE. These pin
// the cache: hits touch one token file, misses rescan at most every 5 s, and a
// rotated token stops working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-broker-'));
process.env.SANDBOXES_DIR = root;
const { sandboxByToken, resetTokenCache } = await import('../core/broker.mjs');

function mkSandbox(name, token) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sandbox.json'), JSON.stringify({ name, workspace: `/w/${name}` }));
  fs.writeFileSync(path.join(dir, 'broker-token'), token);
}

function countScans(fn) {
  const orig = fs.readdirSync;
  let n = 0;
  fs.readdirSync = (...a) => { n++; return orig(...a); };
  try { fn(); } finally { fs.readdirSync = orig; }
  return n;
}

test('a known token resolves to its sandbox; unknown and empty do not', () => {
  resetTokenCache();
  mkSandbox('a', 'tok-a');
  mkSandbox('b', 'tok-b');
  assert.equal(sandboxByToken('tok-a', { now: 10_000 }).name, 'a');
  assert.equal(sandboxByToken('tok-b', { now: 10_000 }).name, 'b');
  assert.equal(sandboxByToken('nope', { now: 10_000 }), null);
  assert.equal(sandboxByToken('', { now: 10_000 }), null);
});

test('hits never rescan the sandbox dirs', () => {
  resetTokenCache();
  sandboxByToken('tok-a', { now: 20_000 });
  const scans = countScans(() => {
    for (let i = 0; i < 50; i++) sandboxByToken('tok-a', { now: 20_000 + i });
  });
  assert.equal(scans, 0);
});

test('a miss rescans at most once per 5 s, then finds a new sandbox', () => {
  resetTokenCache();
  sandboxByToken('tok-a', { now: 30_000 });
  mkSandbox('c', 'tok-c');
  const scans = countScans(() => {
    assert.equal(sandboxByToken('tok-c', { now: 31_000 }), null); // within 5 s of the build
    assert.equal(sandboxByToken('tok-c', { now: 32_000 }), null);
  });
  assert.equal(scans, 0);
  assert.equal(sandboxByToken('tok-c', { now: 35_000 }).name, 'c');
});

test('a rotated token stops working at once', () => {
  resetTokenCache();
  assert.equal(sandboxByToken('tok-b', { now: 40_000 }).name, 'b');
  fs.writeFileSync(path.join(root, 'b', 'broker-token'), 'tok-b2');
  assert.equal(sandboxByToken('tok-b', { now: 40_001 }), null);
  assert.equal(sandboxByToken('tok-b2', { now: 46_000 }).name, 'b');
});

test('a token file that cannot be read is logged, not passed off as a bad token', () => {
  resetTokenCache();
  mkSandbox('c', 'tok-c');
  assert.equal(sandboxByToken('tok-c', { now: 50_000 }).name, 'c');
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...a) => {
    if (String(p).endsWith(path.join('c', 'broker-token'))) {
      throw Object.assign(new Error('file table overflow'), { code: 'ENFILE' });
    }
    return orig(p, ...a);
  };
  try {
    assert.equal(sandboxByToken('tok-c', { now: 50_001 }), null);
  } finally {
    fs.readFileSync = orig;
  }
  const log = fs.readFileSync(path.join(root, '.broker', 'broker.log'), 'utf8');
  assert.match(log, / ENFILE token read for 'c': the Mac is out of file handles/);
});

// --- the vault step: a fresh token per container start, only its hash kept ---

const { issueBrokerToken, deliverBrokerToken } = await import('../core/broker.mjs');

test('an issued token is never stored: only its sha256, and it authorizes its sandbox', () => {
  resetTokenCache();
  mkSandbox('d', 'tok-d-legacy');
  fs.rmSync(path.join(root, 'd', 'broker-token'));
  const tok = issueBrokerToken('d');
  const files = fs.readdirSync(path.join(root, 'd'));
  for (const f of files) assert.ok(!fs.readFileSync(path.join(root, 'd', f), 'utf8').includes(tok), f);
  assert.equal(sandboxByToken(tok, { now: 60_000 }).name, 'd');
  // the next start replaces it: the old one dies at once
  const next = issueBrokerToken('d');
  assert.equal(sandboxByToken(tok, { now: 60_001 }), null);
  assert.equal(sandboxByToken(next, { now: 66_000 }).name, 'd');
});

test('delivery: onto the tmpfs through exec stdin (never argv), and the legacy file goes', () => {
  mkSandbox('e', 'tok-e-legacy');
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, input: opts.input });
    return args.includes('awk') || args.some((a) => a.includes('/proc/mounts'))
      ? { status: 0, stdout: 'tmpfs\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(deliverBrokerToken({ name: 'e' }, 'container', 'c-e', { run }), 'tmpfs');
  const write = calls[1];
  assert.ok(write.args.includes('-i') && write.args.includes('root'));
  assert.ok(!write.args.join(' ').includes(write.input), 'token not in argv');
  assert.ok(!fs.existsSync(path.join(root, 'e', 'broker-token')), 'legacy plaintext removed');
  resetTokenCache();
  assert.equal(sandboxByToken(write.input, { now: 70_000 }).name, 'e');
});

test('a container without the tmpfs keeps its baked-in legacy token', () => {
  mkSandbox('f', 'tok-f');
  const run = () => ({ status: 0, stdout: 'overlay\n', stderr: '' });
  assert.equal(deliverBrokerToken({ name: 'f' }, 'docker', 'c-f', { run }), 'legacy');
  resetTokenCache();
  assert.equal(sandboxByToken('tok-f', { now: 80_000 }).name, 'f');
});
