// headed: GUI stack (Xvfb + x11vnc + noVNC) so the user can watch and drive
// the agent's browser from the host.
//
// Sticky, like every other host integration: `create --headed` used to be
// forgotten at once (the flag only applied to the command it was given to),
// so the GUI never came up on the next start.
//
// The stack can be started LIVE with `start-gui` (it is idempotent), so on
// Apple `container` a kept container gets it from postUp without --recreate.
// On docker the noVNC port publish is baked in at creation, so there `headed`
// is part of the container snapshot and switching it asks for --recreate.
//
// SECURITY: the VNC server used to run without a password, reachable by every
// other sandbox on the same network — verified, agent-sandbox could open
// findmy's VNC while that browser held an iCloud login. Each sandbox now gets
// its own password, kept on the Mac (~/.vivary/<name>/vnc-password, 0600) and
// passed in at start; x11vnc listens on localhost only, so the one way in is
// noVNC with that password. VNC auth truncates passwords to 8 characters.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { capture, die, parseArgs } from '../../core/util.mjs';
import { containerDnsDomain, containerName } from '../../core/runtime.mjs';
import { assignStablePort, loadSandbox, resolveName, sandboxDir } from '../../core/sandbox.mjs';

const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFHJKLMNPQRTUVWXY3479'; // no 0/O, 1/l/I, 2/Z, 5/S, 6/G, 8/B
const PW_LENGTH = 8; // VNC's own limit

export function generateVncPassword(randomInt = crypto.randomInt) {
  let pw = '';
  for (let i = 0; i < PW_LENGTH; i++) pw += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return pw;
}

export function vncPassword(name) {
  const file = path.join(sandboxDir(name), 'vnc-password');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${generateVncPassword()}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// Where the browser can be watched from the Mac. Apple `container` VMs are
// reachable by name through the container DNS domain, so nothing needs
// publishing and several headed sandboxes coexist. Docker publishes a stable
// per-sandbox port on 127.0.0.1 — it used to be a fixed 6080 on every
// interface, which put the browser on the LAN and made a second headed docker
// sandbox fail with "port is already allocated".
export function novncUrl({ runtime, cname, domain, port, password }) {
  const base = runtime === 'container' && domain
    ? `http://${cname}.${domain}:6080`
    : `http://localhost:${port}`;
  return `${base}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(password)}`;
}

async function urlFor(cfg, cname) {
  const domain = cfg.runtime === 'container' ? containerDnsDomain() : '';
  const port = domain ? null : await assignStablePort(cfg, { key: 'novncPort', base: 6080, preferred: 6080 });
  return { url: novncUrl({ runtime: cfg.runtime, cname, domain, port, password: vncPassword(cfg.name) }), port };
}

async function cmdHeaded(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = resolveName(flags.name || positionals[0], process.cwd());
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  if (!cfg.headed) die(`'${name}' is not headed — start it with: vivary up ${name} --headed`);
  const { url } = await urlFor(cfg, containerName(name));
  console.log(url);
}

export default {
  name: 'headed',
  order: 20,
  commands: { headed: cmdHeaded },
  flags: {
    headed: {
      type: 'boolean',
      sticky: true,
      // Not in the generic snapshot: on Apple `container` postUp starts the
      // GUI live. containerSnapshot below adds it back where it IS baked in.
      snapshot: false,
      help: 'GUI stack in the sandbox (sticky): the agent\'s browser is\nvisible and drivable via noVNC, password-protected.\nURL is printed on start; again with: vivary headed <name>',
    },
  },
  containerSnapshot: (cfg) => (cfg.runtime === 'docker' ? { headed: !!cfg.headed } : {}),
  async runArgs(ctx) {
    const { cfg, cname } = ctx;
    if (!cfg.headed) return [];
    const { port } = await urlFor(cfg, cname);
    return [
      '-e', 'HEADED=1',
      '-e', `VIVARY_VNC_PASSWORD=${vncPassword(cfg.name)}`,
      ...(port ? ['-p', `127.0.0.1:${port}:6080`] : []),
    ];
  },
  // Start (or confirm) the stack and print where to watch it. Idempotent:
  // the boot hook may have started it already; a kept container created
  // without --headed gets it here. setsid -w: the stack must outlive the exec
  // session, and the call returns once start-gui has it running.
  async postUp(ctx) {
    const { cfg, cname } = ctx;
    if (!cfg.headed || !['container', 'docker'].includes(cfg.runtime)) return;
    const r = capture(cfg.runtime, ['exec', '-e', `VIVARY_VNC_PASSWORD=${vncPassword(cfg.name)}`,
      cname, 'setsid', '-w', 'start-gui'], { timeout: 60000 });
    if (r.status !== 0) {
      console.error(`WARNING: headed: GUI did not start: ${(r.stderr || r.stdout).trim()}`);
      return;
    }
    const { url } = await urlFor(cfg, cname);
    ctx.log(`==> Headed: watch and drive the browser at\n    ${url}`);
  },
};
