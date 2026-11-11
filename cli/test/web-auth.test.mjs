// vivary web behind a passkey: enrollment only from the Mac, sessions, CSRF,
// action-bound step-up, and the old loopback trust gone. Driven end to end
// through the real HTTP server with a software authenticator (a real P-256 key,
// real CBOR, real signatures), so @simplewebauthn's own checks run — nothing
// on the verification path is mocked.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-web-'));
process.env.SANDBOXES_DIR = STATE;
fs.mkdirSync(path.join(STATE, 'sb'));
fs.writeFileSync(path.join(STATE, 'sb', 'sandbox.json'), JSON.stringify({ name: 'sb', workspace: '/tmp/sb' }));

const { canonical, createAuth, createEnrollToken, SESSION_TTL_MS } = await import('../plugins/web/auth.mjs');
const { createServer } = await import('../plugins/web/server.mjs');
const { webOrigin } = await import('../plugins/web/plugin.mjs');

const RP = 'mac.tail0.ts.net';
const ORIGIN = `https://${RP}:8737`;
const OWNER = 'owner@example.com';
const b64u = (b) => Buffer.from(b).toString('base64url');

// --- a software authenticator -----------------------------------------------

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

class SoftAuthenticator {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    this.credId = crypto.randomBytes(16);
    this.id = b64u(this.credId);
  }

  authData(rpId, flags, attested) {
    const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.alloc(4)];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, this.cose);
    }
    return Buffer.concat(parts);
  }

  create(options, { origin = ORIGIN, uv = true } = {}) {
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40; // UP, UV, AT
    const attestation = cbor({ fmt: 'none', attStmt: {}, authData: this.authData(options.rp.id, flags, true) });
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation), transports: ['internal'] },
    };
  }

  get(options, { origin = ORIGIN, uv = true } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const ad = this.authData(options.rpId, 0x01 | (uv ? 0x04 : 0), false);
    const sig = crypto.sign('sha256', Buffer.concat([ad, crypto.createHash('sha256').update(clientData).digest()]), this.key);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig) },
    };
  }
}

// --- a server per test --------------------------------------------------------

let clock = Date.now();
// A failed assertion skips the test's own close(); without this the open
// server keeps the whole run alive.
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));

async function start() {
  const dir = fs.mkdtempSync(path.join(STATE, 'web-'));
  const auth = createAuth({ rpId: RP, origin: ORIGIN, dir, now: () => clock });
  const calls = [];
  const server = createServer({
    allow: [OWNER], auth, fqdn: () => RP, log: () => {},
    run: async (args) => { calls.push(args); return { ok: true, output: '' }; },
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, { body, cookie, csrf, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { origin: ORIGIN, 'x-vivary': '1', 'sec-fetch-site': 'same-origin', 'tailscale-user-login': OWNER, ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    if (cookie) h.cookie = cookie;
    if (csrf) h['x-csrf-token'] = csrf;
    const data = body === undefined ? null : JSON.stringify(body);
    if (data) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data); // Node sends a DELETE body unframed otherwise
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        const setCookie = res.headers['set-cookie']?.[0] || null;
        resolve({ status: res.status ?? res.statusCode, json, text, headers: res.headers, setCookie,
          cookie: setCookie ? setCookie.split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { dir, calls, call, close: () => { server.closeAllConnections(); server.close(); } };
}

// The whole first-passkey flow, as the page does it after `vivary web enroll`.
async function enroll(t, authn = new SoftAuthenticator(), name = 'Mac') {
  const token = createEnrollToken({ origin: ORIGIN, dir: t.dir, now: clock });
  const o = await t.call('POST', '/api/auth/enroll/options', { body: { token } });
  assert.equal(o.status, 200, o.text);
  const r = await t.call('POST', '/api/auth/enroll', {
    body: { token, challengeId: o.json.challengeId, response: authn.create(o.json.options), name },
  });
  assert.equal(r.status, 200, r.text);
  return { authn, token, cookie: r.cookie, setCookie: r.setCookie };
}

async function login(t, authn, opts) {
  const o = await t.call('POST', '/api/auth/login/options', { body: {} });
  assert.equal(o.status, 200, o.text);
  const r = await t.call('POST', '/api/auth/login', { body: { challengeId: o.json.challengeId, response: authn.get(o.json.options, opts) } });
  return r;
}

async function session(t, authn) {
  const r = await login(t, authn);
  assert.equal(r.status, 200, r.text);
  const s = await t.call('GET', '/api/auth/status', { cookie: r.cookie });
  return { cookie: r.cookie, csrf: s.json.csrf };
}

async function stepUp(t, s, authn, action, payload) {
  const o = await t.call('POST', '/api/auth/stepup', { ...s, body: { action, payload } });
  assert.equal(o.status, 200, o.text);
  return { challengeId: o.json.challengeId, response: authn.get(o.json.options) };
}

const sshKey = () => `ssh-ed25519 ${crypto.randomBytes(51).toString('base64')} test`;

// --- tests ----------------------------------------------------------------------

test('nothing works before the first passkey; the page says so', async () => {
  const t = await start();
  const st = await t.call('GET', '/api/auth/status');
  assert.deepEqual([st.json.configured, st.json.authenticated, st.json.origin], [false, false, ORIGIN]);
  assert.equal((await t.call('POST', '/api/auth/login/options', { body: {} })).status, 409);
  assert.equal((await t.call('GET', '/api/state')).status, 401);
  t.close();
});

test('enrollment: only with the token from the Mac, once; cookie is HttpOnly/Secure/Strict', async () => {
  const t = await start();
  assert.equal((await t.call('POST', '/api/auth/enroll/options', { body: { token: 'x'.repeat(43) } })).status, 403);
  const { token, setCookie } = await enroll(t);
  assert.match(setCookie, /^__Host-vivary=/);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(attr), attr);
  // one use
  assert.equal((await t.call('POST', '/api/auth/enroll/options', { body: { token } })).status, 403);
  assert.ok(!fs.existsSync(path.join(t.dir, 'enroll.json')));
  // what is stored: public keys only, owner-only file, no token
  const file = path.join(t.dir, 'passkeys.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes(token));
  assert.equal(JSON.parse(stored).passkeys[0].name, 'Mac');
  t.close();
});

test('an expired enrollment link is refused, and so is one made for another address', async () => {
  const t = await start();
  const old = createEnrollToken({ origin: ORIGIN, dir: t.dir, now: clock - 11 * 60 * 1000 });
  assert.equal((await t.call('POST', '/api/auth/enroll/options', { body: { token: old } })).status, 403);
  const other = createEnrollToken({ origin: 'http://localhost:7378', dir: t.dir, now: clock });
  const r = await t.call('POST', '/api/auth/enroll/options', { body: { token: other } });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /made for http:\/\/localhost/);
  t.close();
});

test('login gives a session; changes need its CSRF token and our origin', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  const s = await session(t, authn);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/up', { cookie: s.cookie, body: {} })).status, 403); // no CSRF
  assert.equal((await t.call('POST', '/api/sandboxes/sb/up', {
    ...s, body: {}, headers: { origin: 'https://evil.example' },
  })).status, 403);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/up', { ...s, body: {}, headers: { 'x-vivary': null } })).status, 403);
  const ok = await t.call('POST', '/api/sandboxes/sb/up', { ...s, body: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(t.calls, [['up', '--name', 'sb']]);
  t.close();
});

test('no session = no access, whatever the headers say (a sandbox reaching loopback)', async () => {
  const t = await start();
  await enroll(t);
  // An allowed tailnet login header (spoofable on raw loopback) is not a login.
  assert.equal((await t.call('GET', '/api/state')).status, 401);
  // No header at all used to mean "someone on the Mac = owner".
  assert.equal((await t.call('GET', '/api/state', { headers: { 'tailscale-user-login': null } })).status, 401);
  assert.equal((await t.call('POST', '/api/sandboxes/sb/down', { body: {}, headers: { 'tailscale-user-login': null } })).status, 401);
  assert.deepEqual(t.calls, []);
  t.close();
});

test('a tailnet login not on the allowlist is refused even with a valid session', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  const s = await session(t, authn);
  const r = await t.call('GET', '/api/auth/status', { ...s, headers: { 'tailscale-user-login': 'intruder@example.com' } });
  assert.equal(r.status, 403);
  t.close();
});

test('refused: no user verification, another origin (phishing), a replayed challenge, an unknown key', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  assert.equal((await login(t, authn, { uv: false })).status, 403);
  assert.equal((await login(t, authn, { origin: 'https://vivary-login.example' })).status, 403);

  const o = await t.call('POST', '/api/auth/login/options', { body: {} });
  const body = { challengeId: o.json.challengeId, response: authn.get(o.json.options) };
  assert.equal((await t.call('POST', '/api/auth/login', { body })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/login', { body })).status, 403); // single use

  assert.equal((await login(t, new SoftAuthenticator())).status, 403);
  t.close();
});

test('step-up is bound to the exact device key, to the session, and works once', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  const s = await session(t, authn);
  const k1 = sshKey();
  const k2 = sshKey();

  // no step-up at all
  assert.equal((await t.call('POST', '/api/devices', { ...s, body: { name: 'ipad', key: k1 } })).status, 403);
  // a touch made for another key
  const forK2 = await stepUp(t, s, authn, 'device-add', { name: 'ipad', key: k2 });
  const wrong = await t.call('POST', '/api/devices', { ...s, body: { name: 'ipad', key: k1, stepUp: forK2 } });
  assert.equal(wrong.status, 403);
  assert.match(wrong.json.error, /different action/);
  // a touch made in another session
  const other = await session(t, authn);
  const foreign = await stepUp(t, other, authn, 'device-add', { name: 'ipad', key: k1 });
  assert.equal((await t.call('POST', '/api/devices', { ...s, body: { name: 'ipad', key: k1, stepUp: foreign } })).status, 403);
  assert.deepEqual(t.calls, []);

  const good = await stepUp(t, s, authn, 'device-add', { name: 'ipad', key: k1 });
  const ok = await t.call('POST', '/api/devices', { ...s, body: { name: 'ipad', key: k1, stepUp: good } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(t.calls, [['key', 'add', 'ipad', '--key', k1]]);
  assert.equal((await t.call('POST', '/api/devices', { ...s, body: { name: 'ipad', key: k1, stepUp: good } })).status, 403);
  // only known actions get a challenge
  assert.equal((await t.call('POST', '/api/auth/stepup', { ...s, body: { action: 'rm-rf', payload: {} } })).status, 400);
  t.close();
});

test('sessions end after 12 h, on logout, and on "sign out everywhere"', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  const s = await session(t, authn);
  clock += SESSION_TTL_MS + 1000;
  assert.equal((await t.call('GET', '/api/state', s)).status, 401);

  const a = await session(t, authn);
  assert.equal((await t.call('POST', '/api/auth/logout', { ...a, body: {} })).status, 200);
  assert.equal((await t.call('GET', '/api/state', a)).status, 401);

  const b = await session(t, authn);
  const c = await session(t, authn);
  assert.equal((await t.call('POST', '/api/auth/logout-all', { ...b, body: {} })).status, 200);
  assert.equal((await t.call('GET', '/api/auth/status', c)).json.authenticated, false);
  t.close();
});

test('a second passkey: added with a step-up; removing it ends the sessions it opened', async () => {
  const t = await start();
  const { authn } = await enroll(t);
  const s = await session(t, authn);
  const phone = new SoftAuthenticator();

  assert.equal((await t.call('POST', '/api/auth/passkeys/options', { ...s, body: { name: 'pixel' } })).status, 403);
  const proof = await stepUp(t, s, authn, 'passkey-add', { name: 'pixel' });
  const o = await t.call('POST', '/api/auth/passkeys/options', { ...s, body: { name: 'pixel', stepUp: proof } });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.json.options.excludeCredentials.length, 1); // the Mac's one: no duplicates
  const add = await t.call('POST', '/api/auth/passkeys', { ...s, body: { challengeId: o.json.challengeId, response: phone.create(o.json.options) } });
  assert.equal(add.status, 200, add.text);

  const p = await session(t, phone);
  const list = (await t.call('GET', '/api/auth/status', s)).json.passkeys;
  assert.deepEqual(list.map((x) => x.name).sort(), ['Mac', 'pixel']);

  const rmProof = await stepUp(t, s, authn, 'passkey-remove', { id: phone.id });
  const rm = await t.call('DELETE', `/api/auth/passkeys/${phone.id}`, { ...s, body: { stepUp: rmProof } });
  assert.equal(rm.status, 200, rm.text);
  assert.equal(rm.json.ended, 1);
  assert.equal((await t.call('GET', '/api/state', p)).status, 401);
  assert.equal((await login(t, phone)).status, 403);
  t.close();
});

test('the page runs no inline script and comes with a strict CSP', async () => {
  const t = await start();
  const page = await t.call('GET', '/');
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(page.text, /<style|\sstyle=/);
  assert.equal((await t.call('GET', '/assets/app.js')).status, 200);
  assert.equal((await t.call('GET', '/assets/../auth.mjs')).status, 404);
  assert.equal((await t.call('GET', '/assets/auth.mjs')).status, 404);
  t.close();
});

test('one address per mode: HTTPS on the tailnet name, else localhost', () => {
  assert.deepEqual(webOrigin({ fqdn: RP, tailnetPort: 8737, port: 7378 }),
    { origin: ORIGIN, rpId: RP, secure: true });
  assert.equal(webOrigin({ fqdn: RP, tailnetPort: 443, port: 7378 }).origin, `https://${RP}`);
  assert.deepEqual(webOrigin({ fqdn: null, tailnetPort: 8737, port: 7378 }),
    { origin: 'http://localhost:7378', rpId: 'localhost', secure: false });
});

test('the step-up digest does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), canonical({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
});

test('a corrupt passkey file stops the server instead of reopening enrollment', () => {
  const dir = fs.mkdtempSync(path.join(STATE, 'web-'));
  fs.writeFileSync(path.join(dir, 'passkeys.json'), '{ broken');
  const auth = createAuth({ rpId: RP, origin: ORIGIN, dir });
  assert.throws(() => auth.configured(), /cannot read/);
});
