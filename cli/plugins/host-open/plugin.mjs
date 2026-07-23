// host-open: URLs from the sandbox open in the HOST browser, workspace files
// in the HOST editor. Includes the OAuth callback relay (claude /login,
// codex login): the browser's redirect to http://localhost:PORT is replayed
// into the sandbox via `<runtime> exec curl`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture, hasCmd } from '../../core/util.mjs';
import { containerName } from '../../core/runtime.mjs';
import { resolveRuntime, runtimeKind } from '../../core/runtimes/index.mjs';
import { allowedWorkspaces } from '../../core/sandbox.mjs';
import { brokerLog, ensureBroker, sandboxBrokerToken, BROKER_PORT } from '../../core/broker.mjs';

// The `open`/`xdg-open` shim installed into a tart guest: forwards to the host
// broker (SBX_OPEN_URL/TOKEN come from the agent's exec env). Falls back to the
// guest's real `open` if the broker is unreachable or the env is absent.
const TART_OPEN_SHIM = `#!/bin/sh
[ -n "$SBX_OPEN_URL" ] || exec /usr/bin/open "$@"
t=""; for a in "$@"; do case "$a" in -*) ;; *) t="$a"; break;; esac; done
[ -n "$t" ] || exec /usr/bin/open "$@"
case "$t" in http://*|https://*) act=url;; *) act=path;; esac
curl -sS --max-time 15 -X POST "$SBX_OPEN_URL" \\
  --data-urlencode "token=$SBX_OPEN_TOKEN" --data-urlencode "action=$act" \\
  --data-urlencode "target=$t" --data-urlencode "via=default" >/dev/null 2>&1 \\
  || exec /usr/bin/open "$@"
`;

// --- OAuth callback relay -----------------------------------------------------
const activeRelays = new Map(); // port -> owning sandbox name

function startCallbackRelay(cfg, port) {
  const owner = activeRelays.get(port);
  if (owner !== undefined) {
    // A different sandbox already holds this callback port — do not let this
    // one hijack another sandbox's OAuth callback.
    if (owner !== cfg.name) brokerLog(`RELAY :${port} refused for ${cfg.name} (owned by ${owner})`);
    return;
  }
  // Claim the port synchronously, before the async listen() callback, so a
  // second sandbox can't race in during startup.
  activeRelays.set(port, cfg.name);
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

// --- URL safety ---------------------------------------------------------------
// Never let the sandbox drive the host browser to loopback/LAN targets: it
// would turn the browser into a proxy to host-only services (the broker on
// 127.0.0.1, dev servers, router admin, 169.254.169.254 cloud metadata).
// Literal host/IP only — DNS names that resolve to private space (rebinding)
// are out of scope; the OAuth relay handles the legitimate localhost case.
export function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === '::1') return true;
  if (/^fe80:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h)) return true; // link-local / ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a === 0 || a === 127) return true;                 // this-host / loopback
    if (a === 10) return true;                             // private
    if (a === 172 && b >= 16 && b <= 31) return true;      // private
    if (a === 192 && b === 168) return true;               // private
    if (a === 169 && b === 254) return true;               // link-local + metadata
  }
  return false;
}

// Optional per-sandbox allow-list in sandbox.json ("hostOpenDomains": [...]).
// Empty/absent => any public host allowed (still minus isPrivateHost).
export function domainAllowed(host, cfg) {
  const allow = Array.isArray(cfg.hostOpenDomains) ? cfg.hostOpenDomains : [];
  if (!allow.length) return true;
  return allow.some((d) => {
    const dom = String(d).toLowerCase().replace(/^\.+/, '');
    return host === dom || host.endsWith('.' + dom);
  });
}

// --- path safety --------------------------------------------------------------
// via=default routes a workspace file to the host's LaunchServices default
// app. The agent controls workspace contents, so the containment check alone
// is not enough: `open` on a .app/.command/.pkg/.webloc launches software on
// the host. Default-deny by extension (safe document/media types only), and
// reject bundles (directories) and anything with the exec bit set.
const SAFE_EXTS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'txt', 'md', 'markdown', 'log',
  'csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key',
  // data / markup (html/svg open in a browser, which sandboxes their scripts)
  'json', 'xml', 'yaml', 'yml', 'html', 'htm',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'heic', 'svg',
  // audio / video (non-executing viewers: QuickTime/Music/Preview)
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm',
]);

export function pathSafeToDefaultOpen(real, cfg) {
  let st;
  try {
    st = fs.lstatSync(real);
  } catch {
    return 'path not found on host';
  }
  // Bundles (.app/.workflow/.rtfd/.scptd) are directories — never launch one.
  if (st.isDirectory()) return 'refusing to open a directory/bundle with the default app';
  if (st.isSymbolicLink()) return 'refusing to open a symlink with the default app';
  if ((st.mode & 0o111) !== 0) return 'refusing to open an executable file with the default app';
  const ext = path.extname(real).slice(1).toLowerCase();
  const extra = Array.isArray(cfg.hostOpenExtensions)
    ? cfg.hostOpenExtensions.map((e) => String(e).replace(/^\.+/, '').toLowerCase())
    : [];
  if (!ext || !(SAFE_EXTS.has(ext) || extra.includes(ext))) {
    return `file type not allowed for default-open (.${ext || 'none'}) — use \`code <file>\` to edit, or add it to hostOpenExtensions in sandbox.json`;
  }
  return null;
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
    const host = u.hostname.toLowerCase();
    if (isPrivateHost(host)) return `host not allowed (loopback/private/link-local): ${host}`;
    if (!domainAllowed(host, cfg)) return `domain not in this sandbox's allow-list: ${host}`;
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
    // via=editor (`code file`) only ever opens the file for editing — safe.
    // via=default uses the host's default app, gated by pathSafeToDefaultOpen.
    if (via === 'editor' && hasCmd('code')) {
      spawnSync('code', [real], { stdio: 'ignore' });
      return null;
    }
    const unsafe = pathSafeToDefaultOpen(real, cfg);
    if (unsafe) return unsafe;
    if (process.platform === 'darwin') {
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
      help: 'URLs open in the HOST browser, workspace files in the\nHOST editor (xdg-open/open/code inside forward to the\nvivary broker; sticky). OAuth logins work: localhost\ncallbacks are relayed from the host into the sandbox.\nSafety: loopback/private URLs are refused; default-app\nopen is limited to safe document/media types. Optional\nsandbox.json keys: "hostOpenDomains" (URL allow-list),\n"hostOpenExtensions" (extra default-open file types).',
    },
  },
  needsBroker: (cfg) => !!cfg.hostOpen,

  // tart: the guest reaches the broker at the vmnet gateway (not
  // host.docker.internal). Point the shim's env there; __GATEWAY__ resolves
  // after boot. The per-sandbox broker token authorizes the request.
  async vmContribute(ctx) {
    const { cfg } = ctx;
    if (!cfg.hostOpen || runtimeKind(cfg.runtime) !== 'vm-tart') return {};
    await ensureBroker();
    return {
      env: {
        SBX_OPEN_URL: `http://__GATEWAY__:${BROKER_PORT}/`,
        SBX_OPEN_TOKEN: sandboxBrokerToken(cfg.name),
      },
    };
  },

  // tart: install the `open`/`xdg-open` shim into the booted guest.
  async vmPostUp(ctx) {
    const { cfg } = ctx;
    if (!cfg.hostOpen) return;
    const vm = resolveRuntime(cfg.runtime).instanceName(cfg.name);
    const b64 = Buffer.from(TART_OPEN_SHIM).toString('base64');
    const install = ['exec', vm, '/bin/zsh', '-lc',
      `printf '%s' ${JSON.stringify(b64)} | base64 -d | sudo tee /usr/local/bin/open >/dev/null `
      + `&& sudo chmod 755 /usr/local/bin/open && sudo ln -sf /usr/local/bin/open /usr/local/bin/xdg-open`];
    if (capture('tart', install).status !== 0) {
      console.error('WARNING: could not install the host-open shim in the guest');
    } else {
      ctx.log('    host-open: `open`/`xdg-open` in the guest now forward to the host.');
    }
  },

  // POST / with action=url|path
  broker({ req, respond, params, log, sandbox }) {
    if (req.method !== 'POST' || !params.get('action')) return false;
    const cfg = sandbox; // resolved from the caller's token, not a client-supplied name
    if (!cfg?.hostOpen) {
      log(`REJECTED open (not enabled) from ${cfg?.name || '?'}`);
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
