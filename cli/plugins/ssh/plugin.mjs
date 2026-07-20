// ssh: sshd inside the sandbox for Claude Desktop ("+ Add SSH connection"),
// IDEs and plain ssh. Activated by `vivary up`. Manages the per-sandbox
// keypair, persisted host keys, ~/.ssh/known_hosts entries and a
// marker-delimited ~/.ssh/config Host block on the host.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, capture, die, hasCmd, parseArgs } from '../../core/util.mjs';
import { containerName, containerDnsDomain, isRunning } from '../../core/runtime.mjs';
import { ensureSandbox } from '../../core/sandbox.mjs';
import { cmdUp } from '../../core/lifecycle.mjs';

function registerKnownHosts(dir, host, port) {
  const kh = path.join(HOME, '.ssh/known_hosts');
  const target = String(port) !== '22' ? `[${host}]:${port}` : host;
  fs.mkdirSync(path.dirname(kh), { recursive: true });
  const lines = fs.existsSync(kh) ? fs.readFileSync(kh, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => !(l.split(/\s+/)[0] || '').split(',').includes(target));
  const hostkeysDir = path.join(dir, 'ssh/hostkeys');
  for (const f of fs.readdirSync(hostkeysDir).filter((f) => f.endsWith('.pub'))) {
    const [type, key] = fs.readFileSync(path.join(hostkeysDir, f), 'utf8').trim().split(/\s+/);
    kept.push(`${target} ${type} ${key}`);
  }
  fs.writeFileSync(kh, kept.join('\n').replace(/\n+$/, '') + '\n');
}

// Marker-delimited Host block, PREPENDED: in ssh_config the first obtained
// value wins, so this must precede global defaults (a global
// "UserKnownHostsFile /dev/null" would break Claude Desktop's verification).
function ensureSshConfigEntry(name, host, port, dir) {
  const cfgFile = path.join(HOME, '.ssh/config');
  const begin = `# >>> claude-sandbox:${name} (managed by vivary) >>>`;
  const end = `# <<< claude-sandbox:${name} <<<`;
  const legacy = ['sbx', 'sandbox.sh'].map(
    (t) => `# >>> claude-sandbox:${name} (managed by ${t}) >>>`);
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  let content = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  for (const marker of [begin, ...legacy]) {
    const b = content.indexOf(marker);
    if (b === -1) continue;
    const e = content.indexOf(end, b);
    content = content.slice(0, b) + content.slice(e === -1 ? b : e + end.length + 1);
  }
  const block = [
    begin,
    `Host claude-sandbox-${name}`,
    `    HostName ${host}`,
    '    User agent',
    `    Port ${port}`,
    `    IdentityFile ${path.join(dir, 'ssh/id_ed25519')}`,
    `    UserKnownHostsFile ${path.join(HOME, '.ssh/known_hosts')}`,
    '    StrictHostKeyChecking accept-new',
    end,
    '',
  ].join('\n');
  fs.writeFileSync(cfgFile, block + content);
}

// Remove the managed ~/.ssh/config block and known_hosts entries (on purge).
function removeSshArtifacts(name) {
  const cfgFile = path.join(HOME, '.ssh/config');
  if (fs.existsSync(cfgFile)) {
    let content = fs.readFileSync(cfgFile, 'utf8');
    for (const tool of ['vivary', 'sbx', 'sandbox.sh']) {
      const begin = `# >>> claude-sandbox:${name} (managed by ${tool}) >>>`;
      const end = `# <<< claude-sandbox:${name} <<<`;
      const b = content.indexOf(begin);
      if (b === -1) continue;
      const e = content.indexOf(end, b);
      content = content.slice(0, b) + content.slice(e === -1 ? b : e + end.length + 1);
    }
    fs.writeFileSync(cfgFile, content);
  }
  const kh = path.join(HOME, '.ssh/known_hosts');
  if (fs.existsSync(kh)) {
    const cname = containerName(name);
    const kept = fs.readFileSync(kh, 'utf8').split('\n')
      .filter((l) => !(l.split(/\s+/)[0] || '').split(',')
        .some((h) => h.replace(/^\[|\]:\d+$/g, '').startsWith(`${cname}.`) || h === cname));
    fs.writeFileSync(kh, kept.join('\n'));
  }
}

// `vivary ide [name] [--editor <bin>]` — open a Remote-SSH IDE window
// connected into the sandbox. Rides on the managed ~/.ssh/config alias, so
// it works with any VS Code-family editor; prefers Cursor when installed.
// Implies `vivary up` when the sandbox is not running.
async function cmdIde(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string', editor: 'string' });
  const cfg = await ensureSandbox(flags.name || positionals[0], flags);
  const editor = flags.editor || ['cursor', 'code'].find((c) => hasCmd(c))
    || die("no 'cursor' or 'code' CLI on the host — install the editor's shell command");
  if (!hasCmd(editor)) die(`editor CLI not found: ${editor}`);
  if (!isRunning(cfg.runtime, cfg.name)) await cmdUp([cfg.name]);
  const alias = containerName(cfg.name); // == the managed ssh_config Host
  const r = capture(editor, ['--remote', `ssh-remote+${alias}`, cfg.workspace]);
  if (r.status !== 0) die(`${editor} failed: ${r.stderr || r.stdout}`);
  console.log(`==> ${editor}: opening ${cfg.workspace} on ${alias} (Remote-SSH)`);
}

export default {
  name: 'ssh',
  order: 30,
  commands: { ide: cmdIde },

  async upArgs(ctx) {
    const { cfg, dir, cname } = ctx;
    // Per-sandbox SSH keypair; the public key becomes authorized_keys inside.
    const keyFile = path.join(dir, 'ssh/id_ed25519');
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
      const r = capture('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', cname, '-f', keyFile]);
      if (r.status !== 0) die(`ssh-keygen failed: ${r.stderr}`);
      fs.copyFileSync(`${keyFile}.pub`, path.join(dir, 'ssh/authorized_keys'));
      ctx.log(`==> Generated SSH keypair in ${path.join(dir, 'ssh')}`);
    }

    const args = ['-v', `${path.join(dir, 'ssh')}:/home/agent/host-ssh`, '-e', 'SANDBOX_SSH=1'];
    const domain = cfg.runtime === 'container' ? containerDnsDomain() : '';
    if (domain) {
      ctx.ssh = { host: `${cname}.${domain}`, port: '22' };
    } else {
      ctx.ssh = { host: 'localhost', port: process.env.SSH_PORT || '2222' };
      args.push('-p', `${ctx.ssh.port}:22`);
    }
    return args;
  },

  async postUp(ctx) {
    const { cfg, dir } = ctx;
    // Host keys are generated inside the container on first boot — wait for
    // them, then pre-trust them so Claude Desktop's verification passes.
    const hostkeysDir = path.join(dir, 'ssh/hostkeys');
    const haveKeys = () => fs.existsSync(hostkeysDir)
      && fs.readdirSync(hostkeysDir).some((f) => f.endsWith('.pub'));
    for (let i = 0; i < 30 && !haveKeys(); i++) {
      await new Promise((res) => setTimeout(res, 500));
    }
    if (haveKeys()) registerKnownHosts(dir, ctx.ssh.host, ctx.ssh.port);
    else console.error('WARNING: host keys not available yet; first SSH connect may fail verification');
    ensureSshConfigEntry(cfg.name, ctx.ssh.host, ctx.ssh.port, dir);

    ctx.log(`    SSH config entry added/updated in ~/.ssh/config.

    Connect:        ssh claude-sandbox-${cfg.name}
    Claude Desktop: Code tab -> environment dropdown -> "+ Add SSH connection"
                    -> Host: claude-sandbox-${cfg.name}
                    (user, port and key come from ~/.ssh/config)`);
  },

  onPurge(name) {
    removeSshArtifacts(name);
  },
};
