// Passkey login for `vivary web`: enrollment from the Mac, sessions, CSRF and a
// step-up that is bound to the one action it authorizes.
//
// Why each piece is shaped the way it is:
// - The FIRST passkey (and every recovery) comes only from `vivary web enroll`
//   on the Mac: it writes the HASH of a one-time token here and opens the page
//   with the token in the URL fragment. No "first visitor becomes the owner",
//   no recovery codes — physical access to the Mac is the recovery factor.
// - Every API request needs a session, loopback included. "No Tailscale header
//   = someone on the Mac" was the old rule, but a docker-runtime sandbox reaches
//   the host's loopback via host.docker.internal and can send any header there.
// - Sessions live in memory only: a restart of `vivary web` logs everyone out
//   (one Face ID away), and no session secret is ever written to disk.
// - Step-up challenges carry a digest of the exact request they authorize, so a
//   stolen session cannot reuse a touch meant for something else.
// - Nothing secret is stored in plaintext: passkeys are public keys, the
//   enrollment token is kept as a hash, sessions are keyed by hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_DIR, SANDBOXES_DIR } from '../../core/util.mjs';

export const webDir = () => path.join(SANDBOXES_DIR, '.web');
export const SESSION_TTL_MS = 12 * 3600 * 1000;
export const ENROLL_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const MAX_CHALLENGES = 200;
const MAX_BAD_ENROLL_TOKENS = 10;

// Actions a step-up can authorize. Anything else is refused at the options step.
// settings: a `vivary set` change; recreate: throws away the container's
// contents; config-approve: the exact .vivary.json content (its sha256).
export const STEP_UP_ACTIONS = new Set(['device-add', 'passkey-add', 'passkey-remove', 'settings', 'recreate', 'config-approve']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Loaded lazily: every `vivary` command loads every plugin, and only `vivary
// web` needs the WebAuthn library — a checkout without `npm install` must
// still run everything else.
let libPromise = null;
export function webauthnLib() {
  libPromise ||= import('@simplewebauthn/server').catch((e) => {
    libPromise = null;
    throw new Error(`cannot load @simplewebauthn/server (${e.code || e.message}) — run: npm install --prefix ${CLI_DIR}`);
  });
  return libPromise;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const randomToken = (bytes = 32) => b64u(crypto.randomBytes(bytes));

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Stable JSON (sorted keys) so the same request always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
export const actionDigest = (action, payload) => sha256(canonical({ action, payload }));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // A corrupt passkey file must not read as "no passkeys" — that would turn
    // the page into an open enrollment. Fail loudly instead.
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- files shared with the CLI side (`vivary web enroll`) -------------------

const passkeysFile = (dir) => path.join(dir, 'passkeys.json');
const enrollFile = (dir) => path.join(dir, 'enroll.json');
const serverFile = (dir) => path.join(dir, 'server.json');

// Where the running server can be reached — `vivary web enroll` needs the
// origin, because a passkey is bound to it.
export function writeServerInfo(info, dir = webDir()) {
  writeJson(serverFile(dir), { ...info, pid: process.pid });
}

export function clearServerInfo(dir = webDir()) {
  const cur = readJson(serverFile(dir), null);
  if (cur?.pid === process.pid) fs.rmSync(serverFile(dir), { force: true });
}

export function readServerInfo(dir = webDir()) {
  const info = readJson(serverFile(dir), null);
  if (!info?.pid) return null;
  try {
    process.kill(info.pid, 0);
  } catch {
    return null; // stale: that server is gone
  }
  return info;
}

// The one-time enrollment token. Only its hash is stored; the token itself
// travels in the URL fragment of the page `vivary web enroll` opens.
export function createEnrollToken({ origin, dir = webDir(), now = Date.now(), ttlMs = ENROLL_TTL_MS } = {}) {
  const token = randomToken();
  writeJson(enrollFile(dir), { hash: sha256(token), origin, expiresAt: now + ttlMs, badAttempts: 0 });
  return token;
}

// --- the auth service --------------------------------------------------------

export function createAuth({
  rpId, origin, rpName = 'vivary', secureCookie = true, dir = webDir(),
  now = () => Date.now(), log = () => {},
} = {}) {
  if (!rpId || !origin) throw new Error('createAuth needs rpId and origin');
  const cookieName = secureCookie ? '__Host-vivary' : 'vivary';
  const sessions = new Map(); // sha256(token) -> session
  const challenges = new Map(); // challengeId -> { challenge, purpose, ... }

  const store = () => {
    const s = readJson(passkeysFile(dir), null) || { version: 1, userId: null, passkeys: [] };
    if (!s.userId) s.userId = randomToken(16);
    return s;
  };
  const mine = (s) => s.passkeys.filter((p) => p.rpId === rpId);
  const configured = () => mine(store()).length > 0;

  // ---- challenges

  function putChallenge(entry) {
    const t = now();
    for (const [id, c] of challenges) if (c.expiresAt <= t) challenges.delete(id);
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const id = randomToken(16);
    challenges.set(id, { ...entry, expiresAt: t + CHALLENGE_TTL_MS });
    return id;
  }

  // Single use: taken out before anything is checked, so a failed attempt
  // cannot be retried with the same challenge.
  function takeChallenge(id, purpose) {
    const c = challenges.get(String(id || ''));
    challenges.delete(String(id || ''));
    if (!c || c.purpose !== purpose || c.expiresAt <= now()) {
      throw new HttpError(403, 'passkey challenge unknown or expired — try again');
    }
    return c;
  }

  // ---- sessions

  function newSession(credentialId) {
    const token = randomToken();
    const t = now();
    const session = {
      key: sha256(token), csrf: randomToken(), credentialId, createdAt: t, expiresAt: t + SESSION_TTL_MS,
    };
    sessions.set(session.key, session);
    return { session, cookie: sessionCookie(token, SESSION_TTL_MS / 1000) };
  }

  function sessionCookie(value, maxAge) {
    return [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`,
      ...(secureCookie ? ['Secure'] : [])].join('; ');
  }

  function sessionFor(req) {
    const raw = String(req.headers.cookie || '');
    const m = raw.split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === cookieName);
    if (!m) return null;
    const key = sha256(m.slice(1).join('='));
    const s = sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return s;
  }

  // For what outlives a request (a VNC WebSocket): is this session still the
  // live one? False after logout, "sign out everywhere", removal of its
  // passkey, expiry — and after a restart, which empties the map.
  function sessionAlive(session) {
    return !!session && sessions.get(session.key) === session && session.expiresAt > now();
  }

  function checkCsrf(req, session) {
    if (!safeEqual(req.headers['x-csrf-token'], session.csrf)) {
      throw new HttpError(403, 'missing or wrong CSRF token — reload the page');
    }
  }

  // ---- WebAuthn

  async function registrationOptions(s, purposeEntry) {
    const lib = await webauthnLib();
    const options = await lib.generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: 'vivary',
      userDisplayName: `vivary on ${rpId}`,
      userID: Buffer.from(s.userId, 'base64url'),
      attestationType: 'none',
      excludeCredentials: mine(s).map((p) => ({ id: p.id, transports: p.transports })),
      // Discoverable (so login needs no list of credential ids) and always with
      // Face ID / Touch ID / PIN — presence alone is not enough here.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = putChallenge({ ...purposeEntry, challenge: options.challenge });
    return { challengeId, options };
  }

  async function verifyRegistration(c, response, name) {
    const lib = await webauthnLib();
    let r;
    try {
      r = await lib.verifyRegistrationResponse({
        response,
        expectedChallenge: c.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new HttpError(400, `passkey registration refused: ${e.message}`);
    }
    if (!r.verified) throw new HttpError(400, 'passkey registration refused');
    const { credential, credentialDeviceType, credentialBackedUp } = r.registrationInfo;
    const s = store();
    if (s.passkeys.some((p) => p.id === credential.id)) throw new HttpError(409, 'this passkey is already registered');
    const t = now();
    const entry = {
      id: credential.id,
      publicKey: b64u(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      rpId,
      name: cleanName(name) || `passkey ${mine(s).length + 1}`,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: t,
      lastUsedAt: t,
    };
    s.passkeys.push(entry);
    writeJson(passkeysFile(dir), s);
    return entry;
  }

  async function authenticationOptions(entry) {
    const lib = await webauthnLib();
    // Empty allowCredentials: passkeys are discoverable, and an anonymous
    // caller learns nothing about which credentials exist.
    const options = await lib.generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' });
    return { challengeId: putChallenge({ ...entry, challenge: options.challenge }), options };
  }

  async function verifyAssertion(c, response) {
    const s = store();
    const pk = mine(s).find((p) => p.id === response?.id);
    if (!pk) throw new HttpError(403, 'unknown passkey for this vivary');
    const lib = await webauthnLib();
    let r;
    try {
      r = await lib.verifyAuthenticationResponse({
        response,
        expectedChallenge: c.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
        credential: {
          id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports,
        },
      });
    } catch (e) {
      throw new HttpError(403, `passkey refused: ${e.message}`);
    }
    if (!r.verified) throw new HttpError(403, 'passkey refused');
    pk.counter = r.authenticationInfo.newCounter;
    pk.lastUsedAt = now();
    writeJson(passkeysFile(dir), s);
    return pk;
  }

  // ---- enrollment token

  function checkEnrollToken(token) {
    const e = readJson(enrollFile(dir), null);
    if (!e) throw new HttpError(403, 'no enrollment pending — run `vivary web enroll` on the Mac');
    if (e.expiresAt <= now()) {
      fs.rmSync(enrollFile(dir), { force: true });
      throw new HttpError(403, 'enrollment link expired — run `vivary web enroll` again');
    }
    if (e.origin && e.origin !== origin) {
      throw new HttpError(403, `this enrollment was made for ${e.origin}`);
    }
    if (!safeEqual(sha256(String(token || '')), e.hash)) {
      e.badAttempts = (e.badAttempts || 0) + 1;
      if (e.badAttempts >= MAX_BAD_ENROLL_TOKENS) fs.rmSync(enrollFile(dir), { force: true });
      else writeJson(enrollFile(dir), e);
      throw new HttpError(403, 'enrollment link not valid — run `vivary web enroll` again');
    }
    return e.hash;
  }

  // ---- step-up

  async function stepUpOptions(session, action, payload) {
    if (!STEP_UP_ACTIONS.has(action)) throw new HttpError(400, `no step-up for '${action}'`);
    return authenticationOptions({
      purpose: 'stepup', sessionKey: session.key, action, digest: actionDigest(action, payload),
    });
  }

  // Called by the route that performs the action, with the payload it is about
  // to act on — not the one the client claims it asked for.
  async function consumeStepUp(session, action, payload, stepUp) {
    if (!stepUp?.challengeId || !stepUp?.response) {
      throw new HttpError(403, 'this needs a fresh passkey confirmation');
    }
    const c = takeChallenge(stepUp.challengeId, 'stepup');
    if (c.sessionKey !== session.key || c.action !== action || c.digest !== actionDigest(action, payload)) {
      throw new HttpError(403, 'the passkey confirmation was for a different action');
    }
    return verifyAssertion(c, stepUp.response);
  }

  // ---- the routes under /api/auth/

  // Returns { status, body, cookie? } or null when the path is not ours.
  async function route(req, p, body) {
    const session = sessionFor(req);
    const who = req.headers['tailscale-user-login'] || 'local';

    if (req.method === 'GET' && p === '/api/auth/status') {
      const out = { configured: configured(), authenticated: !!session, origin, rpId };
      if (session) {
        out.csrf = session.csrf;
        out.passkeys = mine(store()).map((pk) => ({
          id: pk.id, name: pk.name, createdAt: pk.createdAt, lastUsedAt: pk.lastUsedAt,
          backedUp: !!pk.backedUp, current: pk.id === session.credentialId,
        }));
      }
      return { status: 200, body: out };
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') return null;

    if (p === '/api/auth/enroll/options') {
      const tokenHash = checkEnrollToken(body.token);
      return { status: 200, body: await registrationOptions(store(), { purpose: 'enroll', tokenHash }) };
    }
    if (p === '/api/auth/enroll') {
      const c = takeChallenge(body.challengeId, 'enroll');
      if (!safeEqual(checkEnrollToken(body.token), c.tokenHash)) throw new HttpError(403, 'enrollment link changed');
      const pk = await verifyRegistration(c, body.response, body.name);
      fs.rmSync(enrollFile(dir), { force: true }); // one use
      log(`${who} enrolled passkey '${pk.name}' (via vivary web enroll)`);
      const { cookie } = newSession(pk.id);
      return { status: 200, body: { ok: true }, cookie };
    }
    if (p === '/api/auth/login/options') {
      if (!configured()) throw new HttpError(409, 'no passkey yet — run `vivary web enroll` on the Mac');
      return { status: 200, body: await authenticationOptions({ purpose: 'login' }) };
    }
    if (p === '/api/auth/login') {
      const c = takeChallenge(body.challengeId, 'login');
      let pk;
      try {
        pk = await verifyAssertion(c, body.response);
      } catch (e) {
        log(`${who} login REFUSED: ${e.message}`);
        throw e;
      }
      log(`${who} logged in with '${pk.name}'`);
      const { cookie } = newSession(pk.id);
      return { status: 200, body: { ok: true }, cookie };
    }

    // Everything below acts on an existing session.
    if (!session) throw new HttpError(401, 'not logged in');
    checkCsrf(req, session);

    if (p === '/api/auth/logout') {
      sessions.delete(session.key);
      return { status: 200, body: { ok: true }, cookie: sessionCookie('', 0) };
    }
    if (p === '/api/auth/logout-all') {
      sessions.clear();
      log(`${who} signed out every session`);
      return { status: 200, body: { ok: true }, cookie: sessionCookie('', 0) };
    }
    if (p === '/api/auth/stepup') {
      return { status: 200, body: await stepUpOptions(session, String(body.action || ''), body.payload ?? null) };
    }
    if (p === '/api/auth/passkeys/options') {
      // The digest covers the name exactly as sent; it is cleaned afterwards.
      const raw = String(body.name ?? '');
      await consumeStepUp(session, 'passkey-add', { name: raw }, body.stepUp);
      const name = cleanName(raw);
      return { status: 200, body: await registrationOptions(store(), { purpose: 'add', sessionKey: session.key, name }) };
    }
    if (p === '/api/auth/passkeys' && req.method === 'POST') {
      const c = takeChallenge(body.challengeId, 'add');
      if (c.sessionKey !== session.key) throw new HttpError(403, 'that challenge belongs to another session');
      const pk = await verifyRegistration(c, body.response, c.name);
      log(`${who} added passkey '${pk.name}'`);
      return { status: 200, body: { ok: true, name: pk.name } };
    }
    const rm = p.match(/^\/api\/auth\/passkeys\/([A-Za-z0-9_-]+)$/);
    if (rm && req.method === 'DELETE') {
      const id = rm[1];
      const pk = mine(store()).find((x) => x.id === id);
      if (!pk) throw new HttpError(404, 'unknown passkey');
      await consumeStepUp(session, 'passkey-remove', { id }, body.stepUp);
      const s = store(); // re-read: the step-up just updated a counter
      s.passkeys = s.passkeys.filter((x) => x.id !== id);
      writeJson(passkeysFile(dir), s);
      // A removed passkey (lost device) must not leave its sessions behind.
      let ended = 0;
      for (const [k, x] of sessions) if (x.credentialId === id) { sessions.delete(k); ended++; }
      log(`${who} removed passkey '${pk.name}' (${ended} session(s) ended)`);
      return { status: 200, body: { ok: true, ended } };
    }
    return null;
  }

  return { route, sessionFor, sessionAlive, checkCsrf, consumeStepUp, configured, cookieName, origin, rpId };
}

// Display names only: letters, digits, spaces and a little punctuation.
function cleanName(v) {
  return String(v ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40);
}
