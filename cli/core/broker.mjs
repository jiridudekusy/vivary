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
import { loadSandbox } from './sandbox.mjs';
import { getPlugins } from './plugins.mjs';

export const BROKER_DIR = path.join(SANDBOXES_DIR, '.broker');
export const BROKER_PORT = Number(process.env.SBX_BROKER_PORT || 7377);

export function brokerToken() {
  const file = path.join(BROKER_DIR, 'token');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(BROKER_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
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
  return { url: `http://host.docker.internal:${BROKER_PORT}/`, token: brokerToken() };
}

// Container env announcing the broker (when any enabled plugin needs it).
export async function brokerEnvArgs(cfg) {
  const needed = getPlugins().some((p) => p.needsBroker?.(cfg));
  if (!needed) return [];
  const { url, token } = await ensureBroker();
  return ['-e', `SBX_OPEN_URL=${url}`, '-e', `SBX_OPEN_TOKEN=${token}`];
}

// The sandbox name is client-supplied; it gates which broker features the
// caller may use (single-user trust model — token is the real auth).
export function sandboxForRequest(name) {
  return name && /^[a-z0-9-]+$/.test(name) ? loadSandbox(name) : null;
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
  const token = brokerToken();
  fs.mkdirSync(BROKER_DIR, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  const server = http.createServer((req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true });

    const dispatch = (params) => {
      if (params.get('token') !== token) {
        brokerLog(`DENIED bad token from ${req.socket.remoteAddress}`);
        return respond(403, { ok: false, error: 'bad token' });
      }
      const ctx = { req, res, respond, params, log: brokerLog, sandboxForRequest };
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
