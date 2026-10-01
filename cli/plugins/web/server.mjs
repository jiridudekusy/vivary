// vivary web — a phone-sized management UI, reachable over the tailnet.
//
// SECURITY, the part that shaped everything else: this must NOT live in the
// broker. The broker listens on 0.0.0.0:7377 and sandboxes reach it by design
// (host.docker.internal) — a management API there would let any agent in any
// sandbox start and stop containers and read connection details. So this server
// binds LOOPBACK only. The host's 127.0.0.1 is unreachable from an Apple
// `container` guest (separate network namespace; host.docker.internal maps to
// the gateway, not to loopback), which makes loopback the strongest bind we
// have. `tailscale serve` then fronts it for the tailnet, adding HTTPS with a
// real cert (no Safari warning on an iPad) and the caller's identity headers.
//
// Deliberately NOT offered: creating a sandbox. A workspace path is a raw host
// mount, so "create" from a phone would be an arbitrary-host-directory mount
// behind whatever reaches the tailnet. Creation stays on the Mac.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_DIR, capture } from '../../core/util.mjs';
import { listSandboxNames, loadSandbox, sandboxDir } from '../../core/sandbox.mjs';
import { resolveRuntime } from '../../core/runtimes/index.mjs';

import { deviceFile, listDevices, parsePublicKey } from '../ssh/devices.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_PORT = Number(process.env.VIVARY_WEB_PORT || 7378);
const TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailscaleBin() {
  if (fs.existsSync(TAILSCALE_BIN)) return TAILSCALE_BIN;
  return capture('sh', ['-c', 'command -v tailscale']).status === 0 ? 'tailscale' : null;
}

// The tailnet FQDN of THIS host — what a connection string must point at, since
// the sandbox's own MagicDNS name only resolves on the host itself.
export function selfTailnetFqdn(run = capture) {
  const bin = tailscaleBin();
  if (!bin) return null;
  const r = run(bin, ['status', '--json']);
  if (r.status !== 0) return null;
  try {
    return (JSON.parse(r.stdout).Self?.DNSName || '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

// Connection details for ONE sandbox. Device keys (vivary key add) mean a phone
// needs no per-sandbox key, so this is just where to point ssh.
export function connectionInfo(cfg, fqdn) {
  const tailnetPort = cfg.tailscale ? cfg.tsSshPort : null;
  const info = {
    name: cfg.name,
    workspace: cfg.workspace,
    tailnet: null,
    local: `ssh ${resolveRuntime(cfg.runtime).instanceName(cfg.name)}`,
    hint: null,
  };
  if (!cfg.tailscale) {
    info.hint = 'Sandbox has no --tailscale, so it is reachable only from this Mac. '
      + 'Enable it with: vivary up --tailscale';
  } else if (!fqdn) {
    info.hint = 'Tailscale is not reporting this host\'s name — is it running?';
  } else if (!tailnetPort) {
    info.hint = 'No tailnet SSH port assigned yet — start the sandbox once.';
  } else {
    info.tailnet = `ssh -p ${tailnetPort} agent@${fqdn}`;
  }
  return info;
}

export function sandboxList(fqdn) {
  const running = {
    docker: resolveRuntime('docker').runningSet(),
    container: resolveRuntime('container').runningSet(),
    tart: resolveRuntime('tart').runningSet(),
  };
  return listSandboxNames().sort().map((name) => {
    const cfg = loadSandbox(name);
    if (!cfg) return null;
    const holders = Object.keys(running)
      .filter((n) => running[n].has(resolveRuntime(n).instanceName(name)));
    return {
      name,
      running: holders.length > 0,
      runtime: cfg.runtime || '?',
      agent: cfg.agent || 'claude',
      workspace: cfg.workspace || '?',
      memory: cfg.memory || null,
      tailscale: !!cfg.tailscale,
      desiredRunning: !!cfg.desiredRunning,
      connect: connectionInfo(cfg, fqdn),
    };
  }).filter(Boolean);
}

// up/down run as a CHILD process, never in-process: the lifecycle helpers call
// die(), which is process.exit() — in-process that would take the web server
// down with them. A child also gives us the real CLI path, output and all.
function runVivary(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(CLI_DIR, 'vivary.mjs'), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (b) => { out += b.toString(); if (out.length > 60000) out = out.slice(-60000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, output: `${out}\n\nTIMED OUT after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
  });
}

// --- authorization ------------------------------------------------------------
//
// The identity comes from tailscaled, not from the client: `tailscale serve`
// OVERWRITES any Tailscale-* header a caller sends (measured — a request
// carrying "Tailscale-User-Login: attacker@evil.example" arrived as the real
// login), so the header is an assertion by the proxy, not by the browser.
//
// A request with NO header reached loopback directly, bypassing serve. Only
// someone already on the Mac can do that, and they can just run `vivary`
// themselves, so that is treated as the owner rather than defended against.
// Sandboxes cannot reach the host's loopback at all, which is the case that
// actually matters.
export function resolveAllowedLogins(cfgAllow, run = capture) {
  const explicit = (Array.isArray(cfgAllow) ? cfgAllow : []).map((s) => String(s).toLowerCase());
  if (explicit.length) return explicit;
  // Default: this machine's own tailnet owner, nobody else on the tailnet.
  const bin = tailscaleBin();
  if (!bin) return [];
  const r = run(bin, ['status', '--json']);
  if (r.status !== 0) return [];
  try {
    const st = JSON.parse(r.stdout);
    // A tailnet UserID exceeds Number.MAX_SAFE_INTEGER, so JSON.parse rounds
    // it: Self.UserID came back as ...964 while the User map's key is ...965.
    // Indexing by String(Self.UserID) therefore always missed, which silently
    // produced an EMPTY allowlist — fail-closed, but it locks the owner out
    // too. Match by putting the key through the same rounding instead.
    const key = Object.keys(st.User || {}).find((k) => Number(k) === st.Self?.UserID);
    const login = key ? st.User[key]?.LoginName : null;
    return login ? [String(login).toLowerCase()] : [];
  } catch {
    return [];
  }
}

// Returns null when allowed, or a { status, error } to send back.
export function authorize(req, allowed) {
  const who = req.headers['tailscale-user-login'];
  if (who && !allowed.includes(String(who).toLowerCase())) {
    return { status: 403, error: `${who} is not allowed to manage this vivary` };
  }
  // CSRF: a page on another origin can fire a plain POST at this tailnet URL
  // without being able to read the reply — enough to start or stop a sandbox.
  // A custom header cannot be set cross-origin without a preflight, and no CORS
  // headers are sent, so the preflight fails. Same job as the wrapper's CSRF
  // token, without a session to hang it on.
  if (req.method !== 'GET') {
    if (req.headers['x-vivary'] !== '1') {
      return { status: 403, error: 'missing X-Vivary header (cross-origin request?)' };
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return { status: 403, error: `cross-site request refused (${site})` };
    }
  }
  return null;
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Only names that already exist in the registry are ever passed to the CLI —
// the name reaches a child process argv, so an unvalidated one would be an
// injection surface even with spawn's argv (flags like --workspace).
function knownSandbox(name) {
  return listSandboxNames().includes(name) ? name : null;
}

export function createServer({ allow } = {}) {
  // Resolved once per request but cached briefly — `tailscale status` is a
  // subprocess and the UI polls.
  let cached = null;
  let cachedAt = 0;
  const allowedLogins = () => {
    if (!cached || Date.now() - cachedAt > 30000) {
      cached = resolveAllowedLogins(allow);
      cachedAt = Date.now();
    }
    return cached;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    // Identity, when tailscale serve fronts us. Not an auth gate (the loopback
    // bind is), but it is what the audit line records and what the UI greets.
    const who = req.headers['tailscale-user-login'] || null;

    try {
      if (p.startsWith('/api/')) {
        const denial = authorize(req, allowedLogins());
        if (denial) {
          console.error(`[web] DENIED ${who || 'local'} ${req.method} ${p}: ${denial.error}`);
          return json(res, denial.status, { ok: false, error: denial.error });
        }
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(HERE, 'ui.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // Self-hosted Roboto / Roboto Mono, same files the approval-mcp-wrapper UI
      // ships. Self-hosted on purpose: this is the page you open when something
      // is broken, so it must not depend on fetching a font from the internet.
      const font = p.match(/^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/);
      if (req.method === 'GET' && font) {
        const file = path.join(HERE, 'assets/fonts', font[1]);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
        res.writeHead(200, {
          'content-type': 'font/woff2',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        return res.end(fs.readFileSync(file));
      }

      if (req.method === 'GET' && p === '/api/state') {
        const fqdn = selfTailnetFqdn();
        return json(res, 200, {
          host: fqdn,
          who,
          sandboxes: sandboxList(fqdn),
          devices: listDevices().map((d) => ({ name: d.name, key: d.key })),
        });
      }

      const action = p.match(/^\/api\/sandboxes\/([^/]+)\/(up|down)$/);
      if (req.method === 'POST' && action) {
        const name = knownSandbox(decodeURIComponent(action[1]));
        if (!name) return json(res, 404, { ok: false, error: 'unknown sandbox' });
        console.log(`[web] ${who || 'local'} -> ${action[2]} ${name}`);
        const r = await runVivary([action[2], '--name', name]);
        return json(res, r.ok ? 200 : 500, r);
      }

      if (req.method === 'POST' && p === '/api/devices') {
        const body = JSON.parse(await readBody(req) || '{}');
        const name = String(body.name || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(name)) {
          return json(res, 400, { ok: false, error: 'name must be 1-32 chars: letters, digits, dashes' });
        }
        let key;
        try {
          key = parsePublicKey(body.key);
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
        fs.mkdirSync(path.dirname(deviceFile(name)), { recursive: true });
        fs.writeFileSync(deviceFile(name), `${key}\n`, { mode: 0o644 });
        console.log(`[web] ${who || 'local'} -> enrolled device ${name}`);
        // Pushing to live sandboxes is the CLI's job, so reuse it rather than
        // duplicating the pgrep/cmp logic that makes the push honest.
        const r = await runVivary(['key', 'add', name, '--key', key], 120000);
        return json(res, 200, { ok: true, output: r.output });
      }

      if (req.method === 'DELETE' && p.startsWith('/api/devices/')) {
        const name = decodeURIComponent(p.slice('/api/devices/'.length));
        if (!listDevices().some((d) => d.name === name)) {
          return json(res, 404, { ok: false, error: 'unknown device' });
        }
        const r = await runVivary(['key', 'rm', name], 120000);
        console.log(`[web] ${who || 'local'} -> revoked device ${name}`);
        return json(res, 200, { ok: true, output: r.output });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message || String(e) });
    }
  });
}
