// Host-side broker kernel: HTTP server with token auth and an audit log.
// Routes are contributed by plugins (host-open, clipboard, ...). Containers
// reach it via host.docker.internal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_DIR, SANDBOXES_DIR, die } from './util.mjs';
import { loadSandbox, listSandboxNames, sandboxDir } from './sandbox.mjs';
import { getPlugins } from './plugins.mjs';

export const BROKER_DIR = path.join(SANDBOXES_DIR, '.broker');
export const BROKER_PORT = Number(process.env.SBX_BROKER_PORT || 7377);

// Per-sandbox broker token. Each sandbox gets its own random token, persisted
// in its state dir (0600) and injected only into that container. The broker
// authorizes a request by matching this token back to its sandbox, so the
// capabilities a request runs with are bound to the token holder — never to a
// client-supplied name, which any sandbox could forge to borrow another
// sandbox's host-open / clipboard access.
export function sandboxBrokerToken(name) {
  const file = path.join(sandboxDir(name), 'broker-token');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// Resolve the sandbox whose broker token equals the presented one, comparing in
// constant time. Returns null if none matches.
function sandboxByToken(presented) {
  if (!presented) return null;
  const want = Buffer.from(String(presented));
  for (const name of listSandboxNames()) {
    let tok;
    try {
      tok = fs.readFileSync(path.join(sandboxDir(name), 'broker-token'), 'utf8').trim();
    } catch {
      continue;
    }
    const have = Buffer.from(tok);
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) {
      return loadSandbox(name);
    }
  }
  return null;
}

export function brokerLog(line) {
  fs.mkdirSync(BROKER_DIR, { recursive: true });
  fs.appendFileSync(path.join(BROKER_DIR, 'broker.log'),
    `${new Date().toISOString()} ${line}\n`);
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
export async function brokerEnvVars(cfg) {
  const needed = getPlugins().some((p) => p.needsBroker?.(cfg));
  if (!needed) return {};
  const { url } = await ensureBroker();
  return { SBX_OPEN_URL: url, SBX_OPEN_TOKEN: sandboxBrokerToken(cfg.name) };
}

export async function brokerEnvArgs(cfg) {
  return Object.entries(await brokerEnvVars(cfg)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
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

    if (req.method === 'GET') {
      return dispatch(new URL(req.url, 'http://localhost').searchParams);
    }
    if (req.method !== 'POST') return respond(405, { ok: false, error: 'POST only' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => dispatch(new URLSearchParams(body)));
  });
  server.listen(BROKER_PORT, '0.0.0.0', () => {
    console.log(`vivary broker listening on :${BROKER_PORT} (log: ${BROKER_DIR}/broker.log)`);
  });
}
