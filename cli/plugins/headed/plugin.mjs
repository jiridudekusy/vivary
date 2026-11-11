// headed: GUI stack (Xvfb + openbox + x11vnc) so the user can watch and drive
// the agent's browser — through `vivary web`, behind its passkey.
//
// Sticky, like every other host integration: `create --headed` used to be
// forgotten at once (the flag only applied to the command it was given to),
// so the GUI never came up on the next start.
//
// SECURITY — VNC never touches the network. History: noVNC was served on
// 0.0.0.0:6080 without a password (verified: agent-sandbox could open findmy's
// browser while it held an iCloud login), then behind VNC's own password,
// which the protocol cuts to 8 characters, plus a per-sandbox tailnet share.
// Now x11vnc listens on the sandbox's 127.0.0.1 only, and the one viewer is
// `vivary web` (web/vnc.mjs): per viewer it runs `<runtime> exec -i
// <container> vnc-relay` and carries the RFB stream over the runtime's exec
// channel. So: no port another sandbox could reach (no firewall needed —
// which would have wanted CAP_NET_ADMIN, absent from the default capability
// set), and no password or token at all, so nothing to store, print or leak.
// Whoever can run `container exec` on the Mac owns every sandbox anyway.
//
// The stack starts live (start-gui is idempotent), so turning headed on needs
// no --recreate on either runtime. A container made from an older image has
// no vnc-relay (and serves noVNC on its network): it is told to --recreate.
import fs from 'node:fs';
import path from 'node:path';
import { capture, die, parseArgs } from '../../core/util.mjs';
import { loadSandbox, resolveName, sandboxDir, saveSandbox } from '../../core/sandbox.mjs';
import { effectiveSandbox } from '../../core/effective.mjs';
import { tailscaleBin } from '../tailscale/plugin.mjs';
import { WEB_PORT, selfTailnetFqdn } from '../web/server.mjs';
import { readServerInfo } from '../web/auth.mjs';
import { DEFAULT_TAILNET_PORT, webOrigin } from '../web/plugin.mjs';

const RUNTIMES = ['container', 'docker'];

// Where the screen opens: the running web's own address, or the one it will
// have when started with defaults.
export function screenLines(name, { info = readServerInfo(), fqdn = selfTailnetFqdn } = {}) {
  const origin = info?.origin
    || webOrigin({ fqdn: fqdn(), tailnetPort: DEFAULT_TAILNET_PORT, port: WEB_PORT }).origin;
  const lines = [`${origin}/vnc/${encodeURIComponent(name)}`];
  if (!info) lines.push('vivary web is not running — start it with: vivary web');
  return lines;
}

// Leftovers of the old design: a tailnet share of noVNC (with --tailscale) and
// the VNC password, in plaintext on the Mac. Neither is used any more.
function dropLegacy(cfg, { keepPassword = false } = {}) {
  let changed = false;
  if (cfg?.tsNovncPort) {
    const bin = tailscaleBin();
    if (bin) capture(bin, ['serve', `--https=${cfg.tsNovncPort}`, 'off']);
    delete cfg.tsNovncPort;
    changed = true;
  }
  // A container still on the old image prompts for it until --recreate.
  if (!keepPassword && cfg?.name) fs.rmSync(path.join(sandboxDir(cfg.name), 'vnc-password'), { force: true });
  return changed;
}

// Start the stack in a running container. True when a screen is there to
// relay; otherwise says why (loudly) and returns false.
function startGui(cfg, cname) {
  const probe = capture(cfg.runtime, ['exec', cname, 'test', '-x', '/usr/local/bin/vnc-relay'], { timeout: 30000 });
  if (probe.status === 1) {
    console.error(`WARNING: headed: '${cfg.name}' was made from an image older than screens through vivary web\n`
      + '    (its GUI would still be served on the network). Rebuild it once:\n'
      + `    vivary up ${cfg.name} --recreate`);
    return false;
  }
  // setsid -w: the stack must outlive the exec session, and the call returns
  // once start-gui has it running.
  const r = probe.status === 0
    ? capture(cfg.runtime, ['exec', cname, 'setsid', '-w', 'start-gui'], { timeout: 60000 })
    : probe;
  if (r.status !== 0) {
    console.error(`WARNING: headed: GUI did not start: ${(r.stderr || r.stdout || '').trim()}`);
    return false;
  }
  return true;
}

async function cmdHeaded(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = resolveName(flags.name || positionals[0], process.cwd());
  // Resolved like a start (the flag may come from a profile or .vivary.json).
  const cfg = effectiveSandbox(name) || die(`sandbox '${name}' does not exist`);
  if (!cfg.headed) die(`'${name}' is not headed — start it with: vivary up ${name} --headed`);
  for (const line of screenLines(name)) console.log(line);
  if (!loadSandbox(name)?.vncRelay) console.log(`(no screen until the next start: vivary up ${name})`);
}

export default {
  name: 'headed',
  order: 20,
  commands: { headed: cmdHeaded },
  flags: {
    headed: {
      type: 'boolean',
      sticky: true,
      // Not in the generic snapshot: postUp starts the GUI live.
      snapshot: false,
      help: 'GUI stack in the sandbox (sticky): watch and drive the\nagent\'s browser in vivary web (passkey login). The\naddress is printed on start; again with: vivary headed <name>',
    },
  },
  // Containers from before baked a noVNC publish in and recorded `headed` in
  // their snapshot. Echo the saved value back, so that alone is no reason to
  // refuse them (postUp asks for the --recreate their old image needs); it
  // stays an inert constant after.
  containerSnapshot: (cfg) => (cfg.containerConfig && 'headed' in cfg.containerConfig
    ? { headed: cfg.containerConfig.headed } : {}),
  async runArgs(ctx) {
    return ctx.cfg.headed ? ['-e', 'HEADED=1'] : [];
  },
  // Start (or confirm) the stack, record whether the web can relay a screen
  // (`vncRelay`, read by web/vnc.mjs without re-resolving profiles), and print
  // where to open it. Idempotent: the boot hook may have started it already.
  async postUp(ctx) {
    const { cfg, cname } = ctx;
    const ok = !!cfg.headed && RUNTIMES.includes(cfg.runtime) && startGui(cfg, cname);
    let changed = dropLegacy(cfg, { keepPassword: !!cfg.headed && !ok });
    if (ok !== !!cfg.vncRelay) {
      if (ok) cfg.vncRelay = true;
      else delete cfg.vncRelay;
      changed = true;
    }
    if (changed) saveSandbox(cfg);
    if (!ok) return;
    const [url, ...rest] = screenLines(cfg.name);
    ctx.log(`==> Headed: watch and drive the browser at\n    ${url}  (vivary web, passkey)`
      + rest.map((l) => `\n    ${l}`).join(''));
  },

  // Every rm: a legacy tailnet share must not outlive the container, and the
  // next container (new image) has no use for the old password.
  onRemove(name, cfg) {
    dropLegacy(cfg || loadSandbox(name));
  },
};
