// web: `vivary web` — the tailnet management UI (see server.mjs for why it is a
// separate, loopback-bound server rather than a route on the broker), behind a
// passkey (auth.mjs). `vivary web enroll` registers the first passkey.
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOXES_DIR } from '../../core/util.mjs';
import { capture, die, parseArgs, runInherit } from '../../core/util.mjs';
import { WEB_PORT, createServer, selfTailnetFqdn } from './server.mjs';
import {
  ENROLL_TTL_MS, clearServerInfo, createAuth, createEnrollToken, readServerInfo, webauthnLib, writeServerInfo,
} from './auth.mjs';

const TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const DEFAULT_TAILNET_PORT = 8737;

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

// Where the page lives decides where its passkeys live: a passkey is bound to
// the host name. HTTPS on the Mac's tailnet name (WebAuthn needs a secure
// context, and plain HTTP is one only on localhost), or localhost when there is
// no tailnet. ONE address — a passkey made on one does not work on the other.
export function webOrigin({ fqdn, tailnetPort, port }) {
  if (fqdn) {
    return { origin: `https://${fqdn}${tailnetPort === 443 ? '' : `:${tailnetPort}`}`, rpId: fqdn, secure: true };
  }
  return { origin: `http://localhost:${port}`, rpId: 'localhost', secure: false };
}

// The first passkey, and the way back in when all are lost: only from this
// Mac. The link carries a one-time token in its fragment; vivary opens it in
// the browser and never prints it (scrollback, agent transcripts).
function cmdWebEnroll() {
  const info = readServerInfo();
  if (!info) die('vivary web is not running. Start it first (`vivary web`), then run `vivary web enroll` in another terminal.');
  const token = createEnrollToken({ origin: info.origin });
  const r = capture('open', [`${info.origin}/#enroll=${token}`]);
  if (r.status !== 0) die(`could not open the browser: ${(r.stderr || r.stdout).trim()}`);
  console.log(`==> Opened ${info.origin} in your browser to register a passkey.`);
  console.log(`    The link works once, for ${ENROLL_TTL_MS / 60000} minutes. If the page did not open, run this again.`);
  console.log('    With iCloud Keychain the passkey also reaches your iPhone and iPad.');
}

export async function cmdWeb(argv = []) {
  if (argv[0] === 'enroll') return cmdWebEnroll();
  const { flags } = parseArgs(argv, {
    port: 'string', 'tailnet-port': 'string', https: 'boolean', allow: 'string',
    'no-serve': 'boolean', stop: 'boolean',
  });
  const port = Number(flags.port || WEB_PORT);
  // --https is the old spelling of "the tailnet root": HTTPS is always on now.
  const tailnetPort = flags.https ? 443 : Number(flags['tailnet-port'] || DEFAULT_TAILNET_PORT);
  const bin = tailscaleBin();

  if (flags.stop) {
    runInherit(bin, ['serve', `--https=${tailnetPort}`, 'off']);
    console.log('==> tailnet share stopped (the server itself exits with its terminal)');
    return;
  }

  try {
    await webauthnLib();
  } catch (e) {
    die(e.message);
  }

  let fqdn = null;
  if (!flags['no-serve']) {
    fqdn = selfTailnetFqdn();
    if (!fqdn) {
      console.error('WARNING: tailscale is not reporting this host — serving on localhost only. '
        + 'Start Tailscale, then re-run.');
    }
  }
  const { origin, rpId, secure } = webOrigin({ fqdn, tailnetPort, port });
  const auth = createAuth({ rpId, origin, secureCookie: secure, log: (m) => console.log(`[web] ${m}`) });

  // Allowlist of tailnet logins. Kept OUT of vivary.json on purpose: that file
  // is agent-writable and sits behind the approval gate, and an agent must not
  // be able to propose who may drive the management UI.
  const server = createServer({ allow: readAllowFile(flags.allow), auth });
  server.on('error', (e) => die(`vivary web failed to start: ${e.message}`));
  // LOOPBACK ONLY: an Apple `container` guest cannot reach the host's
  // 127.0.0.1; tailscale serve is what makes it reachable from a phone.
  server.listen(port, '127.0.0.1', () => {
    writeServerInfo({ origin, rpId, port });
    process.on('exit', () => clearServerInfo());
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
    console.log(`==> vivary web on http://127.0.0.1:${port}`);

    if (fqdn) {
      // A share made with --bg outlives this process; an older vivary served
      // plain HTTP on this port, and serve cannot hold both on one port.
      capture(bin, ['serve', `--http=${tailnetPort}`, 'off']);
      const r = capture(bin, ['serve', '--bg', `--https=${tailnetPort}`, `http://127.0.0.1:${port}`]);
      if (r.status !== 0) {
        console.error(`WARNING: could not share to the tailnet: ${(r.stderr || r.stdout).trim()}`);
        console.error('    HTTPS needs "HTTPS certificates" enabled in the Tailscale admin console.');
      }
    }
    console.log(`==> Open: ${origin}/`);
    if (fqdn) console.log('    (on the Mac too — a passkey belongs to this one address)');
    if (!auth.configured()) {
      console.log('==> No passkey yet. In another terminal on this Mac:  vivary web enroll');
    }
    if (fqdn) console.log(`    Stop sharing with: vivary web --stop${flags.https ? ' --https' : ''}`);
  });
}

export default {
  name: 'web',
  order: 95,
  commands: { web: cmdWeb },
};
