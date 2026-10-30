// web: `vivary web` — the tailnet management UI (see server.mjs for why it is a
// separate, loopback-bound server rather than a route on the broker).
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOXES_DIR } from '../../core/util.mjs';
import { capture, die, parseArgs, runInherit } from '../../core/util.mjs';
import { WEB_PORT, createServer, selfTailnetFqdn } from './server.mjs';

const TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailscaleBin() {
  return fs.existsSync(TAILSCALE_BIN) ? TAILSCALE_BIN : 'tailscale';
}

// One tailnet login per line; blank lines and # comments ignored. --allow wins.
export function readAllowFile(cliAllow, file = path.join(SANDBOXES_DIR, 'web-allow')) {
  if (cliAllow) return String(cliAllow).split(',').map((x) => x.trim()).filter(Boolean);
  if (!fs.existsSync(file)) return null;         // null = fall back to the tailnet owner
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  return lines.length ? lines : null;
}

export function cmdWeb(argv = []) {
  const { flags } = parseArgs(argv, {
    port: 'string', 'tailnet-port': 'string', https: 'boolean', allow: 'string',
    'no-serve': 'boolean', stop: 'boolean',
  });
  const port = Number(flags.port || WEB_PORT);
  const bin = tailscaleBin();

  if (flags.stop) {
    const share = flags.https ? '--https=443' : `--http=${Number(flags['tailnet-port'] || 8737)}`;
    runInherit(bin, ['serve', share, 'off']);
    console.log('==> tailnet share stopped (the server itself exits with its terminal)');
    return;
  }

  // Allowlist of tailnet logins. Kept OUT of vivary.json on purpose: that file
  // is agent-writable and sits behind the approval gate, and an agent must not
  // be able to propose who may drive the management UI.
  const server = createServer({ allow: readAllowFile(flags.allow) });
  // LOOPBACK ONLY. A sandbox cannot reach the host's 127.0.0.1, which is what
  // keeps this management surface away from the agents; tailscale serve is what
  // makes it reachable from a phone.
  server.listen(port, '127.0.0.1', () => {
    console.log(`==> vivary web on http://127.0.0.1:${port}`);
    if (flags['no-serve']) {
      console.log('    --no-serve: local only, not shared to the tailnet.');
      return;
    }
    const fqdn = selfTailnetFqdn();
    if (!fqdn) {
      console.error('WARNING: tailscale is not reporting this host — serving locally only. '
        + 'Start Tailscale, then re-run.');
      return;
    }
    // Plain HTTP on a port of our own by default, NOT --https=443. Two reasons:
    // :443 seizes the tailnet root of the whole host, and HTTPS needs the
    // tailnet's HTTPS-certificates feature — without it the handshake dies with
    // "tlsv1 alert internal error" and the page simply never loads. Tailnet
    // traffic is WireGuard-encrypted either way. Pass --https once certificates
    // are enabled in the admin console; it buys a secure context, which is what
    // the one-tap clipboard copy needs.
    const tailnetPort = Number(flags['tailnet-port'] || 8737);
    const share = flags.https ? '--https=443' : `--http=${tailnetPort}`;
    const r = capture(bin, ['serve', '--bg', share, `http://127.0.0.1:${port}`]);
    if (r.status !== 0) {
      console.error(`WARNING: could not share to the tailnet: ${(r.stderr || r.stdout).trim()}`);
      console.error(`    The UI still runs locally at http://127.0.0.1:${port}`);
      return;
    }
    const base = flags.https ? `https://${fqdn}/` : `http://${fqdn}:${tailnetPort}/`;
    console.log(`==> On your iPad/iPhone (same tailnet):  ${base}`);
    if (!flags.https) {
      console.log('    (plain HTTP over WireGuard. Enable HTTPS certificates in the');
      console.log('     Tailscale admin console, then use --https for one-tap copy.)');
    }
    console.log('    Stop sharing with: vivary web --stop');
  });
  server.on('error', (e) => die(`vivary web failed to start: ${e.message}`));
}

export default {
  name: 'web',
  order: 95,
  commands: { web: cmdWeb },
};
