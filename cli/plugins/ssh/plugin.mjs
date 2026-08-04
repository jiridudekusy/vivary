// ssh: sshd inside the sandbox for Claude Desktop ("+ Add SSH connection"),
// IDEs and plain ssh. Activated by `vivary up`. Manages the per-sandbox
// keypair, persisted host keys, ~/.ssh/known_hosts entries and the managed
// ssh_config include file (<SANDBOXES_DIR>/ssh/config) holding one
// marker-delimited Host block per sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, SANDBOXES_DIR, capture, die, hasCmd, parseArgs } from '../../core/util.mjs';
import { containerName, containerDnsDomain } from '../../core/runtime.mjs';
import { resolveRuntime } from '../../core/runtimes/index.mjs';
import { assignStablePort, ensureSandbox } from '../../core/sandbox.mjs';
import { cmdUp } from '../../core/lifecycle.mjs';

function registerKnownHosts(dir, host, port) {
  const kh = path.join(HOME, '.ssh/known_hosts');
  const target = knownHostsTarget(host, port);
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

// Pure marker-delimited Host block builder — used by both the container
// path (ensureSshConfigEntry below) and the tart vmPostUp path. The begin/end
// markers stay keyed by `name` (so purge/removeSshArtifacts is unaffected by
// the runtime), while the `Host` label itself is the caller-supplied
// `hostAlias` (`claude-sandbox-<name>` for containers, `vivary-<name>` — the
// tart instance name — for macOS VMs).
export function sshConfigBlock({ name, hostAlias, host, user, port, identityFile, knownHosts }) {
  return [
    `# >>> claude-sandbox:${name} (managed by vivary) >>>`,
    `Host ${hostAlias}`,
    `    HostName ${host}`,
    `    User ${user}`,
    `    Port ${port}`,
    `    IdentityFile ${identityFile}`,
    // Without IdentitiesOnly, ssh offers every agent-loaded key first and a
    // well-stocked agent exhausts MaxAuthTries before our key is tried
    // ("Too many authentication failures", seen with Cursor Remote-SSH).
    '    IdentitiesOnly yes',
    `    UserKnownHostsFile ${knownHosts}`,
    '    StrictHostKeyChecking accept-new',
    `# <<< claude-sandbox:${name} <<<`,
    '',
  ].join('\n');
}

// The managed include file: every sandbox Host block lives here, and
// ~/.ssh/config only carries a single `Include` directive pointing at it
// (like Lima/Colima do). Keeps the user's own config untouched and makes
// removal a one-file edit. Under SANDBOXES_DIR, so `vivary rm --purge` and the
// ~/claude-sandboxes -> ~/.vivary migration keep working on it.
export function sshIncludeFile() {
  return path.join(SANDBOXES_DIR, 'ssh/config');
}

const INCLUDE_BEGIN = '# >>> vivary ssh include (managed by vivary) >>>';
const INCLUDE_END = '# <<< vivary ssh include <<<';
// Generations of the tool that ever wrote a managed Host block.
const MANAGED_TOOLS = ['vivary', 'sbx', 'sandbox.sh'];
const INCLUDE_HEADER = [
  '# Managed by vivary — included from ~/.ssh/config.',
  '# Blocks are added by `vivary up` and removed by `vivary rm`; edits inside',
  '# a marker block are overwritten. Anything outside them is left alone.',
  '',
  '',
].join('\n');

// Remove every managed Host block for `name` (any tool generation). Pure.
export function removeBlock(text, name) {
  const end = `# <<< claude-sandbox:${name} <<<`;
  let out = text;
  for (const tool of MANAGED_TOOLS) {
    const begin = `# >>> claude-sandbox:${name} (managed by ${tool}) >>>`;
    for (let b = out.indexOf(begin); b !== -1; b = out.indexOf(begin)) {
      const e = out.indexOf(end, b);
      // No end marker (hand-mangled file): drop just the begin line, so the
      // loop always makes progress.
      const head = out.slice(0, b);
      let tail = out.slice(e === -1 ? b + begin.length : e + end.length + 1);
      // The blank line that separated the block would otherwise pile up on
      // every add/remove cycle.
      if (head === '' || head.endsWith('\n\n')) tail = tail.replace(/^\n+/, '');
      out = head + tail;
    }
  }
  return out;
}

// Replace-or-append a sandbox block, keeping everything else (header,
// other sandboxes, user additions) intact. Pure.
export function upsertBlock(text, name, block) {
  const body = removeBlock(text, name).replace(/\n+$/, '');
  return (body ? `${body}\n\n` : '') + block;
}

// Every managed Host block found in `text`, verbatim — used once, to migrate
// pre-include installs (blocks written straight into ~/.ssh/config). Pure.
export function extractManagedBlocks(text) {
  const re = /^# >>> claude-sandbox:(\S+) \(managed by (?:vivary|sbx|sandbox\.sh)\) >>>$/gm;
  const out = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = `# <<< claude-sandbox:${m[1]} <<<`;
    const e = text.indexOf(end, m.index);
    if (e === -1) continue; // unterminated — removeBlock cleans it up
    out.push({ name: m[1], block: `${text.slice(m.index, e + end.length)}\n` });
  }
  return out;
}

// ~/.ssh/config with the Include directive as its FIRST directive: in
// ssh_config the first obtained value wins, so ours must precede the user's
// global defaults (a global "UserKnownHostsFile /dev/null" later in the file
// would break Claude Desktop's host verification). Pure, idempotent.
export function withIncludeDirective(text, file) {
  const block = `${INCLUDE_BEGIN}\nInclude ${file}\n${INCLUDE_END}\n`;
  if (text.startsWith(block)) return text;
  let out = text;
  const b = out.indexOf(INCLUDE_BEGIN);
  if (b !== -1) {
    const e = out.indexOf(INCLUDE_END, b);
    out = out.slice(0, b)
      + out.slice(e === -1 ? b + INCLUDE_BEGIN.length : e + INCLUDE_END.length + 1);
  }
  return block + out;
}

// Make sure ~/.ssh/config includes the managed file, migrating any Host blocks
// an older vivary wrote directly into it. Returns the include file path and its
// current contents.
function ensureSshInclude() {
  const cfgFile = path.join(HOME, '.ssh/config');
  const incFile = sshIncludeFile();
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.mkdirSync(path.dirname(incFile), { recursive: true });
  let inc = fs.existsSync(incFile) ? fs.readFileSync(incFile, 'utf8') : INCLUDE_HEADER;
  const rawCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  let cfg = rawCfg;
  const legacy = extractManagedBlocks(cfg);
  for (const { name, block } of legacy) {
    inc = upsertBlock(inc, name, block);
    cfg = removeBlock(cfg, name);
  }
  const next = withIncludeDirective(cfg, incFile);
  if (next !== cfg) {
    // First time we touch the user's own config (adding the Include, moving
    // blocks out): keep a copy. Written once — later runs must not overwrite
    // the pre-vivary original with an already-migrated one.
    const bak = `${cfgFile}.vivary.bak`;
    if (rawCfg && !fs.existsSync(bak)) {
      fs.writeFileSync(bak, rawCfg);
      fs.chmodSync(bak, 0o600);
      console.log(`==> Backed up ~/.ssh/config to ${tildePath(bak)} before adding the managed Include`);
    }
    fs.writeFileSync(cfgFile, next);
  }
  if (legacy.length) {
    writeIncludeFile(incFile, inc);
    console.log(`==> Moved ${legacy.length} managed Host block(s) from ~/.ssh/config `
      + `to ${tildePath(incFile)} (now pulled in via Include)`);
  }
  return { incFile, inc };
}

export function tildePath(p) {
  return p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

// ssh applies its strict permission check to Include'd files too ("Bad owner or
// permissions"), so don't leave the mode up to the user's umask.
function writeIncludeFile(file, text) {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o600);
}

// Write (or refresh) the sandbox's Host block in the managed include file.
function ensureSshConfigEntry(name, host, port, dir, { user = 'agent', hostAlias = `claude-sandbox-${name}` } = {}) {
  const { incFile, inc } = ensureSshInclude();
  const block = sshConfigBlock({
    name, hostAlias, host, user, port,
    identityFile: path.join(dir, 'ssh/id_ed25519'),
    knownHosts: path.join(HOME, '.ssh/known_hosts'),
  });
  writeIncludeFile(incFile, upsertBlock(inc, name, block));
}

// HostName + Port inside the managed (vivary) Host block for `name`, or null
// if there is no such block. Pure. This is how a known_hosts line is attributed
// to a sandbox on removal: the block records exactly what registerKnownHosts
// keyed the entry by, so nothing has to be guessed from the entry itself.
export function managedHostEntry(configText, name) {
  const begin = `# >>> claude-sandbox:${name} (managed by vivary) >>>`;
  const b = configText.indexOf(begin);
  if (b === -1) return null;
  const end = `# <<< claude-sandbox:${name} <<<`;
  const e = configText.indexOf(end, b);
  const block = configText.slice(b, e === -1 ? undefined : e);
  const host = block.match(/^\s*HostName\s+(\S+)/m);
  if (!host) return null;
  const port = block.match(/^\s*Port\s+(\S+)/m);
  return { host: host[1], port: port ? port[1] : '22' };
}

export function managedHostName(configText, name) {
  return managedHostEntry(configText, name)?.host ?? null;
}

// The host/port vivary last wrote for `name`, looked up in the include file and
// (pre-include installs) in ~/.ssh/config itself.
function managedEntryFor(name) {
  for (const f of [sshIncludeFile(), path.join(HOME, '.ssh/config')]) {
    if (!fs.existsSync(f)) continue;
    const entry = managedHostEntry(fs.readFileSync(f, 'utf8'), name);
    if (entry) return entry;
  }
  return null;
}

// Drop the sandbox's Host block — from the include file and, for pre-include
// installs, from ~/.ssh/config too. Returns true if anything changed.
function removeSshBlock(name) {
  let changed = false;
  for (const f of [sshIncludeFile(), path.join(HOME, '.ssh/config')]) {
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8');
    const next = removeBlock(content, name);
    if (next === content) continue;
    if (f === sshIncludeFile()) writeIncludeFile(f, next);
    else fs.writeFileSync(f, next);
    changed = true;
  }
  return changed;
}

// How ssh keys a known_hosts entry: bare host on :22, [host]:port otherwise.
// One definition for both the writer (registerKnownHosts) and the remover.
export function knownHostsTarget(host, port) {
  return String(port) !== '22' ? `[${host}]:${port}` : host;
}

// Drop known_hosts lines whose first (comma-separated) host token equals
// `target` exactly. Pure — separated from removeSshArtifacts so it's testable
// without touching the filesystem.
export function withoutKnownHostsTarget(knownHostsText, target) {
  return knownHostsText.split('\n')
    .filter((l) => !(l.split(/\s+/)[0] || '').split(',').includes(target))
    .join('\n');
}

// Remove the managed Host block and known_hosts entries (on purge). Only
// entries vivary provably wrote for THIS sandbox are touched: the exact target
// recorded in the Host block (host + port — this is what catches docker's
// published `[localhost]:2222`, which the container-name match below cannot
// see), plus container-DNS names derived from the sandbox name. Anything else
// in known_hosts is left alone — an unattributable leftover is the user's.
function removeSshArtifacts(name) {
  // Read the block BEFORE dropping it — the known_hosts cleanup is keyed by it.
  const entry = managedEntryFor(name);
  removeSshBlock(name);
  const kh = path.join(HOME, '.ssh/known_hosts');
  if (!fs.existsSync(kh)) return;
  const cname = containerName(name);
  let kept = fs.readFileSync(kh, 'utf8').split('\n')
    .filter((l) => !(l.split(/\s+/)[0] || '').split(',')
      .some((h) => h.replace(/^\[|\]:\d+$/g, '').startsWith(`${cname}.`) || h === cname));
  // Covers the docker publish (`[localhost]:<sshPort>`) and the tart guest,
  // which vmPostUp registers by its (DHCP) IP — neither looks like a container
  // hostname, so only the block tells us which line was ours.
  if (entry) kept = withoutKnownHostsTarget(kept.join('\n'), knownHostsTarget(entry.host, entry.port)).split('\n');
  fs.writeFileSync(kh, kept.join('\n'));
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
  const rt = resolveRuntime(cfg.runtime);
  if (!rt.isRunning(cfg.name)) await cmdUp([cfg.name]);
  const alias = rt.instanceName(cfg.name); // == the managed ssh_config Host label
  const r = capture(editor, ['--remote', `ssh-remote+${alias}`, cfg.workspace]);
  if (r.status !== 0) die(`${editor} failed: ${r.stderr || r.stdout}`);
  console.log(`==> ${editor}: opening ${cfg.workspace} on ${alias} (Remote-SSH)`);
}

// Per-sandbox ed25519 keypair (shared by the container and tart paths). The
// public key becomes authorized_keys inside the guest/container.
function ensureKeypair(dir, cname, log) {
  const keyFile = path.join(dir, 'ssh/id_ed25519');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
    const r = capture('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', cname, '-f', keyFile]);
    if (r.status !== 0) die(`ssh-keygen failed: ${r.stderr}`);
    fs.copyFileSync(`${keyFile}.pub`, path.join(dir, 'ssh/authorized_keys'));
    log(`==> Generated SSH keypair in ${path.join(dir, 'ssh')}`);
  }
  return keyFile;
}

export default {
  name: 'ssh',
  order: 30,
  commands: { ide: cmdIde },

  async upArgs(ctx) {
    const { cfg, dir, cname } = ctx;
    // Per-sandbox SSH keypair; the public key becomes authorized_keys inside.
    ensureKeypair(dir, cname, ctx.log);

    const args = ['-v', `${path.join(dir, 'ssh')}:/home/agent/host-ssh`, '-e', 'SANDBOX_SSH=1'];
    const domain = cfg.runtime === 'container' ? containerDnsDomain() : '';
    if (domain) {
      ctx.ssh = { host: `${cname}.${domain}`, port: '22' };
    } else {
      // Docker has no per-container DNS name, so sshd is published on the host.
      // The port is per-sandbox and persisted (2222 while it is free, so a
      // single-sandbox setup is unchanged): a fixed 2222 made the SECOND docker
      // sandbox fail to start with "port is already allocated". Bound to
      // loopback, since the ~/.ssh/config alias and `vivary ide` connect
      // locally — EXCEPT with --tailscale, where reaching the sandbox from
      // another tailnet device is the whole point (on docker that plugin reuses
      // this publish instead of adding its own).
      const port = process.env.SSH_PORT
        || await assignStablePort(cfg, { key: 'sshPort', base: 2222, preferred: 2222 });
      ctx.ssh = { host: 'localhost', port: String(port) };
      args.push('-p', `${cfg.tailscale ? '0.0.0.0' : '127.0.0.1'}:${port}:22`);
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

    ctx.log(`    SSH config entry added/updated in ${tildePath(sshIncludeFile())} (Include'd from ~/.ssh/config).

    Connect:        ssh claude-sandbox-${cfg.name}
    Claude Desktop: Code tab -> environment dropdown -> "+ Add SSH connection"
                    -> Host: claude-sandbox-${cfg.name}
                    (user, port and key come from ~/.ssh/config)`);
  },

  // tart: the guest already runs sshd (cirruslabs base, user `admin`). After
  // the VM is booted, inject our per-sandbox pubkey, then register the host
  // known_hosts + ~/.ssh/config alias pointing at the guest's (DHCP) IP.
  async vmPostUp(ctx) {
    const { cfg, dir } = ctx;
    const rt = resolveRuntime(cfg.runtime);
    const vm = rt.instanceName(cfg.name);
    const keyFile = ensureKeypair(dir, vm, ctx.log);
    const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();

    // Append the pubkey to the guest's authorized_keys (idempotent).
    const inject = [
      'exec', vm, '/bin/zsh', '-lc',
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `grep -qxF ${JSON.stringify(pub)} ~/.ssh/authorized_keys || echo ${JSON.stringify(pub)} >> ~/.ssh/authorized_keys`,
    ];
    if (capture('tart', inject).status !== 0) {
      console.error('WARNING: could not inject SSH key into the guest; ssh alias may not authenticate');
    }

    const ip = rt.ip(vm);
    if (!ip) {
      console.error('WARNING: no guest IP yet; skipping SSH host registration'); return;
    }
    // Trust the guest host key (ssh-keyscan; the guest generated it at first boot).
    const kh = path.join(HOME, '.ssh/known_hosts');
    const scan = capture('ssh-keyscan', ['-T', '5', ip]);
    if (scan.status === 0 && scan.stdout) {
      fs.mkdirSync(path.dirname(kh), { recursive: true });
      const existing = fs.existsSync(kh) ? fs.readFileSync(kh, 'utf8').split('\n') : [];
      const kept = existing.filter((l) => (l.split(/\s+/)[0] || '') !== ip);
      fs.writeFileSync(kh, [...kept, scan.stdout.trim()].join('\n').replace(/\n+$/, '') + '\n');
    } else {
      console.error('WARNING: ssh-keyscan of the guest failed; first connect may prompt to trust the host key');
    }
    ensureSshConfigEntry(cfg.name, ip, '22', dir, { user: 'admin', hostAlias: vm });
    ctx.log(`    SSH config entry added/updated in ${tildePath(sshIncludeFile())} (Include'd from ~/.ssh/config).

    Connect:  ssh ${vm}
    IDE:      vivary ide ${cfg.name}`);
  },

  // The instance is gone, so the alias is dead — drop the block on every `rm`,
  // not just `--purge` (a later `up` writes it back). Runs after onPurge, which
  // still needs the block's HostName for its known_hosts cleanup.
  onRemove(name) {
    if (removeSshBlock(name)) {
      console.log(`==> SSH config entry for '${name}' removed from ${tildePath(sshIncludeFile())}.`);
    }
  },

  onPurge(name) {
    removeSshArtifacts(name);
  },
};
