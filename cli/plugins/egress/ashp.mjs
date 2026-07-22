// ASHP service kernel: one shared, lazy-started transparent MITM proxy per
// runtime (mirrors core/broker.mjs). ASHP is dual-homed — `default` for
// upstream egress, `vivary-egress` (internal) facing the sandboxes — so it
// never restarts as sandboxes come and go and never nears Apple's 4-NIC cap.
//
// State lives in ~/.vivary/.ashp/: secrets.json (0600), conf/ashp.json,
// data/ (SQLCipher db + CA), bin/pre-entrypoint.sh (sysctl wrapper, see
// ashp/pre-entrypoint.sh), agents/<name> (per-sandbox tokens, 0600).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOXES_DIR, capture, die, readJson, runInherit } from '../../core/util.mjs';
import { detectRuntime } from '../../core/runtime.mjs';

export const ASHP_DIR = path.join(SANDBOXES_DIR, '.ashp');
export const EGRESS_NET = 'vivary-egress';
export const ASHP_CONTAINER = 'vivary-ashp';
export const ASHP_IMAGE = process.env.SANDBOX_ASHP_IMAGE || 'jiridudekusy/ashp:latest';
const MGMT_PORT = 3000;
const PLUGIN_DIR = path.dirname(new URL(import.meta.url).pathname);

// --- secrets & config ---------------------------------------------------------

// Generated once, 0600 — like the broker token. adminPassword guards the
// management API/GUI; the db/log/ca keys encrypt ASHP's SQLite state.
function ensureSecrets() {
  const file = path.join(ASHP_DIR, 'secrets.json');
  let s = readJson(file);
  if (!s) {
    fs.mkdirSync(ASHP_DIR, { recursive: true });
    s = {
      dbKey: crypto.randomBytes(32).toString('hex'),
      logKey: crypto.randomBytes(32).toString('hex'),
      caKey: crypto.randomBytes(32).toString('hex'),
      adminPassword: crypto.randomBytes(18).toString('base64url'),
    };
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  return s;
}

// Render conf/ashp.json + stage the sysctl wrapper. Secrets go in as env:
// references (resolved by ASHP from the container environment), so the
// config file itself carries none.
function stageState() {
  for (const d of ['conf', 'data', 'bin', 'agents']) {
    fs.mkdirSync(path.join(ASHP_DIR, d), { recursive: true });
  }
  const conf = {
    proxy: { listen: '0.0.0.0:8080', bin_path: '/app/proxy/ashp-proxy', hold_timeout: 60 },
    management: { listen: `0.0.0.0:${MGMT_PORT}`, auth: { admin: 'env:ASHP_ADMIN_PASSWORD' } },
    rules: { source: 'db' },
    default_behavior: 'deny',
    logging: { request_body: 'full', response_body: 'truncate:65536', retention_days: 30 },
    database: { path: '/data/ashp.db', encryption_key: 'env:ASHP_DB_KEY' },
    encryption: { log_key: 'env:ASHP_LOG_KEY', ca_key: 'env:ASHP_CA_KEY' },
    gui: { dist_path: '/app/gui/dist' },
    ipc_socket: '/tmp/ashp.sock',
    webhooks: [],
    transparent: {
      enabled: true,
      listen: '0.0.0.0',
      ports: [{ port: 443, tls: true }, { port: 80, tls: false }],
    },
  };
  fs.writeFileSync(path.join(ASHP_DIR, 'conf/ashp.json'),
    JSON.stringify(conf, null, 2), { mode: 0o600 });
  const wrapper = path.join(ASHP_DIR, 'bin/pre-entrypoint.sh');
  fs.copyFileSync(path.join(PLUGIN_DIR, 'ashp/pre-entrypoint.sh'), wrapper);
  fs.chmodSync(wrapper, 0o755);
}

// --- network ------------------------------------------------------------------

function netInspect(runtime) {
  if (runtime === 'docker') {
    const r = capture('docker', ['network', 'inspect', EGRESS_NET]);
    if (r.status !== 0) return null;
    const cfg = JSON.parse(r.stdout)[0]?.IPAM?.Config?.[0];
    return cfg ? { subnet: cfg.Subnet, gateway: cfg.Gateway } : null;
  }
  const r = capture('container', ['network', 'inspect', EGRESS_NET]);
  if (r.status !== 0) return null;
  const status = JSON.parse(r.stdout)[0]?.status;
  return status ? { subnet: status.ipv4Subnet, gateway: status.ipv4Gateway } : null;
}

// Shared internal net all egress sandboxes attach to. `--internal` blocks
// external egress but not host<->container (host bridge, gateway .1).
export function ensureEgressNet(runtime) {
  let net = netInspect(runtime);
  if (!net) {
    const r = capture(runtime, ['network', 'create', '--internal', EGRESS_NET]);
    if (r.status !== 0) die(`cannot create network ${EGRESS_NET}: ${r.stderr || r.stdout}`);
    net = netInspect(runtime) || die(`network ${EGRESS_NET} created but not inspectable`);
    console.log(`==> egress: created internal network ${EGRESS_NET} (${net.subnet})`);
  }
  return net;
}

// nth host address in the net (subnet a.b.c.0/24 -> a.b.c.n).
function subnetAddr(subnet, n) {
  return subnet.replace(/\.\d+\/\d+$/, `.${n}`);
}

// --- container plumbing -------------------------------------------------------

function ashpRunning(runtime) {
  if (runtime === 'docker') {
    const r = capture('docker', ['ps', '--format', '{{.Names}}']);
    return r.stdout.split('\n').includes(ASHP_CONTAINER);
  }
  const r = capture('container', ['ls']);
  return r.status === 0 && r.stdout.split('\n').slice(1)
    .some((l) => l.trim().split(/\s+/)[0] === ASHP_CONTAINER);
}

// ASHP's IP on the vivary-egress net (the one sandboxes talk to).
function ashpEgressIp(runtime) {
  if (runtime === 'docker') {
    const r = capture('docker', ['inspect', '-f',
      `{{(index .NetworkSettings.Networks "${EGRESS_NET}").IPAddress}}`, ASHP_CONTAINER]);
    return r.status === 0 ? r.stdout.trim() : null;
  }
  const r = capture('container', ['inspect', ASHP_CONTAINER]);
  if (r.status !== 0) return null;
  const nets = JSON.parse(r.stdout)[0]?.status?.networks || [];
  const entry = nets.find((n) => n.network === EGRESS_NET);
  return entry ? entry.ipv4Address.split('/')[0] : null;
}

async function ashpHealthy(ip, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${ip}:${MGMT_PORT}/api/status`,
      { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(ip, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await ashpHealthy(ip)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// env + volume args shared by both runtimes. `transparentIp` pins the
// dnsmasq catch-all to ASHP's vivary-egress IP; pass it only when known
// ahead of boot (Docker static IP). On Apple it's null — the pre-entrypoint
// wrapper computes it inside the container (see ashp/pre-entrypoint.sh).
function ashpRunArgs(secrets, transparentIp) {
  const args = [
    '--name', ASHP_CONTAINER,
    '--entrypoint', '/vivary/pre-entrypoint.sh',
    '-v', `${path.join(ASHP_DIR, 'conf')}:/etc/ashp`,
    '-v', `${path.join(ASHP_DIR, 'data')}:/data`,
    '-v', `${path.join(ASHP_DIR, 'bin')}:/vivary`,
    '-e', `ASHP_DB_KEY=${secrets.dbKey}`,
    '-e', `ASHP_LOG_KEY=${secrets.logKey}`,
    '-e', `ASHP_CA_KEY=${secrets.caKey}`,
    '-e', `ASHP_ADMIN_PASSWORD=${secrets.adminPassword}`,
    '-e', 'ASHP_TRANSPARENT=true',
  ];
  if (transparentIp) args.push('-e', `ASHP_TRANSPARENT_IP=${transparentIp}`);
  return args;
}

// The image CMD, passed explicitly because --entrypoint replaces it on both
// runtimes (pre-entrypoint.sh execs the stock entrypoint with these args).
const ASHP_CMD = ['node', 'server/src/index.js', '--config', '/etc/ashp/ashp.json'];

// Apple: no static-IP flag and the DHCP pool increments on every create, so
// the host can't predict the IP. Start ASHP (the wrapper self-pins the
// catch-all to its own internal NIC), then discover the IP it got.
function startAshpApple(secrets) {
  const r = capture('container', ['run', '-d',
    ...ashpRunArgs(secrets, null),
    '--network', 'default', '--network', EGRESS_NET,
    ASHP_IMAGE, ...ASHP_CMD]);
  if (r.status !== 0) die(`cannot start ASHP: ${r.stderr || r.stdout}`);
  return ashpEgressIp('container')
    || die(`ASHP started but has no address on ${EGRESS_NET}`);
}

// Docker: user-defined nets support static addressing — create the container,
// attach vivary-egress at a fixed IP, then start (dnsmasq binds at boot, so
// both NICs must exist before the entrypoint runs).
function startAshpDocker(secrets, net) {
  const ip = subnetAddr(net.subnet, 2);
  let r = capture('docker', ['create',
    ...ashpRunArgs(secrets, ip), '--network', 'bridge', ASHP_IMAGE, ...ASHP_CMD]);
  if (r.status !== 0) die(`cannot create ASHP container: ${r.stderr || r.stdout}`);
  r = capture('docker', ['network', 'connect', '--ip', ip, EGRESS_NET, ASHP_CONTAINER]);
  if (r.status !== 0) {
    capture('docker', ['rm', '-f', ASHP_CONTAINER]);
    die(`cannot attach ASHP to ${EGRESS_NET} at ${ip}: ${r.stderr || r.stdout}`);
  }
  r = capture('docker', ['start', ASHP_CONTAINER]);
  if (r.status !== 0) die(`cannot start ASHP: ${r.stderr || r.stdout}`);
  return ip;
}

// --- public API ---------------------------------------------------------------

// Idempotent lazy start (like ensureBroker). Returns ASHP's vivary-egress IP
// and the management password for admin API calls.
export async function ensureAshp(runtime) {
  const net = ensureEgressNet(runtime);
  const secrets = ensureSecrets();

  if (ashpRunning(runtime)) {
    const ip = ashpEgressIp(runtime)
      || die(`${ASHP_CONTAINER} is running but not attached to ${EGRESS_NET}`);
    if (!(await waitHealthy(ip, 20))) {
      die(`ASHP at ${ip}:${MGMT_PORT} is not answering (try: vivary egress stop, then retry)`);
    }
    return { ip, adminPassword: secrets.adminPassword };
  }

  stageState();
  capture(runtime, ['rm', '-f', ASHP_CONTAINER]); // clear any stopped leftover
  const ip = runtime === 'docker'
    ? startAshpDocker(secrets, net)
    : startAshpApple(secrets);
  if (!(await waitHealthy(ip))) {
    die(`ASHP failed to become healthy on ${ip}:${MGMT_PORT} (logs: vivary egress logs)`);
  }
  console.log(`==> vivary egress proxy (ASHP) started on ${ip}`);
  console.log(`    Policy UI: http://${ip}:${MGMT_PORT}/ (user: admin, password: ${path.join(ASHP_DIR, 'secrets.json')})`);
  return { ip, adminPassword: secrets.adminPassword };
}

// --- per-sandbox agent identity -------------------------------------------------

// `soft: true` turns failures (network or non-2xx) into a null return instead
// of a fatal die — for best-effort paths like purge cleanup, where one failed
// call must not abort the surrounding operation.
async function mgmt(ip, adminPassword, method, route, body, { soft = false } = {}) {
  let res;
  try {
    res = await fetch(`http://${ip}:${MGMT_PORT}/api${route}`, {
      method,
      headers: {
        authorization: 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64'),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    if (soft) return null;
    die(`ASHP API ${method} ${route} failed: ${e.message}`);
  }
  if (!res.ok) {
    if (soft) return null;
    die(`ASHP API ${method} ${route} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Each egress sandbox is one ASHP agent (name = sandbox name, own token).
// Tokens are plaintext-visible only at creation/rotation, persisted 0600 in
// .ashp/agents/<name>; a lost token (or wiped ASHP db) is re-rotated here.
export async function ensureAgent(ip, adminPassword, name) {
  const tokenFile = path.join(ASHP_DIR, 'agents', name);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const agents = await mgmt(ip, adminPassword, 'GET', '/agents');
  const existing = agents.find((a) => a.name === name);
  if (existing && fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }
  const created = existing
    ? await mgmt(ip, adminPassword, 'POST', `/agents/${existing.id}/rotate-token`)
    : await mgmt(ip, adminPassword, 'POST', '/agents',
        { name, description: 'vivary sandbox' });
  if (!created.token) die(`ASHP did not return a token for agent '${name}'`);
  fs.writeFileSync(tokenFile, created.token, { mode: 0o600 });
  return created.token;
}

// Purge hook: drop the persisted token AND, when ASHP is reachable, delete the
// sandbox's managed allow rules (`vivary:<name>:`) and its ASHP agent record.
// Best-effort — a down/unhealthy ASHP or a failing call never aborts the purge
// (the token file, the host-side secret, is always removed). Cleaning the rules
// matters for correctness AND security: ASHP currently applies allow rules
// globally (ignores agent_id, see syncAgentRules), so a purged sandbox's rules
// would otherwise keep whitelisting hosts for every other egress sandbox, and a
// reused name would inherit never-approved rules.
export async function purgeAgent(name, runtime) {
  fs.rmSync(path.join(ASHP_DIR, 'agents', name), { force: true });
  runtime = runtime || detectRuntime();
  if (!ashpRunning(runtime)) return;
  const ip = ashpEgressIp(runtime);
  if (!ip || !(await ashpHealthy(ip))) return;
  const { adminPassword } = ensureSecrets();
  const prefix = `vivary:${name}:`;
  const rules = await mgmt(ip, adminPassword, 'GET', '/rules', undefined, { soft: true });
  for (const r of (rules || []).filter((r) => (r.name || '').startsWith(prefix))) {
    await mgmt(ip, adminPassword, 'DELETE', `/rules/${r.id}`, undefined, { soft: true });
  }
  const agents = await mgmt(ip, adminPassword, 'GET', '/agents', undefined, { soft: true });
  const agent = (agents || []).find((a) => a.name === name);
  if (agent) await mgmt(ip, adminPassword, 'DELETE', `/agents/${agent.id}`, undefined, { soft: true });
}

// --- config-driven rule sync ------------------------------------------------------

// Sync vivary-managed allow rules for one sandbox with the effective egress
// policy (.vivary.json presets + allow). Managed rules are identified by the
// name prefix `vivary:<sandbox>:` and carry the sandbox agent's id; rules
// without the prefix (hand-made in the policy UI) are NEVER touched.
// Empty pattern list -> all managed rules for the sandbox are removed
// (deny-all default, approval via the UI as before).
//
// GOTCHA (verified 2026-07-22): ASHP's Go proxy currently ignores a rule's
// agent_id during matching — plain rules are effectively GLOBAL (a second
// sandbox passed through another sandbox's allow rule). Per-agent
// enforcement in ASHP works only via policies, and its flat rules.reload
// (fired on every rule mutation) overrides the per-agent map anyway. We
// still set agent_id (bookkeeping + forward compat), but do not promise
// isolation between egress sandboxes' allow lists until ASHP scopes rules.
export async function syncAgentRules(ip, adminPassword, sandbox, patterns) {
  const prefix = `vivary:${sandbox}:`;
  const desired = [...new Set(patterns)];
  const agents = await mgmt(ip, adminPassword, 'GET', '/agents');
  const agent = agents.find((a) => a.name === sandbox)
    || die(`egress rule sync: ASHP agent '${sandbox}' not found`);
  const rules = await mgmt(ip, adminPassword, 'GET', '/rules');
  const mine = rules.filter((r) => (r.name || '').startsWith(prefix));

  const wanted = new Set(desired);
  let removed = 0;
  for (const rule of mine) {
    if (!wanted.has(rule.url_pattern)) {
      await mgmt(ip, adminPassword, 'DELETE', `/rules/${rule.id}`);
      removed += 1;
    }
  }
  const have = new Set(mine.map((r) => r.url_pattern));
  let created = 0;
  for (const pattern of desired) {
    if (have.has(pattern)) continue;
    await mgmt(ip, adminPassword, 'POST', '/rules', {
      name: prefix + pattern,
      url_pattern: pattern,
      action: 'allow',
      agent_id: String(agent.id),
    });
    created += 1;
  }
  if (created || removed) {
    console.log(`==> egress: policy synced for '${sandbox}' — ${desired.length} allow rule(s) (+${created}/−${removed})`);
  }
}

// --- `vivary egress` subcommand -------------------------------------------------

export async function cmdEgress(argv) {
  const sub = argv[0] || 'status';
  const runtime = detectRuntime();
  switch (sub) {
    case 'status': {
      const net = netInspect(runtime);
      console.log(`network:  ${net ? `${EGRESS_NET} (${net.subnet}, internal)` : `${EGRESS_NET} not created`}`);
      if (!ashpRunning(runtime)) {
        console.log(`ashp:     not running (starts automatically with the next --egress sandbox)`);
        return;
      }
      const ip = ashpEgressIp(runtime);
      const healthy = ip ? await ashpHealthy(ip) : false;
      console.log(`ashp:     running at ${ip} (${healthy ? 'healthy' : 'NOT answering'})`);
      console.log(`policy:   http://${ip}:${MGMT_PORT}/ (user: admin, password in ${path.join(ASHP_DIR, 'secrets.json')})`);
      break;
    }
    case 'stop': {
      if (!ashpRunning(runtime)) {
        console.log('egress proxy is not running');
        return;
      }
      const r = capture(runtime, ['rm', '-f', ASHP_CONTAINER]);
      if (r.status !== 0) die(`cannot stop ASHP: ${r.stderr || r.stdout}`);
      console.log('==> egress proxy stopped (state kept; restarts with the next --egress sandbox)');
      break;
    }
    case 'logs':
      process.exit(runInherit(runtime, ['logs', ...argv.slice(1), ASHP_CONTAINER]));
      break;
    default:
      die(`unknown egress subcommand: ${sub} (status|stop|logs)`);
  }
}
