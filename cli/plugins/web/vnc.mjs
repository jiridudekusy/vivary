// A sandbox's screen through `vivary web`.
//
// The viewer's WebSocket ends HERE, behind the passkey session, and the RFB
// stream goes on through `<runtime> exec -i <container> vnc-relay`, which
// joins it to x11vnc on the sandbox's own loopback (headed plugin). The
// runtime's exec channel is the only way in: nothing listens on any network
// for VNC, so another sandbox has nothing to connect to, and there is no
// password or token to keep. Whoever can run `container exec` on the Mac owns
// every sandbox anyway. Measured: ~0.4 s to connect, ~15 ms per round trip on
// both runtimes; a closed viewer leaves no process behind.
//
// The page and noVNC's code come from the Mac (server.mjs), never from the
// sandbox: a script a sandbox could rewrite, run on this origin, would drive
// the API with the user's session. What comes back over the socket is the
// screen of a machine an agent controls; the viewer treats it as data.
import { spawn } from 'node:child_process';
import { STATUS_CODES } from 'node:http';
import { CLI_DIR } from '../../core/util.mjs';
import { listSandboxNames, loadSandbox } from '../../core/sandbox.mjs';
import { resolveRuntime } from '../../core/runtimes/index.mjs';
import { HttpError } from './auth.mjs';

export const VNC_RUNTIMES = ['container', 'docker'];
const MAX_SCREENS = 8;

// Loaded lazily, like the WebAuthn library: every `vivary` command loads every
// plugin, and a checkout without `npm install` must still run the rest.
let wsPromise = null;
export function wsLib() {
  wsPromise ||= import('ws').catch((e) => {
    wsPromise = null;
    throw new Error(`cannot load ws (${e.code || e.message}) — run: npm install --prefix ${CLI_DIR}`);
  });
  return wsPromise;
}

// Which runtime holds the running container. Not cfg.runtime: a project
// .vivary.json may override that in memory, so the registry can be wrong.
export function runningRuntime(name, runtimes = VNC_RUNTIMES) {
  for (const r of runtimes) {
    const rt = resolveRuntime(r);
    if (rt.runningSet().has(rt.instanceName(name))) return r;
  }
  return null;
}

// The command that carries one viewer's stream, or why there is none.
// `vncRelay` is written by the headed plugin's postUp once the GUI is up in a
// container that has vnc-relay, so nothing here has to re-resolve profiles or
// the project file (which can die() on an unapproved change).
export function relayFor(name, { known = listSandboxNames, load = loadSandbox, running = runningRuntime } = {}) {
  if (!known().includes(name)) throw new HttpError(404, 'unknown sandbox');
  const cfg = load(name);
  if (!cfg?.vncRelay) {
    throw new HttpError(409, `${name} has no screen. On the Mac: vivary up ${name} --headed`);
  }
  const runtime = running(name);
  if (!runtime) throw new HttpError(409, `${name} is not running`);
  return { runtime, bin: runtime, args: ['exec', '-i', resolveRuntime(runtime).instanceName(name), 'vnc-relay'] };
}

function refuse(socket, status, message) {
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] || 'Error'}\r\n`
    + 'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  setTimeout(() => socket.destroy(), 1000).unref();
}

// A WebSocket close reason is at most 123 bytes.
const reason = (s) => Buffer.from(String(s)).subarray(0, 120).toString().replace(/�$/, '');

// `ws` is the loaded module (wsLib()).
export function createVncBridge({
  ws: { WebSocketServer, createWebSocketStream }, auth, allowedLogins,
  relay = relayFor, spawnFn = spawn, log = () => {}, sweepMs = 15000, max = MAX_SCREENS,
}) {
  // Only small messages come from a viewer (keys, pointer, clipboard text).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
  const live = new Set();

  // A screen outlives the request that opened it, so the session is checked
  // again: logout, "sign out everywhere", a removed passkey or the 12 h limit
  // close it within one sweep.
  const sweep = setInterval(() => {
    for (const c of live) if (!auth.sessionAlive(c.session)) c.ws.close(4001, 'signed out');
  }, sweepMs);
  sweep.unref();

  function gate(req) {
    const who = req.headers['tailscale-user-login'];
    if (who && !allowedLogins().includes(String(who).toLowerCase())) {
      throw new HttpError(403, `${who} is not allowed to manage this vivary`);
    }
    // Browsers always send Origin with a WebSocket and never let a page forge
    // it. Without this check any site the user visits could open one with
    // their cookie (cross-site WebSocket hijacking); SameSite=Strict also
    // stops that, but the origin is the rule this relies on.
    if (req.headers.origin !== auth.origin) {
      throw new HttpError(403, `wrong origin ${req.headers.origin || '(none)'} — open ${auth.origin}`);
    }
    const session = auth.sessionFor(req);
    if (!session) throw new HttpError(401, 'not logged in');
    return session;
  }

  function open(ws, cmd, { session, name, who }) {
    const started = Date.now();
    const child = spawnFn(cmd.bin, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const conn = { ws, child, session };
    live.add(conn);
    log(`${who} -> screen ${name}`);

    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => {});

    const stream = createWebSocketStream(ws);
    stream.on('error', () => {});
    stream.pipe(child.stdin);                    // viewer -> sandbox; ends the relay when the viewer goes
    child.stdout.pipe(stream, { end: false });   // sandbox -> viewer; closed below, with a reason

    let done = false;
    const finish = (code, err) => {
      if (done) return;
      done = true;
      live.delete(conn);
      const why = (err?.message || stderr.trim().split('\n').pop() || '').trim();
      if (ws.readyState === ws.OPEN) {
        if (code === 0) ws.close(1000, 'screen closed');
        else ws.close(4500, reason(why || `relay exited with ${code}`));
      }
      log(`screen ${name} closed after ${Math.round((Date.now() - started) / 1000)} s${code ? ` (${why || code})` : ''}`);
    };
    child.on('error', (e) => finish(1, e));
    child.on('close', (code) => finish(code ?? 1));
    ws.on('close', () => {
      child.stdin.end();
      // Docker leaves an exec'd process running when only its client dies;
      // EOF on stdin is what ends vnc-relay. The kill is the backstop.
      setTimeout(() => { if (!done) child.kill('SIGKILL'); }, 3000).unref();
    });
  }

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const who = req.headers['tailscale-user-login'] || 'local';
    const p = new URL(req.url, 'http://localhost').pathname;
    try {
      const m = p.match(/^\/api\/vnc\/([^/]+)$/);
      if (!m) throw new HttpError(404, 'not found');
      const session = gate(req);
      let name;
      try { name = decodeURIComponent(m[1]); } catch { throw new HttpError(400, 'bad sandbox name'); }
      const cmd = relay(name);
      if (live.size >= max) throw new HttpError(503, 'too many open screens');
      wss.handleUpgrade(req, socket, head, (ws) => open(ws, cmd, { session, name, who }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 403) log(`DENIED ${who} screen ${p}: ${e.message}`);
      refuse(socket, status, e.message || 'error');
    }
  }

  function close() {
    clearInterval(sweep);
    for (const c of live) {
      c.ws.terminate();
      c.child.kill('SIGKILL');
    }
    live.clear();
  }

  return { handleUpgrade, close, count: () => live.size };
}
