// host-open: URLs from the sandbox open in the HOST browser, workspace files
// in the HOST editor. Includes the OAuth callback relay (claude /login,
// codex login): the browser's redirect to http://localhost:PORT is replayed
// into the sandbox via `<runtime> exec curl`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasCmd } from '../../core/util.mjs';
import { containerName } from '../../core/runtime.mjs';
import { allowedWorkspaces } from '../../core/sandbox.mjs';
import { brokerLog } from '../../core/broker.mjs';

// --- OAuth callback relay -----------------------------------------------------
const activeRelays = new Set();

function startCallbackRelay(cfg, port) {
  if (activeRelays.has(port)) return;
  const cname = containerName(cfg.name);
  const relay = http.createServer((req, res) => {
    const r = spawnSync(cfg.runtime, [
      'exec', cname, 'curl', '-sS', '-D', '-', '--max-time', '10',
      `http://127.0.0.1:${port}${req.url}`,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const out = r.stdout || '';
    const sep = out.indexOf('\r\n\r\n');
    if (r.status !== 0 || sep === -1) {
      brokerLog(`RELAY ${cfg.name} :${port} -> sandbox callback unreachable`);
      res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end('vivary relay: callback server in the sandbox is not reachable');
    }
    const head = out.slice(0, sep).split('\r\n');
    const body = out.slice(sep + 4);
    const status = Number((head[0].match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 200);
    const headers = {};
    for (const h of head.slice(1)) {
      const i = h.indexOf(':');
      const key = i > 0 ? h.slice(0, i).trim().toLowerCase() : '';
      if (['location', 'content-type'].includes(key)) headers[key] = h.slice(i + 1).trim();
    }
    res.writeHead(status, headers);
    res.end(body);
    brokerLog(`RELAY ${cfg.name} :${port}${req.url.split('?')[0]} -> ${status}`);
  });
  relay.on('error', (e) => {
    activeRelays.delete(port);
    brokerLog(`RELAY :${port} listen failed: ${e.code}`);
  });
  relay.listen(port, '127.0.0.1', () => {
    activeRelays.add(port);
    brokerLog(`RELAY ${cfg.name} listening on 127.0.0.1:${port} (5 min)`);
    setTimeout(() => { relay.close(); activeRelays.delete(port); }, 300000);
  });
}

// If the URL being opened contains redirect_uri=http://localhost:PORT (an
// OAuth authorize link), set up the callback relay for the calling sandbox.
function maybeRelayOauthCallback(target, cfg) {
  try {
    const redirect = new URL(target).searchParams.get('redirect_uri');
    if (!redirect) return;
    const r = new URL(redirect);
    if (r.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(r.hostname)) return;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port <= 1024 || port > 65535) return;
    startCallbackRelay(cfg, port);
  } catch {
    /* not an OAuth-style URL — nothing to do */
  }
}

// --- open on host ---------------------------------------------------------------
function openOnHost(action, target, cfg, via) {
  if (action === 'url') {
    let u;
    try {
      u = new URL(target);
    } catch {
      return 'invalid url';
    }
    if (!['http:', 'https:'].includes(u.protocol)) return `scheme not allowed: ${u.protocol}`;
    maybeRelayOauthCallback(target, cfg);
    const cmd = process.platform === 'darwin' ? ['open', target]
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '', target]
      : ['xdg-open', target];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    return null;
  }
  if (action === 'path') {
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      return 'path not found on host';
    }
    const ok = allowedWorkspaces().some((w) => real === w || real.startsWith(w + path.sep));
    if (!ok) return 'path outside sandbox workspaces';
    // via=editor (`code file`) opens in the editor; via=default (`open`,
    // `xdg-open`) uses the host's default application for the file type.
    if (via === 'editor' && hasCmd('code')) {
      spawnSync('code', [real], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [real], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', real], { stdio: 'ignore' });
    } else if (hasCmd('xdg-open')) {
      spawnSync('xdg-open', [real], { stdio: 'ignore' });
    } else {
      return 'no opener found on host';
    }
    return null;
  }
  return 'unknown action';
}

export default {
  name: 'host-open',
  order: 50,
  flags: {
    'host-open': {
      type: 'boolean',
      sticky: true,
      cfgKey: 'hostOpen',
      help: 'URLs open in the HOST browser, workspace files in the\nHOST editor (xdg-open/open/code inside forward to the\nvivary broker; sticky). OAuth logins work: localhost\ncallbacks are relayed from the host into the sandbox.',
    },
  },
  needsBroker: (cfg) => !!cfg.hostOpen,

  // POST / with action=url|path
  broker({ req, respond, params, log, sandboxForRequest }) {
    if (req.method !== 'POST' || !params.get('action')) return false;
    const cfg = sandboxForRequest(params.get('name') || '');
    if (!cfg?.hostOpen) {
      log(`REJECTED open (not enabled) from ${params.get('name') || '?'}`);
      respond(403, { ok: false, error: 'host-open not enabled for this sandbox (--host-open)' });
      return true;
    }
    const action = params.get('action');
    const target = params.get('target') || '';
    const via = params.get('via') === 'editor' ? 'editor' : 'default';
    const err = openOnHost(action, target, cfg, via);
    log(`${err ? `REJECTED (${err})` : 'OK'} ${action} (${via}) ${target} from ${cfg.name}`);
    if (err) respond(400, { ok: false, error: err });
    else respond(200, { ok: true });
    return true;
  },
};
