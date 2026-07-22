// tailscale: make sandboxes first-class citizens of the host's tailnet.
//
// OUT (sandbox -> tailnet): raw 100.x connectivity already works through the
// host's NAT; what's missing is name resolution — the container's DNS knows
// nothing about MagicDNS. We snapshot `tailscale status --json` at every
// start and inject peer names (short + FQDN) into the container's
// /etc/hosts via a sudo helper hook.
//
// IN (tailnet -> sandbox): `vivary up` publishes the sandbox's sshd on a
// stable per-sandbox host port, so other tailnet devices reach it at
// <host-magicdns>:<port> (Claude Desktop, ssh, IDEs). Docker publishes via
// the ssh plugin already; Apple `container` needs the explicit publish
// (container IPs are host-internal).
import fs from 'node:fs';
import path from 'node:path';
import { capture, hasCmd, readJson } from '../../core/util.mjs';
import { listSandboxNames, sandboxDir, saveSandbox } from '../../core/sandbox.mjs';

function tailscaleBin() {
  if (hasCmd('tailscale')) return 'tailscale';
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return fs.existsSync(app) ? app : null;
}

function tailscaleStatus() {
  const bin = tailscaleBin();
  if (!bin) return null;
  const r = capture(bin, ['status', '--json']);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// "<ip> <fqdn> <short>" lines for self + all peers.
function hostsLines(status) {
  const lines = [];
  for (const node of [status.Self, ...Object.values(status.Peer || {})]) {
    const ip = node?.TailscaleIPs?.[0];
    const fqdn = (node?.DNSName || '').replace(/\.$/, '');
    if (!ip || !fqdn) continue;
    lines.push(`${ip} ${fqdn} ${fqdn.split('.')[0]}`);
  }
  return lines;
}

// Stable per-sandbox port for the tailnet-facing sshd publish.
function assignSshPort(cfg) {
  if (cfg.tsSshPort) return cfg.tsSshPort;
  const used = new Set(
    listSandboxNames()
      .map((n) => readJson(path.join(sandboxDir(n), 'sandbox.json'))?.tsSshPort)
      .filter(Boolean)
  );
  let port = 22000 + [...cfg.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 900;
  while (used.has(port)) port += 1;
  cfg.tsSshPort = port;
  saveSandbox(cfg);
  return port;
}

export default {
  name: 'tailscale',
  order: 35,
  flags: {
    tailscale: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'tailscale',
      help: 'Tailnet integration (sticky): MagicDNS peer names resolve\ninside the sandbox (injected into /etc/hosts from\n`tailscale status` at every start), and `vivary up`\npublishes sshd on a stable per-sandbox port so other\ntailnet devices can reach the sandbox.',
    },
  },

  runArgs({ cfg, dir, log }) {
    if (!cfg.tailscale) return [];
    const status = tailscaleStatus();
    if (!status) {
      console.error('WARNING: --tailscale enabled but tailscale is not running on the host');
      return [];
    }
    const lines = hostsLines(status);
    fs.mkdirSync(path.join(dir, 'dot-config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dot-config/tailscale-hosts'), lines.join('\n') + '\n');
    log(`==> tailscale: ${lines.length} tailnet name(s) injected`);
    return ['-e', 'SANDBOX_TAILSCALE=1'];
  },

  upArgs(ctx) {
    const { cfg } = ctx;
    if (!cfg.tailscale) return [];
    ctx.tsStatus = tailscaleStatus();
    if (cfg.runtime === 'docker') return []; // ssh plugin already publishes
    const port = assignSshPort(cfg);
    return ['-p', `${port}:22`];
  },

  postUp(ctx) {
    const { cfg } = ctx;
    if (!cfg.tailscale || !ctx.tsStatus) return;
    const selfFqdn = (ctx.tsStatus.Self?.DNSName || '').replace(/\.$/, '');
    const port = cfg.runtime === 'docker'
      ? (process.env.SSH_PORT || '2222')
      : cfg.tsSshPort;
    ctx.log(`    Tailnet:   ssh -p ${port} agent@${selfFqdn}
               (identity file: ~/.vivary/${cfg.name}/ssh/id_ed25519 on this host;
                copy it to the client, e.g. scp ${selfFqdn}:.vivary/${cfg.name}/ssh/id_ed25519 .)`);
  },
};
