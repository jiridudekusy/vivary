// paseo: run a Paseo daemon INSIDE the sandbox and publish it over the tailnet,
// so phone/tablet/desktop clients can drive the sandbox's agents from anywhere.
//
// Why inside: Paseo drives agents on the machine its daemon runs on, using those
// agents' own CLI installs and logins. In vivary all of that lives in the
// container, so a daemon on the Mac has nothing to drive — which is exactly why
// this does not work without the plugin.
//
// Shape (see docs/superpowers/plans/2026-09-20-remote-agent-control-*.md):
//
//   client --tailnet+TLS--> tailscale serve --https=<tsPaseoPort>
//          --loopback-->    127.0.0.1:<paseoPort>   (vivary publish)
//          --container-->   paseo daemon on 0.0.0.0:<paseoPort>
//
// Nothing binds 0.0.0.0 on the host and vivary holds no TLS key: Tailscale
// terminates TLS with a certificate it issues and renews itself.
import fs from 'node:fs';
import path from 'node:path';
import { capture, die, parseArgs, resolveNpmVersion, sanitizeName } from '../../core/util.mjs';
import {
  assignStablePort, loadSandbox, sandboxDir, saveSandbox,
} from '../../core/sandbox.mjs';
import { tailscaleBin, tailscaleStatus } from '../tailscale/plugin.mjs';
import { makeReadablePassword } from './password.mjs';

const PKG = '@getpaseo/cli';

// The daemon's own password, generated once per sandbox. Kept in the sandbox
// state dir (not in the container's -e env, which `container inspect` would
// show) and mounted in, so the entrypoint hook reads it from a file.
export function ensurePassword(dir, log = () => {}) {
  const file = path.join(dir, 'dot-paseo/.vivary-password');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const pw = makeReadablePassword();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${pw}\n`, { mode: 0o600 });
  log(`==> paseo: generated a daemon password (see: vivary paseo <sandbox>)`);
  return pw;
}

export function selfTailnetFqdn(status = tailscaleStatus()) {
  return (status?.Self?.DNSName || '').replace(/\.$/, '') || null;
}

function serveUrl(cfg, fqdn) {
  return fqdn && cfg.tsPaseoPort ? `https://${fqdn}:${cfg.tsPaseoPort}/` : null;
}

// `vivary paseo [name]` — the URL and password, for typing into a second device.
// `up` prints them too, but they scroll away and this is the one thing the owner
// needs while holding a different machine.
export function cmdPaseo(argv = []) {
  const { positionals } = parseArgs(argv, {});
  const name = positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  if (!cfg.paseo) {
    die(`sandbox '${name}' does not run Paseo. Turn it on with: vivary up --paseo`);
  }
  const url = serveUrl(cfg, selfTailnetFqdn());
  const file = path.join(sandboxDir(name), 'dot-paseo/.vivary-password');
  const pw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;

  console.log(`  Sandbox:   ${name}`);
  console.log(`  URL:       ${url || '(tailscale is not reporting this host — is it running?)'}`);
  console.log(`  Password:  ${pw || '(not generated yet — start the sandbox once)'}`);
  console.log('');
  console.log('  In the Paseo app: add a direct daemon connection with that URL and password.');
  console.log('  Both devices must be signed in to the same tailnet.');
}

export default {
  name: 'paseo',
  order: 55,
  commands: { paseo: cmdPaseo },

  flags: {
    paseo: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'paseo',
      help: 'Run a Paseo daemon in the sandbox and publish it over the\ntailnet (sticky), so the Paseo app on a phone, tablet or\nanother desktop can drive this sandbox\'s agents. Implies\n--tailscale. Password-protected and TLS-terminated by\nTailscale; see: vivary paseo <sandbox>',
    },
  },

  // A Paseo daemon IS a way into the sandbox, so it satisfies `vivary up`'s
  // reachability gate on its own.
  inferReachable: (cfg) => !!cfg.paseo,

  // Needs the tailnet publish and the MagicDNS name, so it turns --tailscale on
  // rather than failing on a flag the user plainly implied.
  preUp(ctx, save = saveSandbox) {
    const { cfg, log } = ctx;
    if (!cfg.paseo || cfg.tailscale) return;
    cfg.tailscale = true;
    save(cfg);
    log('==> paseo: enabling --tailscale too (it is how the daemon is reached)');
  },

  buildArgs() {
    const v = resolveNpmVersion(PKG);
    if (!v) {
      console.error(`WARNING: could not resolve the ${PKG} version — building unpinned `
        + '(a cached layer may keep an older Paseo)');
    }
    return { PASEO_VERSION: v || 'latest' };
  },

  async upArgs(ctx) {
    const { cfg, dir, log } = ctx;
    if (!cfg.paseo) return [];

    const port = await assignStablePort(cfg, { key: 'paseoPort', base: 6800 });
    const tsPort = await assignStablePort(cfg, { key: 'tsPaseoPort', base: 8400 });
    ensurePassword(dir, log);

    const stateDir = path.join(dir, 'dot-paseo');
    fs.mkdirSync(stateDir, { recursive: true });

    const fqdn = selfTailnetFqdn();
    if (!fqdn) {
      console.error('WARNING: tailscale is not reporting this host, so the Paseo daemon will '
        + 'be reachable only from this Mac. Start Tailscale and run `vivary up` again.');
    }

    // Published to host LOOPBACK on purpose — `tailscale serve` is the only
    // thing that exposes it, and only to the tailnet. Nothing lands on the LAN.
    return [
      '-p', `127.0.0.1:${port}:${port}`,
      '-v', `${stateDir}:/home/agent/.paseo`,
      '-e', 'SANDBOX_PASEO=1',
      '-e', `PASEO_LISTEN=0.0.0.0:${port}`,
      // The daemon checks the Host header and answers 403 for names it does not
      // know — and clients connect by MagicDNS name, not by IP.
      '-e', `PASEO_HOSTNAMES=${fqdn || ''},.ts.net`,
      // A default daemon downloads ~985 MB of speech models on first start, per
      // sandbox, unasked. Disabling the two features is what stops it; the
      // auto-download flag alone still pulled 218 MB.
      '-e', 'PASEO_DICTATION_ENABLED=0',
      '-e', 'PASEO_VOICE_MODE_ENABLED=0',
      '-e', 'PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0',
    ];
  },

  postUp(ctx) {
    const { cfg, log } = ctx;
    if (!cfg.paseo) return;
    const bin = tailscaleBin();
    const fqdn = selfTailnetFqdn();
    if (!bin || !fqdn) return;   // already warned in upArgs

    const r = capture(bin, ['serve', '--bg', `--https=${cfg.tsPaseoPort}`,
      `http://127.0.0.1:${cfg.paseoPort}`]);
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim();
      console.error(`WARNING: could not publish Paseo on the tailnet: ${msg}`);
      // A machine name with `--` in positions 3-4 is a reserved (R-LDH) label
      // that Let's Encrypt refuses, and the resulting TLS error says nothing.
      if (/cert|tls|acme/i.test(msg) || /--/.test(fqdn.split('.')[0].slice(2, 4))) {
        console.error('    If this is a certificate failure, check the machine name: a `--` in '
          + 'characters 3-4 makes certificates impossible (reserved R-LDH label). Rename it in '
          + 'the Tailscale admin console.');
      }
      console.error(`    The daemon still runs, reachable only from this Mac on 127.0.0.1:${cfg.paseoPort}.`);
      return;
    }
    log(`    Paseo:     ${serveUrl(cfg, fqdn)}  (password: vivary paseo ${cfg.name})`);
  },

  // Every `rm`, not just --purge: a stale serve rule would point a tailnet HTTPS
  // port at a dead loopback port, and the next sandbox to be given that port
  // would silently inherit the URL.
  onRemove(name) {
    const cfg = loadSandbox(name);
    if (!cfg?.tsPaseoPort) return;
    const bin = tailscaleBin();
    if (!bin) return;
    capture(bin, ['serve', `--https=${cfg.tsPaseoPort}`, 'off']);
  },
};
