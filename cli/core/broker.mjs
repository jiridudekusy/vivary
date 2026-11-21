// Host-side broker kernel: HTTP server with token auth and an audit log.
// Routes are contributed by plugins (host-open, clipboard, ...). Containers
// reach it via host.docker.internal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_DIR, SANDBOXES_DIR, capture, die } from './util.mjs';
import { loadSandbox, listSandboxNames, sandboxDir } from './sandbox.mjs';
import { getPlugins } from './plugins.mjs';
import { putRunSecret } from './runsecrets.mjs';

export const BROKER_DIR = path.join(SANDBOXES_DIR, '.broker');
export const BROKER_PORT = Number(process.env.SBX_BROKER_PORT || 7377);

// Per-sandbox broker token. Each sandbox has its own random token, held only
// by that sandbox. The broker authorizes a request by matching the token back
// to its sandbox, so the capabilities a request runs with are bound to the
// token holder — never to a client-supplied name, which any sandbox could
// forge to borrow another sandbox's host-open / clipboard access.
//
// The token is never stored (vault step, 2026-11-21). Every container start
// makes a fresh one: the Mac keeps only its sha256 (broker-token.sha256, not a
// secret), and the token itself goes into the container through `exec` onto a
// tmpfs at /run/vivary — RAM only. It used to be a file here AND a `-e`
// variable baked into the container's config (Apple's config.json, `docker
// inspect`), i.e. in plaintext on the Mac's disk twice.
//
// LEGACY: a kept container created before this has the old token baked into
// its env and no /run/vivary tmpfs. Its plaintext `broker-token` file keeps
// working until the container is recreated; tart guests use it too (their
// env file is written into the VM at boot).
const tokenFile = (name) => path.join(sandboxDir(name), 'broker-token');
const hashFile = (name) => path.join(sandboxDir(name), 'broker-token.sha256');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// The legacy plaintext token (tart, and containers from before).
export function sandboxBrokerToken(name) {
  const file = tokenFile(name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// A fresh token for one container run: only its hash is kept.
export function issueBrokerToken(name) {
  const token = crypto.randomBytes(24).toString('hex');
  writeHash(name, token);
  return token;
}

// Put a fresh token into a started container. 'tmpfs' when it went to RAM;
// 'legacy' for a container without the tmpfs (created before), which keeps
// the token baked into its env.
export function deliverBrokerToken(cfg, runtime, cname, { run = capture, probed } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  // Hash first: the moment the file appears inside, it must already work.
  const prev = readHashFile(cfg.name);
  writeHash(cfg.name, token);
  let mode;
  try {
    mode = putRunSecret(runtime, cname, 'broker-token', token, { run, probed });
  } catch (e) {
    restoreHash(cfg.name, prev);
    throw e;
  }
  if (mode === 'legacy') {
    restoreHash(cfg.name, prev);
    sandboxBrokerToken(cfg.name);
    return 'legacy';
  }
  // The container has the new scheme, so the old plaintext token is dead.
  fs.rmSync(tokenFile(cfg.name), { force: true });
  return 'tmpfs';
}

function readHashFile(name) {
  try { return fs.readFileSync(hashFile(name), 'utf8'); } catch { return null; }
}
function writeHash(name, token) {
  fs.mkdirSync(sandboxDir(name), { recursive: true });
  fs.writeFileSync(hashFile(name), `${sha256(token)}\n`, { mode: 0o600 });
}
function restoreHash(name, prev) {
  if (prev === null) fs.rmSync(hashFile(name), { force: true });
  else fs.writeFileSync(hashFile(name), prev, { mode: 0o600 });
}

// The sha256s that currently authorize a sandbox. A missing file is an
// ordinary miss. Any other failure is logged: when the Mac runs out of file
// handles this read is what fails, and swallowing it turned ENFILE into
// "DENIED bad token" — on 2026-10-18 two running sandboxes were denied at the
// same instant 36 s before a watchdog reset, and the log had no ENFILE line to
// say why.
function readHashes(name) {
  const out = [];
  for (const [file, hashed] of [[hashFile(name), true], [tokenFile(name), false]]) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) out.push(hashed ? v : sha256(v));
    } catch (e) {
      if (e?.code !== 'ENOENT') brokerError(`token read for '${name}'`, e);
    }
  }
  return out;
}

// token -> sandbox name. Resolving a token used to walk EVERY sandbox dir
// (a stat each) and read EVERY token file on EVERY request — ~80 file
// operations, several times a second per sandbox, since clipboard sync polls.
// That made the broker the busiest file-opener on the Mac, so it was the first
// thing to hit ENFILE when sandbox VMs had pinned the host's vnodes — and 18
// times between 2026-09-04 and 2026-10-06 the uncaught error killed it, leaving
// clipboard/host-open dead until the next `vivary` command restarted it.
//
// The map is rebuilt only on a miss (a sandbox created since), at most once
// per REBUILD_MS so a stream of bad tokens cannot turn it back into a scan per
// request. A hit is re-checked against that one sandbox's token file, so a
// token from a purged and re-created sandbox of the same name stops working.
const REBUILD_MS = 5000;
const tokenCache = { map: new Map(), builtAt: 0 };

function rebuildTokenCache(now) {
  const map = new Map();
  for (const name of listSandboxNames()) {
    for (const h of readHashes(name)) map.set(h, name);
  }
  tokenCache.map = map;
  tokenCache.builtAt = now;
}

// Resolve the sandbox whose broker token is the presented one. Only hashes
// are compared (a map lookup on sha256(token)), so no timing side channel on
// the token itself. Returns null if none matches.
export function sandboxByToken(presented, { now = Date.now() } = {}) {
  if (!presented) return null;
  const want = sha256(presented);
  let name = tokenCache.map.get(want);
  if (!name && now - tokenCache.builtAt >= REBUILD_MS) {
    rebuildTokenCache(now);
    name = tokenCache.map.get(want);
  }
  if (!name) return null;
  if (!readHashes(name).includes(want)) {
    tokenCache.builtAt = 0; // stale entry: force a rebuild on the next miss
    return null;
  }
  return loadSandbox(name);
}

export function resetTokenCache() {
  tokenCache.map = new Map();
  tokenCache.builtAt = 0;
}

export function brokerLog(line) {
  fs.mkdirSync(BROKER_DIR, { recursive: true });
  fs.appendFileSync(path.join(BROKER_DIR, 'broker.log'),
    `${new Date().toISOString()} ${line}\n`);
}

// One greppable line per error. ENFILE gets its own tag and a pointer: it means
// the whole Mac ran out of file handles, which `vivary stats` counts from here.
export function brokerError(where, e) {
  const code = e?.code || e?.name || 'Error';
  const line = code === 'ENFILE'
    ? `ENFILE ${where}: the Mac is out of file handles (${e.message}) — see vivary stats`
    : `ERROR ${where}: ${code} ${e?.message || e}`;
  try {
    brokerLog(line);
  } catch {
    // Logging needs a file handle too; under ENFILE stderr is all that is left.
    console.error(line);
  }
}

async function brokerHealthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${BROKER_PORT}/health`,
      { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Spawn the broker detached if it isn't already running.
export async function ensureBroker() {
  if (!(await brokerHealthy())) {
    fs.mkdirSync(BROKER_DIR, { recursive: true });
    const log = fs.openSync(path.join(BROKER_DIR, 'broker.log'), 'a');
    spawn(process.execPath, [path.join(CLI_DIR, 'vivary.mjs'), 'broker'],
      { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 20 && !(await brokerHealthy()); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!(await brokerHealthy())) die(`broker failed to start (see ${BROKER_DIR}/broker.log)`);
    console.log(`==> vivary broker started on port ${BROKER_PORT}`);
  }
  return { url: `http://host.docker.internal:${BROKER_PORT}/` };
}

// Broker announcement for the sandbox (when any enabled plugin needs it) —
// as an env object; brokerEnvArgs renders the docker-args form.
// Only the URL: the token is in /run/vivary (or, legacy, already in the
// container's own env), and an exec'd process does not need it in its env.
export const brokerNeeded = (cfg) => getPlugins().some((p) => p.needsBroker?.(cfg));

export async function brokerEnvVars(cfg) {
  if (!brokerNeeded(cfg)) return {};
  const { url } = await ensureBroker();
  return { SBX_OPEN_URL: url };
}

// Run args for a NEW container: the URL; the token goes onto its tmpfs after
// the start (deliverBrokerToken). A throwaway --rm run starts its payload at
// once, before anything could be delivered, so it carries a fresh token in
// its env instead — its config is deleted with it.
export async function brokerEnvArgs(cfg, { rm = false } = {}) {
  const env = await brokerEnvVars(cfg);
  if (!env.SBX_OPEN_URL) return [];
  if (rm) env.SBX_OPEN_TOKEN = issueBrokerToken(cfg.name);
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

export function cmdBroker(argv) {
  const pidFile = path.join(BROKER_DIR, 'broker.pid');
  if (argv[0] === 'stop') {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
      console.log('==> broker stopped');
    } catch {
      console.log('broker is not running');
    }
    return;
  }
  fs.mkdirSync(BROKER_DIR, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  // Stay up. A dead broker is invisible from the sandbox side — clipboard and
  // host-open just stop — and nothing restarts it until the next `vivary`
  // command (measured gaps: minutes to 30 hours). Per-request errors are
  // caught in the handler; these catch what escapes from async plugin work.
  // Continuing after an unknown error risks a leak; dying risked a day without
  // the broker, which is the worse trade for a stateless request handler.
  process.on('uncaughtException', (e) => brokerError('uncaught', e));
  process.on('unhandledRejection', (e) => brokerError('unhandled rejection', e));

  const server = http.createServer((req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true });

    const dispatch = (params) => {
      const sandbox = sandboxByToken(params.get('token'));
      if (!sandbox) {
        brokerLog(`DENIED bad token from ${req.socket.remoteAddress}`);
        return respond(403, { ok: false, error: 'bad token' });
      }
      const ctx = { req, res, respond, params, log: brokerLog, sandbox };
      for (const p of getPlugins()) {
        if (p.broker && p.broker(ctx)) return;
      }
      respond(404, { ok: false, error: 'no handler' });
    };

    const safeDispatch = (params) => {
      try {
        dispatch(params);
      } catch (e) {
        brokerError(`request ${req.method} from ${req.socket.remoteAddress}`, e);
        if (!res.headersSent) respond(503, { ok: false, error: e.code || 'internal error' });
      }
    };

    if (req.method === 'GET') {
      return safeDispatch(new URL(req.url, 'http://localhost').searchParams);
    }
    if (req.method !== 'POST') return respond(405, { ok: false, error: 'POST only' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => safeDispatch(new URLSearchParams(body)));
  });
  server.listen(BROKER_PORT, '0.0.0.0', () => {
    console.log(`vivary broker listening on :${BROKER_PORT} (log: ${BROKER_DIR}/broker.log)`);
  });
}
