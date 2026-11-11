// A sandbox's screen through vivary web: the WebSocket is gated like the API
// (origin, tailnet allowlist, a passkey session), the RFB stream runs through
// the relay command both ways, a screen closes with its session, and noVNC's
// code is served from the Mac only, file by file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-vnc-'));
process.env.SANDBOXES_DIR = STATE;
const sandbox = (name, extra = {}) => {
  fs.mkdirSync(path.join(STATE, name), { recursive: true });
  fs.writeFileSync(path.join(STATE, name, 'sandbox.json'), JSON.stringify({ name, workspace: `/tmp/${name}`, ...extra }));
};
sandbox('sb', { headed: true, vncRelay: true, runtime: 'container' });
sandbox('plain', { runtime: 'container' });
sandbox('asleep', { headed: true, vncRelay: true, runtime: 'docker' });

const { createAuth, createEnrollToken } = await import('../plugins/web/auth.mjs');
const { createServer } = await import('../plugins/web/server.mjs');
const { relayFor, wsLib } = await import('../plugins/web/vnc.mjs');
const { resolveRuntime } = await import('../core/runtimes/index.mjs');
const { SoftAuthenticator, TEST_ORIGIN: ORIGIN } = await import('./helpers/softauthn.mjs');
const ws = await wsLib();

const RP = new URL(ORIGIN).hostname;
const OWNER = 'owner@example.com';
const running = (name) => (name === 'asleep' ? null : 'container');

// Stands in for `container exec -i <c> vnc-relay`: greets like a VNC server,
// echoes what the viewer sends, and leaves a marker when it ends. FAIL=1 makes
// it fail the way vnc-relay does when no VNC server runs.
const FAKE = path.join(STATE, 'fake-relay.mjs');
fs.writeFileSync(FAKE, `
  import fs from 'node:fs';
  if (process.env.FAIL) { process.stderr.write('vnc-relay: no VNC server on 127.0.0.1:5900 - is the GUI running?\\n'); process.exit(2); }
  process.stdout.write('RFB 003.008\\n');
  process.stdin.on('data', (d) => process.stdout.write(d));
  process.stdin.on('end', () => { fs.writeFileSync(process.env.MARK, 'ended'); process.exit(0); });
`);

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));

async function start({ fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(STATE, 'web-'));
  const mark = path.join(dir, 'relay-ended');
  const auth = createAuth({ rpId: RP, origin: ORIGIN, dir });
  const relay = (name) => {
    const real = relayFor(name, { running });   // the real checks
    return { ...real, bin: process.execPath, args: [FAKE] };
  };
  const server = createServer({
    allow: [OWNER], auth, ws, relay, fqdn: () => RP, log: () => {},
    screens: {
      sweepMs: 40,
      spawnFn: (bin, args, opts) => spawn(bin, args,
        { ...opts, env: { ...process.env, MARK: mark, ...(fail ? { FAIL: '1' } : {}) } }),
    },
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const call = (method, p, { body, cookie, csrf, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { origin: ORIGIN, 'x-vivary': '1', 'tailscale-user-login': OWNER, ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
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
        const setCookie = res.headers['set-cookie']?.[0] || null;
        resolve({ status: res.statusCode, json, text, headers: res.headers, cookie: setCookie?.split(';')[0] || null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  // Open a screen; resolves with the socket, or with the HTTP status it was refused with.
  const screen = (name, { cookie, headers = {} } = {}) => new Promise((resolve) => {
    const h = { 'tailscale-user-login': OWNER, ...(cookie ? { cookie } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const sock = new ws.WebSocket(`ws://127.0.0.1:${port}/api/vnc/${encodeURIComponent(name)}`,
      { origin: headers.origin === undefined ? ORIGIN : headers.origin || undefined, headers: h });
    sock.on('open', () => resolve({ sock }));
    sock.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode }));
    sock.on('error', () => {});
  });

  // A logged-in session, the way the page gets one.
  const login = async () => {
    const authn = new SoftAuthenticator();
    const token = createEnrollToken({ origin: ORIGIN, dir });
    const o = await call('POST', '/api/auth/enroll/options', { body: { token } });
    const r = await call('POST', '/api/auth/enroll', {
      body: { token, challengeId: o.json.challengeId, response: authn.create(o.json.options), name: 'Mac' },
    });
    assert.equal(r.status, 200, r.text);
    const st = await call('GET', '/api/auth/status', { cookie: r.cookie });
    return { cookie: r.cookie, csrf: st.json.csrf };
  };

  return { server, call, screen, login, mark, close: () => { server.closeAllConnections(); server.close(); } };
}

const nextMessage = (sock) => new Promise((resolve) => sock.once('message', (d) => resolve(d.toString())));
const closed = (sock) => new Promise((resolve) => sock.once('close', (code, why) => resolve({ code, why: why.toString() })));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test('which sandboxes have a screen, and the command that carries it', () => {
  assert.throws(() => relayFor('nope', { running }), { status: 404 });
  assert.throws(() => relayFor('plain', { running }), (e) => e.status === 409 && /vivary up plain --headed/.test(e.message));
  assert.throws(() => relayFor('asleep', { running }), (e) => e.status === 409 && /not running/.test(e.message));
  const cname = resolveRuntime('container').instanceName('sb');
  assert.deepEqual(relayFor('sb', { running }),
    { runtime: 'container', bin: 'container', args: ['exec', '-i', cname, 'vnc-relay'] });
});

test('no screen without a session, from another origin, or for a tailnet login not allowed', async () => {
  const t = await start();
  assert.equal((await t.screen('sb')).refused, 401);
  assert.equal((await t.screen('sb', { cookie: '__Host-vivary=forged' })).refused, 401);
  const s = await t.login();
  assert.equal((await t.screen('sb', { cookie: s.cookie, headers: { origin: 'https://evil.example' } })).refused, 403);
  assert.equal((await t.screen('sb', { cookie: s.cookie, headers: { origin: '' } })).refused, 403);
  assert.equal((await t.screen('sb', { cookie: s.cookie, headers: { 'tailscale-user-login': 'eve@example.com' } })).refused, 403);
  assert.equal((await t.screen('nope', { cookie: s.cookie })).refused, 404);
  assert.equal((await t.screen('plain', { cookie: s.cookie })).refused, 409);
  assert.equal(t.server.screens.count(), 0);
  t.close();
});

test('a screen carries the stream both ways, and closing it ends the relay', async () => {
  const t = await start();
  const s = await t.login();
  const { sock } = await t.screen('sb', { cookie: s.cookie });
  assert.ok(sock, 'screen opened');
  assert.equal(await nextMessage(sock), 'RFB 003.008\n');
  sock.send(Buffer.from('RFB 003.008\n'));
  assert.equal(await nextMessage(sock), 'RFB 003.008\n');
  assert.equal(t.server.screens.count(), 1);
  sock.close();
  assert.ok(await until(() => fs.existsSync(t.mark)), 'relay saw EOF and ended');
  assert.ok(await until(() => t.server.screens.count() === 0));
  t.close();
});

test('signing out closes an open screen', async () => {
  const t = await start();
  const s = await t.login();
  const { sock } = await t.screen('sb', { cookie: s.cookie });
  await nextMessage(sock);
  const end = closed(sock);
  assert.equal((await t.call('POST', '/api/auth/logout', { ...s, body: {} })).status, 200);
  assert.deepEqual(await end, { code: 4001, why: 'signed out' });
  assert.ok(await until(() => fs.existsSync(t.mark)), 'relay ended too');
  t.close();
});

test('a relay that fails says why in the close reason', async () => {
  const t = await start({ fail: true });
  const s = await t.login();
  const { sock } = await t.screen('sb', { cookie: s.cookie });
  const { code, why } = await closed(sock);
  assert.equal(code, 4500);
  assert.match(why, /no VNC server/);
  t.close();
});

test('the viewer asks first: 401 signed out, 409 no screen, 200 ready', async () => {
  const t = await start();
  assert.equal((await t.call('GET', '/api/vnc/sb')).status, 401);
  const s = await t.login();
  assert.equal((await t.call('GET', '/api/vnc/plain', s)).status, 409);
  assert.equal((await t.call('GET', '/api/vnc/asleep', s)).status, 409);
  const ok = await t.call('GET', '/api/vnc/sb', s);
  assert.deepEqual([ok.status, ok.json.runtime], [200, 'container']);
  const state = await t.call('GET', '/api/state', s);
  const byName = Object.fromEntries(state.json.sandboxes.map((x) => [x.name, x]));
  assert.equal(byName.plain.screen, false);
  t.close();
});

test('the viewer page and noVNC come from the Mac, file by file, under the strict CSP', async () => {
  const t = await start();
  const page = await t.call('GET', '/vnc/sb');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(page.text, /<style|\sstyle=/);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, new RegExp(`connect-src 'self' ${ORIGIN.replace('https', 'wss')};`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  for (const ok of ['/novnc/core/rfb.js', '/novnc/core/input/keysym.js', '/novnc/vendor/pako/lib/zlib/inflate.js', '/assets/vnc.js', '/assets/vnc.css']) {
    const r = await t.call('GET', ok);
    assert.equal(r.status, 200, ok);
  }
  for (const bad of ['/novnc/package.json', '/novnc/docs/API.md', '/novnc/core/../package.json', '/novnc/core/%2e%2e/package.json',
    '/novnc/core/nope.js', '/novnc//etc/passwd.js', '/vnc/sb/x']) {
    assert.equal((await t.call('GET', bad)).status, 404, bad);
  }
  t.close();
});
