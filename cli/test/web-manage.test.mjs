// Managing a sandbox from the web: connection details, settings changes and
// .vivary.json approval, each behind a passkey touch bound to the exact
// request; recreate likewise; nothing for host ports/paths; the project file
// read without following symlinks.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-manage-'));
process.env.SANDBOXES_DIR = STATE;
const WS = path.join(STATE, 'ws');
fs.mkdirSync(WS);
fs.mkdirSync(path.join(STATE, 'sb'));
fs.writeFileSync(path.join(STATE, 'sb', 'sandbox.json'),
  JSON.stringify({ name: 'sb', workspace: WS, runtime: 'container', tailscale: true, tsSshPort: 2201 }));

const { createAuth, createEnrollToken } = await import('../plugins/web/auth.mjs');
const { createServer } = await import('../plugins/web/server.mjs');
const { configHash } = await import('../core/config.mjs');
const {
  connectDetails, lastJson, pendingApproval, readProjectFile, settingsArgv,
} = await import('../plugins/web/manage.mjs');
const { SoftAuthenticator, TEST_ORIGIN: ORIGIN } = await import('./helpers/softauthn.mjs');

const RP = new URL(ORIGIN).hostname;
const OWNER = 'owner@example.com';
const CONFIG_JSON = {
  name: 'sb', workspace: WS, runtime: 'container', agent: 'claude',
  memory: { value: '4g', source: 'built-in' }, cpus: { value: '4', source: 'built-in' },
  profiles: { own: [], fromProject: [], available: [] },
  flags: [{ name: 'headed', type: 'boolean', value: false, source: 'built-in', settable: true, live: true, help: 'GUI' },
    { name: 'paseo', type: 'boolean', value: true, source: 'profile:p', settable: true, live: false, help: 'Paseo' }],
};

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));

async function start({ results = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(STATE, 'web-'));
  const auth = createAuth({ rpId: RP, origin: ORIGIN, dir });
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const r = results[args[0]];
    if (r) return r;
    if (args[0] === 'config') return { ok: true, output: '', stdout: JSON.stringify(CONFIG_JSON) };
    return { ok: true, output: `${args.join(' ')} done`, stdout: '' };
  };
  const server = createServer({ allow: [OWNER], auth, run, fqdn: () => RP, log: () => {} });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, { body, cookie, csrf } = {}) => new Promise((resolve, reject) => {
    const h = { origin: ORIGIN, 'x-vivary': '1', 'tailscale-user-login': OWNER };
    if (cookie) h.cookie = cookie;
    if (csrf) h['x-csrf-token'] = csrf;
    const data = body === undefined ? null : JSON.stringify(body);
    if (data) Object.assign(h, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] || null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const authn = new SoftAuthenticator();
  const token = createEnrollToken({ origin: ORIGIN, dir });
  const o = await call('POST', '/api/auth/enroll/options', { body: { token } });
  const e = await call('POST', '/api/auth/enroll', {
    body: { token, challengeId: o.json.challengeId, response: authn.create(o.json.options), name: 'Mac' },
  });
  const st = await call('GET', '/api/auth/status', { cookie: e.cookie });
  const s = { cookie: e.cookie, csrf: st.json.csrf };
  const stepUp = async (action, payload) => {
    const r = await call('POST', '/api/auth/stepup', { ...s, body: { action, payload } });
    assert.equal(r.status, 200, r.text);
    return { challengeId: r.json.challengeId, response: authn.get(r.json.options) };
  };
  return { calls, call, s, stepUp, close: () => { server.closeAllConnections(); server.close(); } };
}

test('the detail: settings from `vivary config --json`, connection from the resolved values', async () => {
  const t = await start();
  const r = await t.call('GET', '/api/sandboxes/sb', t.s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(t.calls.at(-1), ['config', 'sb', '--json']);
  assert.equal(r.json.settings.memory.value, '4g');
  assert.equal(r.json.connect.tailnet.ssh, `ssh -p 2201 agent@${RP}`);
  assert.match(r.json.connect.tailnet.sshConfig, /^Host vivary-sb\n {2}HostName .+\n {2}Port 2201\n {2}User agent\n$/);
  assert.equal(r.json.connect.paseo, null, 'no Paseo port yet');
  assert.ok(!JSON.stringify(r.json).includes('password"'), 'no password anywhere');
  assert.equal((await t.call('GET', '/api/sandboxes/nope', t.s)).status, 404);
  assert.equal((await t.call('GET', '/api/sandboxes/sb')).status, 401);
  t.close();
});

test('a settings change needs a passkey touch for exactly that change', async () => {
  const t = await start({ results: { set: { ok: true, output: '', stdout: '{"effect":"recreate","drift":[{"key":"memory","from":"4g","to":"8g"}]}' } } });
  const changes = { memory: '8g', flags: { headed: true } };
  const url = '/api/sandboxes/sb/settings';
  assert.equal((await t.call('POST', url, { ...t.s, body: { changes } })).status, 403, 'no touch');
  const other = await t.stepUp('settings', { name: 'sb', changes: { memory: '16g' } });
  assert.equal((await t.call('POST', url, { ...t.s, body: { changes, stepUp: other } })).status, 403, 'touch for another change');
  const proof = await t.stepUp('settings', { name: 'sb', changes });
  const r = await t.call('POST', url, { ...t.s, body: { changes, stepUp: proof } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.effect, 'recreate');
  assert.deepEqual(t.calls.at(-1), ['set', 'sb', '--json', '--memory=8g', '--headed=on']);
  assert.equal((await t.call('POST', url, { ...t.s, body: { changes, stepUp: proof } })).status, 403, 'a touch works once');
  t.close();
});

test('host ports and paths are never settable from the web, whatever is touched', async () => {
  const t = await start();
  for (const changes of [{ flags: { publish: true } }, { flags: { volume: '/' } }, { flags: { workspace: 'x' } },
    { mounts: ['/'] }, { flags: { headed: '$(rm -rf ~)' } }, {}]) {
    const proof = await t.stepUp('settings', { name: 'sb', changes });
    const r = await t.call('POST', '/api/sandboxes/sb/settings', { ...t.s, body: { changes, stepUp: proof } });
    assert.equal(r.status, 400, JSON.stringify(changes));
  }
  assert.ok(!t.calls.some((c) => c[0] === 'set'));
  t.close();
});

test('approval: a touch for exactly that content (sha256), passed on to `vivary approve`', async () => {
  const t = await start({ results: { approve: { ok: true, output: '', stdout: '{"status":"approved"}' } } });
  const sha = 'a'.repeat(64);
  const url = '/api/sandboxes/sb/approve';
  assert.equal((await t.call('POST', url, { ...t.s, body: { sha: 'nope' } })).status, 400);
  const wrong = await t.stepUp('config-approve', { name: 'sb', sha: 'b'.repeat(64) });
  assert.equal((await t.call('POST', url, { ...t.s, body: { sha, stepUp: wrong } })).status, 403);
  const proof = await t.stepUp('config-approve', { name: 'sb', sha });
  const r = await t.call('POST', url, { ...t.s, body: { sha, stepUp: proof } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(t.calls.at(-1), ['approve', 'sb', '--sha', sha, '--json']);
  t.close();
});

test('recreate needs a touch; restart is down + up; start/stop need none', async () => {
  const t = await start();
  assert.equal((await t.call('POST', '/api/sandboxes/sb/recreate', { ...t.s, body: {} })).status, 403);
  const proof = await t.stepUp('recreate', { name: 'sb' });
  assert.equal((await t.call('POST', '/api/sandboxes/sb/recreate', { ...t.s, body: { stepUp: proof } })).status, 200);
  assert.deepEqual(t.calls.slice(-2), [['down', '--name', 'sb'], ['up', '--name', 'sb', '--recreate']]);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/restart', { ...t.s, body: {} })).status, 200);
  assert.deepEqual(t.calls.slice(-2), [['down', '--name', 'sb'], ['up', '--name', 'sb']]);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/up', { ...t.s, body: {} })).status, 200);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/restart', { cookie: t.s.cookie, body: {} })).status, 403, 'CSRF');
  t.close();
});

test('the project file is read without following a symlink, bounded, and diffed against the approved copy', () => {
  const ws = fs.mkdtempSync(path.join(STATE, 'pf-'));
  const file = path.join(ws, '.vivary.json');
  assert.equal(readProjectFile(ws), null);
  const secret = path.join(STATE, 'id_secret');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  fs.symlinkSync(secret, file);
  assert.match(readProjectFile(ws).error, /symlink/);
  assert.ok(!JSON.stringify(pendingApproval({ name: 'sb', workspace: ws })).includes('PRIVATE'));
  fs.unlinkSync(file);
  execFileSync('mkfifo', [file]);
  assert.match(readProjectFile(ws).error, /not a regular file/, 'a FIFO does not hang the server');
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'x'.repeat(300 * 1024));
  assert.match(readProjectFile(ws).error, /larger than/);
  const raw = '{ "memory": "8g" }\n';
  fs.writeFileSync(file, raw);
  const p = pendingApproval({ name: 'sb', workspace: ws }, { validate: () => { throw new Error('bad key'); } });
  assert.deepEqual([p.sha, p.first, p.invalid], [configHash(raw), true, 'bad key']);
  assert.match(p.diff, /\n\+ \{ "memory": "8g" \}/);
  assert.equal(pendingApproval({ name: 'sb', workspace: ws, configApproved: configHash(raw) }), null);
});

test('settings argv: one token per value, nothing else gets through', () => {
  assert.deepEqual(settingsArgv('sb', { cpus: '6', profiles: [], flags: { docker: false, uunpm: 'alias' } }),
    ['set', 'sb', '--json', '--cpus=6', '--profile=none', '--docker=off', '--uunpm=alias']);
  for (const bad of [{ memory: '8g --volume=/' }, { profiles: ['a,b'] }, { flags: { 'x;y': true } }, { flags: [] }, null]) {
    assert.throws(() => settingsArgv('sb', bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.deepEqual(lastJson('noise\n{"a":1}\n'), { a: 1 });
  const c = connectDetails({ name: 'sb', runtime: 'container', workspace: '/w', tailscale: false }, RP);
  assert.equal(c.tailnet, null);
  assert.match(c.hint, /this Mac only/);
  assert.match(c.mac.ide.cursor, /^cursor:\/\/vscode-remote\/ssh-remote\+.+\/w$/);
});
