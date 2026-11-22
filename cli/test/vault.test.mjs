// The vault step: vivary's long-lived secrets in the Keychain (stdin, never
// argv), per-run secrets into the container's RAM, legacy files moved once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SANDBOXES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-vault-'));
const { keychainGet, keychainSet } = await import('../core/keychain.mjs');
const { putRunSecret, hasRunTmpfs } = await import('../core/runsecrets.mjs');
const { ensureSecrets } = await import('../plugins/egress/ashp.mjs');
const { expandEnvRefs } = await import('../plugins/npmrc/plugin.mjs');

test('Keychain: the value goes in on stdin, never in argv, and is read back; a missing item is null', () => {
  const calls = [];
  let kept = '';
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, input: opts.input });
    if (args[0] === 'add-generic-password') kept = opts.input.split('\n')[0];
    return { status: 0, stdout: args[0] === 'find-generic-password' ? `${kept}\n` : '', stderr: '' };
  };
  keychainSet('ashp-admin', 's3cret-value', { run });
  assert.equal(calls[0].bin, 'security');
  assert.ok(!calls[0].args.join(' ').includes('s3cret-value'), 'not in argv');
  assert.equal(calls[0].args.at(-1), '-w', '-w last: read from stdin');
  assert.equal(calls[0].input, 's3cret-value\ns3cret-value\n');
  // a Keychain that cuts the value off is caught, not trusted
  const cut = (bin, args, opts = {}) => ({ status: 0, stdout: args[0] === 'find-generic-password' ? 'cut\n' : '', stderr: '' });
  assert.throws(() => keychainSet('y', 'longer-value', { run: cut }), /did not keep 'y' intact/);
  assert.throws(() => keychainSet('x', 'two\nlines', { run }), /one non-empty line/);
  assert.throws(() => keychainSet('bad account!', 'v', { run }), /bad keychain account/);
  assert.throws(() => keychainSet('x', 'a'.repeat(128), { run }), /longer than 127 bytes/);
  const missing = () => ({ status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' });
  assert.equal(keychainGet('nope', { run: missing }), null);
  assert.equal(keychainGet('ok', { run: () => ({ status: 0, stdout: 'v\n', stderr: '' }) }), 'v');
  assert.throws(() => keychainGet('x', { run: () => ({ status: 51, stdout: '', stderr: 'locked' }) }), /cannot read/);
});

test('RAM secrets: written as root through exec stdin, 0600; nothing without the tmpfs', () => {
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ args, input: opts.input });
    return args.join(' ').includes('/proc/mounts') ? { status: 0, stdout: 'tmpfs\n', stderr: '' } : { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(putRunSecret('container', 'c1', 'npmrc', 'TOKEN=abc', { run }), 'tmpfs');
  const w = calls[1];
  assert.deepEqual(w.args.slice(0, 5), ['exec', '-i', '--user', 'root', 'c1']);
  assert.match(w.args.at(-1), /umask 077 && cat > \/run\/vivary\/npmrc\.new && chown agent:agent .* && mv /);
  assert.ok(!w.args.join(' ').includes('TOKEN=abc'));
  assert.equal(w.input, 'TOKEN=abc');
  const noTmpfs = () => ({ status: 0, stdout: 'overlay\n', stderr: '' });
  assert.equal(hasRunTmpfs('docker', 'c2', { run: noTmpfs }), false);
  assert.equal(putRunSecret('docker', 'c2', 'npmrc', 'x', { run: noTmpfs }), 'legacy');
  assert.throws(() => putRunSecret('docker', 'c2', '../etc/passwd', 'x', { run, probed: true }), /bad secret name/);
  assert.throws(() => putRunSecret('docker', 'c2', 'x', 'y', { run: () => ({ status: 1, stdout: '', stderr: 'boom' }), probed: true }), /boom/);
});

test('ASHP secrets: an existing secrets.json moves into the Keychain once, then the file goes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashp-'));
  const legacy = { dbKey: 'db1', logKey: 'log1', caKey: 'ca1', adminPassword: 'pw1' };
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(legacy));
  const store = new Map();
  const kc = { get: (a) => store.get(a) ?? null, set: (a, v) => store.set(a, v) };
  assert.deepEqual(ensureSecrets({ kc, dir }), legacy, 'same keys: the existing db stays readable');
  assert.ok(!fs.existsSync(path.join(dir, 'secrets.json')));
  assert.deepEqual(['ashp-db-key', 'ashp-log-key', 'ashp-ca-key', 'ashp-admin'].map((a) => store.get(a)),
    ['db1', 'log1', 'ca1', 'pw1']);
  assert.deepEqual(ensureSecrets({ kc, dir }), legacy, 'stable afterwards');
  // fresh install: generated straight into the Keychain, nothing on disk
  const fresh = new Map();
  const s = ensureSecrets({ kc: { get: (a) => fresh.get(a) ?? null, set: (a, v) => fresh.set(a, v) }, dir });
  assert.match(s.dbKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ASHP secrets: half in the Keychain and a file too, or a disagreement — nothing is deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashp-'));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ dbKey: 'a', logKey: 'b', caKey: 'c', adminPassword: 'd' }));
  const part = new Map([['ashp-db-key', 'a']]);
  assert.throws(() => ensureSecrets({ kc: { get: (k) => part.get(k) ?? null, set: () => {} }, dir }), /only part/);
  const other = new Map([['ashp-db-key', 'X'], ['ashp-log-key', 'b'], ['ashp-ca-key', 'c'], ['ashp-admin', 'd']]);
  assert.throws(() => ensureSecrets({ kc: { get: (k) => other.get(k) ?? null, set: () => {} }, dir }), /disagree/);
  assert.ok(fs.existsSync(path.join(dir, 'secrets.json')));
});

test('ASHP secrets: the file stays when the Keychain refuses (the db key must not be lost)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashp-'));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ dbKey: 'a', logKey: 'b', caKey: 'c', adminPassword: 'd' }));
  const kc = { get: () => null, set: () => { throw new Error('keychain locked'); } };
  assert.throws(() => ensureSecrets({ kc, dir }), /keychain locked/);
  assert.ok(fs.existsSync(path.join(dir, 'secrets.json')));
});

test('npm ${VAR} references are expanded on the host; unknown ones stay for npm to name', () => {
  assert.equal(expandEnvRefs('//r/:_authToken=${NPM_T}\nx=${NOPE}', { NPM_T: 'abc' }), '//r/:_authToken=abc\nx=${NOPE}');
});
