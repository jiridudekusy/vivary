#!/usr/bin/env node
// vivary — run AI agents (Claude Code, Codex) in isolated containers
// (Docker or Apple `container`) while sharing chat history, login and
// selected configuration with the host.
//
// Also installed as agent launchers that dispatch on the binary name:
//   slaude = vivary start --agent claude -- <args>
//   sodex  = vivary start --agent codex  -- <args>

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const HOME = os.homedir();
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || path.join(HOME, 'claude-sandboxes');
const HOST_CLAUDE_DIR = path.join(HOME, '.claude');
const HOST_CLAUDE_JSON = path.join(HOME, '.claude.json');
const IMAGE = process.env.SANDBOX_IMAGE || 'agent-sandbox-agents';
const REPO_DIR = path.resolve(__dirname, '..');
const IS_TTY = process.stdin.isTTY && process.stdout.isTTY;

// Agent launchers: binary name -> agent command inside the container.
const AGENTS = {
  claude: { cmd: 'claude' },
  codex: { cmd: 'codex' },
};
const AGENT_BINS = { slaude: 'claude', sodex: 'codex' };

// ----------------------------------------------------------------- helpers --

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function hasCmd(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runInherit(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

function detectRuntime() {
  if (process.env.SANDBOX_RUNTIME) return process.env.SANDBOX_RUNTIME;
  if (hasCmd('container')) return 'container';
  if (hasCmd('docker')) return 'docker';
  die("neither 'container' nor 'docker' found on PATH");
}

function containerName(name) {
  return `claude-sandbox-${name}`;
}

// Names of running containers, per runtime. Missing runtime -> empty set.
function runningSet(runtime) {
  if (!hasCmd(runtime)) return new Set();
  if (runtime === 'docker') {
    const { status, stdout } = capture('docker', ['ps', '--format', '{{.Names}}']);
    return new Set(status === 0 ? stdout.split('\n').filter(Boolean) : []);
  }
  const { status, stdout } = capture('container', ['ls']);
  if (status !== 0) return new Set();
  return new Set(
    stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  );
}

function isRunning(runtime, name) {
  return runningSet(runtime).has(containerName(name));
}

// Local DNS domain assigned to Apple `container` VMs (empty if unconfigured).
function containerDnsDomain() {
  try {
    const toml = fs.readFileSync(path.join(HOME, '.config/container/config.toml'), 'utf8');
    const m = toml.match(/^\s*domain\s*=\s*"([^"]+)"/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function sanitizeName(s) {
  const name = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'sandbox';
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// Tiny flag parser: known flags per spec, `--` starts passthrough args,
// unknown tokens land in positionals (or passthrough for agent launchers).
function parseArgs(argv, spec, { unknownToRest = false } = {}) {
  const flags = {};
  const positionals = [];
  const rest = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    // --key=value form (required for 'optional'-type flags like --own-modules=2)
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    const bare = eq === -1 ? tok : tok.slice(0, eq);
    const known = bare.startsWith('--') && spec[bare.slice(2)];
    if (known) {
      const key = bare.slice(2);
      if (eq !== -1) {
        flags[key] = tok.slice(eq + 1);
        i += 1;
      } else if (spec[key] === 'boolean' || spec[key] === 'optional') {
        flags[key] = true;
        i += 1;
      } else {
        if (argv[i + 1] === undefined) die(`missing value for --${key}`);
        flags[key] = argv[i + 1];
        i += 2;
      }
    } else if (tok.startsWith('-') && unknownToRest) {
      rest.push(...argv.slice(i));
      break;
    } else if (tok.startsWith('-')) {
      die(`unknown option: ${tok} (see 'vivary help')`);
    } else {
      positionals.push(tok);
      i += 1;
    }
  }
  return { flags, positionals, rest };
}

// ---------------------------------------------------------- sandbox config --

function sandboxDir(name) {
  return path.join(SANDBOXES_DIR, name);
}

// Load sandbox config; migrates legacy sandbox.env (bash era) to sandbox.json.
function loadSandbox(name) {
  const dir = sandboxDir(name);
  const jsonFile = path.join(dir, 'sandbox.json');
  const json = readJson(jsonFile);
  if (json) return json;
  const envFile = path.join(dir, 'sandbox.env');
  if (fs.existsSync(envFile)) {
    const env = Object.fromEntries(
      fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
    const migrated = {
      name,
      workspace: env.WORKSPACE,
      runtime: detectRuntime(),
      agent: 'claude',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(jsonFile, JSON.stringify(migrated, null, 2));
    return migrated;
  }
  return null;
}

function saveSandbox(cfg) {
  fs.writeFileSync(path.join(sandboxDir(cfg.name), 'sandbox.json'), JSON.stringify(cfg, null, 2));
}

function listSandboxNames() {
  if (!fs.existsSync(SANDBOXES_DIR)) return [];
  return fs.readdirSync(SANDBOXES_DIR).filter((n) => {
    const dir = path.join(SANDBOXES_DIR, n);
    return fs.statSync(dir).isDirectory()
      && (fs.existsSync(path.join(dir, 'sandbox.json')) || fs.existsSync(path.join(dir, 'sandbox.env')));
  });
}

// Resolve sandbox name: explicit arg, or derived from cwd basename. When the
// name maps to an existing sandbox with a different workspace, fail loudly.
function resolveName(explicit, workspace) {
  const name = explicit || sanitizeName(path.basename(workspace));
  const existing = loadSandbox(name);
  if (existing && path.resolve(existing.workspace) !== path.resolve(workspace) && !explicit) {
    die(`sandbox '${name}' already exists for workspace ${existing.workspace}.\n` +
        `Run from that directory, or pick a name: vivary start --name <other-name>`);
  }
  return name;
}

// ------------------------------------------------------------------ create --

async function selectItems(kind, items) {
  if (!items.length) return [];
  console.log(`\nAvailable ${kind}:`);
  items.forEach((item, i) => console.log(`  [${i + 1}] ${item}`));
  const answer = (await ask(`Select ${kind} to import (numbers, 'all' or 'none') [none]: `)).trim();
  if (answer === 'all') return [...items];
  if (!answer || answer === 'none') return [];
  const picked = [];
  for (const tok of answer.split(/\s+/)) {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) picked.push(items[n - 1]);
    else console.log(`  (ignoring invalid selection: ${tok})`);
  }
  return picked;
}

function importSettings(dir) {
  const hostSettings = path.join(HOST_CLAUDE_DIR, 'settings.json');
  if (!fs.existsSync(hostSettings)) return;
  const settings = readJson(hostSettings, {});
  delete settings.hooks; // hooks reference host paths — never import them
  fs.writeFileSync(path.join(dir, 'dot-claude/settings.json'), JSON.stringify(settings, null, 2));
  console.log('  imported settings.json (without hooks)');
  // Status line: the command (e.g. ccstatusline) is baked into the image;
  // carry over its visual config from ~/.config.
  const slCmd = (settings.statusLine?.command || '').split(/\s+/)[0];
  if (slCmd) {
    const slConfig = path.join(HOME, '.config', slCmd);
    if (fs.existsSync(slConfig)) {
      fs.cpSync(slConfig, path.join(dir, 'dot-config', slCmd), { recursive: true });
      console.log(`  imported ~/.config/${slCmd} (status line config)`);
    }
  }
}

async function createSandbox(name, workspace, opts) {
  const dir = sandboxDir(name);
  if (loadSandbox(name)) die(`sandbox '${name}' already exists at ${dir}`);

  for (const sub of ['dot-claude', 'dot-config', 'dot-codex', 'ssh']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  console.log(`==> Created sandbox state dir: ${dir}`);

  const interactive = opts.interactive && IS_TTY;

  // MCP servers (from host ~/.claude.json)
  let mcpServers = {};
  const hostMcp = readJson(HOST_CLAUDE_JSON, {})?.mcpServers || {};
  if (interactive) {
    const picked = await selectItems('MCP servers', Object.keys(hostMcp));
    for (const key of picked) mcpServers[key] = hostMcp[key];
    if (picked.length) {
      console.log(`  imported MCP servers: ${picked.join(' ')}`);
      console.log('  NOTE: servers referencing host-only binaries/paths will not work inside the container.');
    }
  }
  fs.writeFileSync(
    path.join(dir, 'dot-claude/.claude.json'),
    JSON.stringify({ mcpServers, hasCompletedOnboarding: true }, null, 2)
  );

  // Skills (from host ~/.claude/skills)
  if (interactive) {
    const skillsDir = path.join(HOST_CLAUDE_DIR, 'skills');
    const skills = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir).filter((s) => fs.statSync(path.join(skillsDir, s)).isDirectory()).sort()
      : [];
    const picked = await selectItems('skills', skills);
    if (picked.length) {
      fs.mkdirSync(path.join(dir, 'dot-claude/skills'), { recursive: true });
      for (const s of picked) {
        fs.cpSync(path.join(skillsDir, s), path.join(dir, 'dot-claude/skills', s), { recursive: true });
      }
      console.log(`  imported skills: ${picked.join(' ')}`);
    }
  }

  // settings.json (+ status line config). Auto-create imports it by default —
  // it carries theme/statusline and never hooks.
  if (interactive) {
    const a = (await ask('Import host settings.json (hooks are stripped)? [Y/n]: ')).trim();
    if (!/^n/i.test(a)) importSettings(dir);
  } else if (opts.importSettings !== false) {
    importSettings(dir);
  }

  const cfg = {
    name,
    workspace,
    runtime: opts.runtime || detectRuntime(),
    agent: opts.agent || 'claude',
    docker: !!opts.docker,
    hostOpen: !!opts['host-open'],
    clipboard: !!opts.clipboard,
    ownModules: opts['own-modules'] === undefined ? false
      : opts['own-modules'] === true ? 4
      : Number(opts['own-modules']) || false,
    createdAt: new Date().toISOString(),
  };
  saveSandbox(cfg);
  console.log(`==> Sandbox '${name}' created (runtime: ${cfg.runtime}, workspace: ${workspace})`);
  return cfg;
}

// Load or auto-create (with defaults) the sandbox for start/up.
async function ensureSandbox(explicitName, opts) {
  const workspace = path.resolve(opts.workspace || process.cwd());
  const name = resolveName(explicitName, workspace);
  let cfg = loadSandbox(name);
  if (!cfg) {
    cfg = await createSandbox(name, workspace, { ...opts, interactive: false });
  }
  if (!fs.existsSync(cfg.workspace)) die(`workspace ${cfg.workspace} no longer exists`);
  fs.mkdirSync(path.join(sandboxDir(name), 'dot-config'), { recursive: true });
  fs.mkdirSync(path.join(sandboxDir(name), 'dot-codex'), { recursive: true });
  return cfg;
}

// -------------------------------------------------------------- run/mounts --

// Claude Code stores history under ~/.claude/projects/<slug>, slug = cwd
// with every non-alphanumeric character replaced by '-'.
function projectSlug(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// Share only the workspace's own history (and its subdirectories') with the
// container — NOT the host's entire ~/.claude/projects, which holds chats of
// unrelated projects. Each matching slug dir is mounted individually under
// /home/agent/host-projects (a plain dir, so no nested-mount issues); the
// entrypoint symlinks ~/.claude/projects there.
function projectHistoryMounts(cfg) {
  const projectsRoot = path.join(HOST_CLAUDE_DIR, 'projects');
  const slug = projectSlug(cfg.workspace);
  fs.mkdirSync(path.join(projectsRoot, slug), { recursive: true });
  const args = [];
  for (const d of fs.readdirSync(projectsRoot)) {
    if (d === slug || d.startsWith(`${slug}-`)) {
      args.push('-v', `${path.join(projectsRoot, d)}:/home/agent/host-projects/${d}`);
    }
  }
  return args;
}

// Find workspace dirs containing package.json — candidates for a
// node_modules overlay. No symlink following (a workspace symlink must not
// lead us to create dirs outside the workspace); depth = directory levels
// below the workspace root; hard cap keeps monster repos bounded.
function discoverPackageDirs(root, maxDepth, cap = 500) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && found.length < cap) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      found.push(path.relative(root, dir) || '.');
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue; // isDirectory() is false for symlinks
      if (['node_modules', '.git', '.hg'].includes(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

const moduleSlug = (rel) => (rel === '.' ? 'root' : rel.replace(/[^a-zA-Z0-9._-]/g, '-'));

// node_modules overlays: linux modules live per sandbox, the host's macOS
// modules stay untouched underneath. Docker gets one bind mount per package
// dir (no mount limit); Apple `container` tops out at ~120 virtiofs shares,
// so it gets a single share plus in-VM bind mounts done by the bind-modules
// helper (driven by a manifest; modules-watch extends it live).
function ownModulesArgs(cfg) {
  const depth = Number(cfg.ownModules);
  if (!depth) return [];
  const modulesRoot = path.join(sandboxDir(cfg.name), 'modules');
  fs.mkdirSync(modulesRoot, { recursive: true });
  const pkgs = discoverPackageDirs(cfg.workspace, depth);
  const args = [];
  const manifest = [];
  for (const rel of pkgs) {
    const target = path.join(cfg.workspace, rel, 'node_modules');
    const state = path.join(modulesRoot, moduleSlug(rel));
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    if (cfg.runtime === 'docker') args.push('-v', `${state}:${target}`);
    else manifest.push(`${moduleSlug(rel)}\t${target}`);
  }
  if (cfg.runtime !== 'docker') {
    fs.writeFileSync(path.join(modulesRoot, '.manifest'), manifest.join('\n') + '\n');
    args.push(
      '-v', `${modulesRoot}:/vivary-modules`,
      '-e', 'SANDBOX_MODULES=1',
      '-e', `SANDBOX_MODULES_DEPTH=${depth}`,
      '-e', `SANDBOX_WORKSPACE=${cfg.workspace}`,
    );
  }
  console.log(`==> node_modules overlays: ${pkgs.length} package dir(s), depth ${depth}`);
  return args;
}

function commonRunArgs(cfg, { memory, cpus }) {
  const dir = sandboxDir(cfg.name);
  const args = [
    '--name', containerName(cfg.name),
    '--memory', memory || process.env.SANDBOX_MEMORY || '4g',
    '--cpus', cpus || process.env.SANDBOX_CPUS || '4',
    '-v', `${path.join(dir, 'dot-claude')}:/home/agent/.claude`,
    '-v', `${path.join(dir, 'dot-config')}:/home/agent/.config`,
    '-v', `${path.join(dir, 'dot-codex')}:/home/agent/.codex`,
    ...projectHistoryMounts(cfg),
    '-v', `${cfg.workspace}:${cfg.workspace}`,
    '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    '-e', `SBX_SANDBOX_NAME=${cfg.name}`,
    '-w', cfg.workspace,
  ];
  if (cfg.runtime === 'docker') args.push('--init');
  if (cfg.clipboard) args.push('-e', 'SANDBOX_CLIPBOARD=1');
  args.push(...ownModulesArgs(cfg));
  if (cfg.docker) {
    args.push('-e', 'SANDBOX_DOCKER=1');
    if (cfg.runtime === 'docker') {
      // dockerd needs privileges, and overlay2 can't sit on overlayfs — give
      // /var/lib/docker a named volume.
      args.push('--privileged', '-v', `${containerName(cfg.name)}-docker:/var/lib/docker`);
    }
  }
  if (cfg.runtime !== 'docker' && (cfg.docker || cfg.ownModules)) {
    // Apple `container` strips capabilities by default; dockerd needs
    // NET_ADMIN & co. and bind-modules needs SYS_ADMIN. The sandbox is its
    // own VM, so this stays contained.
    args.push('--cap-add', 'ALL');
  }
  return args;
}

// Sticky --own-modules[=depth]: bare flag -> depth 4, =N -> N, =0 -> off.
function applyOwnModulesFlag(cfg, flags) {
  const v = flags['own-modules'];
  if (v === undefined) return;
  const depth = v === true ? 4 : Number(v);
  if (!Number.isInteger(depth) || depth < 0) die('--own-modules expects a level, e.g. --own-modules=2');
  const next = depth === 0 ? false : depth;
  if (cfg.ownModules !== next) {
    cfg.ownModules = next;
    saveSandbox(cfg);
  }
}

// Enable a persisted per-sandbox option (e.g. --docker) on an existing sandbox.
function enableOption(cfg, flags, key) {
  if (flags[key] && !cfg[key]) {
    cfg[key] = true;
    saveSandbox(cfg);
  }
}

function termEnvArgs() {
  return [
    '-e', `TERM=${process.env.TERM || 'xterm-256color'}`,
    '-e', `COLORTERM=${process.env.COLORTERM || 'truecolor'}`,
  ];
}

function headedInfo(cfg) {
  const cname = containerName(cfg.name);
  const domain = cfg.runtime === 'container' ? containerDnsDomain() : '';
  if (domain) {
    return { publish: [], url: `http://${cname}.${domain}:6080/vnc.html` };
  }
  const port = process.env.NOVNC_PORT || '6080';
  return { publish: ['-p', `${port}:6080`], url: `http://localhost:${port}/vnc.html` };
}

// ------------------------------------------------------------------- start --

async function cmdStart(argv, forcedAgent) {
  const { flags, positionals, rest } = parseArgs(argv, {
    name: 'string', workspace: 'string', agent: 'string', runtime: 'string',
    headed: 'boolean', docker: 'boolean', 'host-open': 'boolean',
    clipboard: 'boolean', 'own-modules': 'optional', memory: 'string', cpus: 'string',
  }, { unknownToRest: true });

  const cfg = await ensureSandbox(flags.name || positionals[0], {
    ...flags, agent: forcedAgent || flags.agent,
  });
  enableOption(cfg, flags, 'docker');
  enableOption(cfg, flags, 'clipboard');
  applyOwnModulesFlag(cfg, flags);
  if (flags['host-open'] && !cfg.hostOpen) { cfg.hostOpen = true; saveSandbox(cfg); }
  const agentName = forcedAgent || flags.agent || cfg.agent || 'claude';
  const agent = AGENTS[agentName] || die(`unknown agent '${agentName}' (available: ${Object.keys(AGENTS).join(', ')})`);
  const runtime = cfg.runtime;
  const cname = containerName(cfg.name);
  const hostOpenEnv = (cfg.hostOpen || cfg.clipboard) ? await hostOpenEnvArgs() : [];

  if (isRunning(runtime, cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    const status = runInherit(runtime, [
      'exec', ...(IS_TTY ? ['-it'] : []), ...termEnvArgs(), ...hostOpenEnv,
      cname, agent.cmd, ...rest,
    ]);
    process.exit(status);
  }

  const args = ['run', '--rm', ...(IS_TTY ? ['-it'] : []),
    ...commonRunArgs(cfg, flags), ...termEnvArgs(), ...hostOpenEnv];
  console.log(`==> Runtime: ${runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);

  if (flags.headed) {
    const { publish, url } = headedInfo(cfg);
    args.push('-e', 'HEADED=1', ...publish);
    console.log(`==> Headed mode: browser will be visible at ${url}`);
  }

  args.push(IMAGE, agent.cmd, ...rest);
  process.exit(runInherit(runtime, args));
}

// ---------------------------------------------------------------- up/down --

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
      .filter((l) => !(l.split(/\s+/)[0] || '').split(',').some((h) => h.replace(/^\[|\]:\d+$/g, '').startsWith(`${cname}.`) || h === cname));
    fs.writeFileSync(kh, kept.join('\n'));
  }
}

async function cmdUp(argv) {
  const { flags, positionals } = parseArgs(argv, {
    name: 'string', workspace: 'string', runtime: 'string', agent: 'string',
    headed: 'boolean', docker: 'boolean', 'host-open': 'boolean',
    clipboard: 'boolean', 'own-modules': 'optional', memory: 'string', cpus: 'string',
  });

  const cfg = await ensureSandbox(flags.name || positionals[0], flags);
  enableOption(cfg, flags, 'docker');
  enableOption(cfg, flags, 'clipboard');
  applyOwnModulesFlag(cfg, flags);
  if (flags['host-open'] && !cfg.hostOpen) { cfg.hostOpen = true; saveSandbox(cfg); }
  const runtime = cfg.runtime;
  const dir = sandboxDir(cfg.name);
  const cname = containerName(cfg.name);

  if (isRunning(runtime, cfg.name)) {
    die(`'${cname}' is already running (stop it with: vivary down ${cfg.name})`);
  }

  // Per-sandbox SSH keypair; the public key becomes authorized_keys inside.
  const keyFile = path.join(dir, 'ssh/id_ed25519');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
    const r = capture('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', cname, '-f', keyFile]);
    if (r.status !== 0) die(`ssh-keygen failed: ${r.stderr}`);
    fs.copyFileSync(`${keyFile}.pub`, path.join(dir, 'ssh/authorized_keys'));
    console.log(`==> Generated SSH keypair in ${path.join(dir, 'ssh')}`);
  }

  const args = [
    'run', '-d', '--rm', ...commonRunArgs(cfg, flags),
    '-v', `${path.join(dir, 'ssh')}:/home/agent/host-ssh`,
    '-e', 'SANDBOX_SSH=1',
    ...((cfg.hostOpen || cfg.clipboard) ? await hostOpenEnvArgs() : []),
  ];
  if (flags.headed) args.push('-e', 'HEADED=1');

  let sshHost = 'localhost';
  let sshPort = process.env.SSH_PORT || '2222';
  let novncUrl = '';
  const domain = runtime === 'container' ? containerDnsDomain() : '';
  if (domain) {
    sshHost = `${cname}.${domain}`;
    sshPort = '22';
    novncUrl = `http://${sshHost}:6080/vnc.html`;
  } else {
    args.push('-p', `${sshPort}:22`);
    if (flags.headed) {
      const port = process.env.NOVNC_PORT || '6080';
      args.push('-p', `${port}:6080`);
      novncUrl = `http://localhost:${port}/vnc.html`;
    }
  }

  args.push(IMAGE, 'sleep', 'infinity');
  const r = capture(runtime, args);
  if (r.status !== 0) die(`${runtime} run failed: ${r.stderr || r.stdout}`);

  // Host keys are generated inside the container on first boot — wait for
  // them, then pre-trust them so Claude Desktop's verification passes.
  const hostkeysDir = path.join(dir, 'ssh/hostkeys');
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(hostkeysDir) && fs.readdirSync(hostkeysDir).some((f) => f.endsWith('.pub'))) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (fs.existsSync(hostkeysDir) && fs.readdirSync(hostkeysDir).some((f) => f.endsWith('.pub'))) {
    registerKnownHosts(dir, sshHost, sshPort);
  } else {
    console.error('WARNING: host keys not available yet; first SSH connect may fail verification');
  }
  ensureSshConfigEntry(cfg.name, sshHost, sshPort, dir);

  console.log(`==> Sandbox '${cfg.name}' is up (runtime: ${runtime})`);
  if (novncUrl) console.log(`    noVNC:     ${novncUrl}`);
  console.log(`    SSH config entry added/updated in ~/.ssh/config.

    Connect:        ssh claude-sandbox-${cfg.name}
    Claude Desktop: Code tab -> environment dropdown -> "+ Add SSH connection"
                    -> Host: claude-sandbox-${cfg.name}
                    (user, port and key come from ~/.ssh/config)

    Stop with: vivary down ${cfg.name}`);
}

function cmdDown(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  if (!isRunning(cfg.runtime, name)) {
    console.log(`Sandbox '${name}' is not running.`);
    return;
  }
  capture(cfg.runtime, ['stop', containerName(name)]);
  console.log(`==> Sandbox '${name}' stopped (state and chats are preserved).`);
}

// ------------------------------------------------------------------- other --

async function cmdShell(argv) {
  const { flags, positionals } = parseArgs(argv, {
    name: 'string', workspace: 'string', runtime: 'string', agent: 'string',
    headed: 'boolean', docker: 'boolean', 'host-open': 'boolean',
    clipboard: 'boolean', 'own-modules': 'optional', memory: 'string', cpus: 'string',
  });
  const cfg = await ensureSandbox(flags.name || positionals[0], flags);
  enableOption(cfg, flags, 'docker');
  enableOption(cfg, flags, 'clipboard');
  applyOwnModulesFlag(cfg, flags);
  if (flags['host-open'] && !cfg.hostOpen) { cfg.hostOpen = true; saveSandbox(cfg); }
  const hostOpenEnv = (cfg.hostOpen || cfg.clipboard) ? await hostOpenEnvArgs() : [];

  if (isRunning(cfg.runtime, cfg.name)) {
    process.exit(runInherit(cfg.runtime, [
      'exec', ...(IS_TTY ? ['-it'] : []), ...termEnvArgs(), ...hostOpenEnv,
      containerName(cfg.name), 'bash',
    ]));
  }

  // Not running — launch a container with bash instead of the agent.
  console.log(`==> Runtime: ${cfg.runtime} | shell | workspace: ${cfg.workspace}`);
  const args = ['run', '--rm', ...(IS_TTY ? ['-it'] : []),
    ...commonRunArgs(cfg, flags), ...termEnvArgs(), ...hostOpenEnv];
  if (flags.headed) {
    const { publish, url } = headedInfo(cfg);
    args.push('-e', 'HEADED=1', ...publish);
    console.log(`==> Headed mode: browser will be visible at ${url}`);
  }
  process.exit(runInherit(cfg.runtime, [...args, IMAGE, 'bash']));
}

function cmdList() {
  const names = listSandboxNames();
  if (!names.length) {
    console.log(`No sandboxes in ${SANDBOXES_DIR}`);
    return;
  }
  const running = {
    docker: runningSet('docker'),
    container: runningSet('container'),
  };
  const rows = [['NAME', 'AGENT', 'RUNTIME', 'STATUS', 'WORKSPACE']];
  for (const name of names.sort()) {
    const cfg = loadSandbox(name);
    if (!cfg) continue;
    const status = running[cfg.runtime]?.has(containerName(name)) ? 'running' : 'stopped';
    rows.push([name, cfg.agent || 'claude', cfg.runtime || '?', status, cfg.workspace || '?']);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const row of rows) {
    console.log(row.map((cell, c) => String(cell).padEnd(widths[c] + 2)).join('').trimEnd());
  }
}

async function cmdRm(argv) {
  const { flags, positionals } = parseArgs(argv, { name: 'string', purge: 'boolean' });
  const name = flags.name || positionals[0] || sanitizeName(path.basename(process.cwd()));
  const cfg = loadSandbox(name) || die(`sandbox '${name}' does not exist`);
  const cname = containerName(name);
  if (isRunning(cfg.runtime, name)) {
    capture(cfg.runtime, ['stop', cname]);
  }
  capture(cfg.runtime, ['rm', cname]);
  console.log(`==> Container removed. Chat history remains in ${path.join(HOST_CLAUDE_DIR, 'projects')}.`);
  if (flags.purge) {
    // Explicit --purge in a non-interactive context counts as confirmation.
    const answer = IS_TTY
      ? (await ask(`Really delete sandbox state ${sandboxDir(name)} (credentials, settings, skills)? [y/N]: `)).trim()
      : 'y';
    if (/^y/i.test(answer)) {
      fs.rmSync(sandboxDir(name), { recursive: true, force: true });
      removeSshArtifacts(name);
      console.log('==> Sandbox state purged (including ssh config entry).');
    }
  } else {
    console.log(`    Sandbox state kept in ${sandboxDir(name)} (use 'vivary rm ${name} --purge' to delete).`);
  }
}

async function cmdCreate(argv) {
  const { flags, positionals } = parseArgs(argv, {
    name: 'string', workspace: 'string', runtime: 'string', agent: 'string',
    docker: 'boolean', 'host-open': 'boolean', 'own-modules': 'optional',
  });
  const workspace = path.resolve(flags.workspace || positionals[1] || process.cwd());
  const name = flags.name || positionals[0] || sanitizeName(path.basename(workspace));
  await createSandbox(name, workspace, { ...flags, interactive: true });
  console.log(`    Start it:  vivary start ${name}`);
}

// ------------------------------------------------------------------ broker --
// Host-side "open" broker: containers POST url/path targets here (via
// host.docker.internal) and they open natively on the host — browser for
// URLs, editor for workspace files. Opt-in per sandbox with --host-open.

const BROKER_DIR = path.join(SANDBOXES_DIR, '.broker');
const BROKER_PORT = Number(process.env.SBX_BROKER_PORT || 7377);

function brokerToken() {
  const file = path.join(BROKER_DIR, 'token');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(BROKER_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function brokerLog(line) {
  fs.mkdirSync(BROKER_DIR, { recursive: true });
  fs.appendFileSync(path.join(BROKER_DIR, 'broker.log'),
    `${new Date().toISOString()} ${line}\n`);
}

async function brokerHealthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${BROKER_PORT}/health`,
      { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Spawn the broker detached if it isn't already running.
async function ensureBroker() {
  if (!(await brokerHealthy())) {
    fs.mkdirSync(BROKER_DIR, { recursive: true });
    const log = fs.openSync(path.join(BROKER_DIR, 'broker.log'), 'a');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'broker'],
      { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 20 && !(await brokerHealthy()); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!(await brokerHealthy())) die(`broker failed to start (see ${BROKER_DIR}/broker.log)`);
    console.log(`==> host-open broker started on port ${BROKER_PORT}`);
  }
  return { url: `http://host.docker.internal:${BROKER_PORT}/`, token: brokerToken() };
}

async function hostOpenEnvArgs() {
  const { url, token } = await ensureBroker();
  return ['-e', `SBX_OPEN_URL=${url}`, '-e', `SBX_OPEN_TOKEN=${token}`];
}

function allowedWorkspaces() {
  return listSandboxNames().map((n) => loadSandbox(n)?.workspace).filter(Boolean)
    .map((w) => path.resolve(w));
}

// OAuth flows (claude /login, codex login) run a callback server on the
// CONTAINER's localhost, but with --host-open the browser runs on the HOST —
// its redirect to http://localhost:PORT would go nowhere. When an opened URL
// carries such a redirect_uri, listen on the host's 127.0.0.1:PORT for a few
// minutes and replay requests into the sandbox via `<runtime> exec curl`
// (which runs inside the container's network namespace).
const activeRelays = new Set();

function startCallbackRelay(cfg, port) {
  if (activeRelays.has(port)) return;
  const cname = containerName(cfg.name);
  const relay = http.createServer((req, res) => {
    const r = spawnSync(cfg.runtime, [
      'exec', cname, 'curl', '-sS', '-D', '-', '--max-time', '10',
      `http://127.0.0.1:${port}${req.url}`,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const out = r.stdout || '';
    const sep = out.indexOf('\r\n\r\n');
    if (r.status !== 0 || sep === -1) {
      brokerLog(`RELAY ${cfg.name} :${port} -> sandbox callback unreachable`);
      res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end('vivary relay: callback server in the sandbox is not reachable');
    }
    const head = out.slice(0, sep).split('\r\n');
    const body = out.slice(sep + 4);
    const status = Number((head[0].match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 200);
    const headers = {};
    for (const h of head.slice(1)) {
      const i = h.indexOf(':');
      const key = i > 0 ? h.slice(0, i).trim().toLowerCase() : '';
      if (['location', 'content-type'].includes(key)) headers[key] = h.slice(i + 1).trim();
    }
    res.writeHead(status, headers);
    res.end(body);
    brokerLog(`RELAY ${cfg.name} :${port}${req.url.split('?')[0]} -> ${status}`);
  });
  relay.on('error', (e) => {
    activeRelays.delete(port);
    brokerLog(`RELAY :${port} listen failed: ${e.code}`);
  });
  relay.listen(port, '127.0.0.1', () => {
    activeRelays.add(port);
    brokerLog(`RELAY ${cfg.name} listening on 127.0.0.1:${port} (5 min)`);
    setTimeout(() => { relay.close(); activeRelays.delete(port); }, 300000);
  });
}

// If the URL being opened contains redirect_uri=http://localhost:PORT (an
// OAuth authorize link), set up the callback relay for the calling sandbox.
function maybeRelayOauthCallback(target, sandboxName) {
  try {
    const redirect = new URL(target).searchParams.get('redirect_uri');
    if (!redirect) return;
    const r = new URL(redirect);
    if (r.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(r.hostname)) return;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port <= 1024 || port > 65535) return;
    const cfg = sandboxName && /^[a-z0-9-]+$/.test(sandboxName) ? loadSandbox(sandboxName) : null;
    if (!cfg) return;
    startCallbackRelay(cfg, port);
  } catch {
    /* not an OAuth-style URL — nothing to do */
  }
}

function openOnHost(action, target, sandboxName, via) {
  if (!sandboxForRequest(sandboxName)?.hostOpen) {
    return 'host-open not enabled for this sandbox (--host-open)';
  }
  if (action === 'url') {
    let u;
    try {
      u = new URL(target);
    } catch {
      return 'invalid url';
    }
    if (!['http:', 'https:'].includes(u.protocol)) return `scheme not allowed: ${u.protocol}`;
    maybeRelayOauthCallback(target, sandboxName);
    const cmd = process.platform === 'darwin' ? ['open', target]
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '', target]
      : ['xdg-open', target];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    return null;
  }
  if (action === 'path') {
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      return 'path not found on host';
    }
    const ok = allowedWorkspaces().some((w) => real === w || real.startsWith(w + path.sep));
    if (!ok) return 'path outside sandbox workspaces';
    // via=editor (`code file`) opens in the editor; via=default (`open`,
    // `xdg-open`) uses the host's default application for the file type.
    if (via === 'editor' && hasCmd('code')) {
      spawnSync('code', [real], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [real], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', real], { stdio: 'ignore' });
    } else if (hasCmd('xdg-open')) {
      spawnSync('xdg-open', [real], { stdio: 'ignore' });
    } else {
      return 'no opener found on host';
    }
    return null;
  }
  return 'unknown action';
}

// --- host clipboard (macOS; win32/linux TODO) --------------------------------

function dumpClipboardClass(cls, tmp) {
  const script = [
    'try',
    `set d to the clipboard as ${cls}`,
    `set f to open for access POSIX file "${tmp}" with write permission`,
    'set eof of f to 0',
    'write d to f',
    'close access f',
    'return "ok"',
    'on error',
    'return "none"',
    'end try',
  ].flatMap((l) => ['-e', l]);
  return spawnSync('osascript', script, { encoding: 'utf8' }).stdout?.includes('ok');
}

function readHostClipboardPng() {
  const tmp = path.join(os.tmpdir(), `vivary-clip-${process.pid}.png`);
  try {
    if (!dumpClipboardClass('«class PNGf»', tmp)) {
      // some apps put only TIFF on the clipboard — convert via sips
      const tiff = path.join(os.tmpdir(), `vivary-clip-${process.pid}.tiff`);
      if (!dumpClipboardClass('«class TIFF»', tiff)) return null;
      const r = spawnSync('sips', ['-s', 'format', 'png', tiff, '--out', tmp], { stdio: 'ignore' });
      fs.rmSync(tiff, { force: true });
      if (r.status !== 0) return null;
    }
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    return buf;
  } catch {
    return null;
  }
}

// What the host clipboard currently offers, in X11 TARGETS vocabulary —
// Claude Code queries this before deciding whether an image paste exists.
function hostClipboardTargets() {
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout || '';
  const targets = ['TARGETS'];
  if (/PNGf|TIFF/.test(info)) targets.push('image/png');
  if (/string|utf8/i.test(info)) targets.push('text/plain', 'UTF8_STRING', 'STRING');
  return targets.join('\n') + '\n';
}

// Cheap change detector for the clipboard-sync daemon (classes+sizes from
// `clipboard info`, plus the text content for same-size text edits).
function hostClipboardFingerprint() {
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout || '';
  const text = /string|utf8/i.test(info) ? readHostClipboardText() : Buffer.alloc(0);
  return crypto.createHash('md5').update(info).update(text).digest('hex');
}

function readHostClipboardText() {
  const r = spawnSync('pbpaste', [], { encoding: 'buffer' });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}

function writeHostClipboardText(text) {
  return spawnSync('pbcopy', [], { input: text }).status === 0;
}

// The sandbox name is client-supplied; it gates which broker features the
// caller may use (single-user trust model — token is the real auth).
function sandboxForRequest(name) {
  return name && /^[a-z0-9-]+$/.test(name) ? loadSandbox(name) : null;
}

function cmdBroker(argv) {
  const pidFile = path.join(BROKER_DIR, 'broker.pid');
  if (argv[0] === 'stop') {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
      console.log('==> broker stopped');
    } catch {
      console.log('broker is not running');
    }
    return;
  }
  const token = brokerToken();
  fs.writeFileSync(pidFile, String(process.pid));
  const server = http.createServer((req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true });

    // GET /clipboard?format=text|png — host clipboard -> sandbox
    if (req.method === 'GET' && req.url.startsWith('/clipboard')) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      if (q.get('token') !== token) return respond(403, { ok: false, error: 'bad token' });
      const cfg = sandboxForRequest(q.get('name'));
      if (!cfg?.clipboard) {
        brokerLog(`REJECTED clipboard read (not enabled) from ${q.get('name') || '?'}`);
        return respond(403, { ok: false, error: 'clipboard not enabled for this sandbox (--clipboard)' });
      }
      const format = q.get('format') || 'text';
      if (format === 'fingerprint') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(hostClipboardFingerprint());
      }
      const data = format === 'png' ? readHostClipboardPng()
        : format === 'targets' ? Buffer.from(hostClipboardTargets())
        : readHostClipboardText();
      if (!data || !data.length) return respond(404, { ok: false, error: `no ${format === 'png' ? 'image' : 'text'} in host clipboard` });
      brokerLog(`OK clipboard read (${format}, ${data.length}B) by ${cfg.name}`);
      res.writeHead(200, { 'content-type': format === 'png' ? 'image/png' : 'text/plain; charset=utf-8' });
      return res.end(data);
    }

    if (req.method !== 'POST') return respond(405, { ok: false, error: 'POST only' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      if (p.get('token') !== token) {
        brokerLog(`DENIED bad token from ${req.socket.remoteAddress}`);
        return respond(403, { ok: false, error: 'bad token' });
      }

      // POST /clipboard — sandbox -> host clipboard (text)
      if (req.url.startsWith('/clipboard')) {
        const cfg = sandboxForRequest(p.get('name'));
        if (!cfg?.clipboard) {
          brokerLog(`REJECTED clipboard write (not enabled) from ${p.get('name') || '?'}`);
          return respond(403, { ok: false, error: 'clipboard not enabled for this sandbox (--clipboard)' });
        }
        const text = p.get('text') || '';
        if (!writeHostClipboardText(text)) return respond(500, { ok: false, error: 'pbcopy failed' });
        brokerLog(`OK clipboard write (${text.length} chars) by ${cfg.name}`);
        return respond(200, { ok: true });
      }

      const action = p.get('action');
      const target = p.get('target') || '';
      const via = p.get('via') === 'editor' ? 'editor' : 'default';
      const err = openOnHost(action, target, p.get('name') || '', via);
      brokerLog(`${err ? `REJECTED (${err})` : 'OK'} ${action} (${via}) ${target} from ${req.socket.remoteAddress}`);
      if (err) return respond(400, { ok: false, error: err });
      respond(200, { ok: true });
    });
  });
  server.listen(BROKER_PORT, '0.0.0.0', () => {
    console.log(`vivary broker listening on :${BROKER_PORT} (log: ${BROKER_DIR}/broker.log)`);
  });
}

// ------------------------------------------------------------------- build --

function cmdBuild(argv) {
  const { positionals } = parseArgs(argv, {});
  const target = positionals[0] || 'all';
  const runtime = detectRuntime();
  console.log(`==> Using runtime: ${runtime}`);

  const buildOne = (imageName, dir) => {
    // Apple `container`'s builder VM has broken Node.js DNS (EAI_AGAIN), so
    // `npm install` steps never succeed there. When Docker is available,
    // build with Docker and load the result into the container store.
    // Force a native `container build` with SANDBOX_NATIVE_BUILD=1.
    if (runtime === 'container' && process.env.SANDBOX_NATIVE_BUILD !== '1' && hasCmd('docker')) {
      console.log(`==> Building ${imageName} with Docker, then loading into the container store`);
      if (runInherit('docker', ['build', '-t', imageName, dir]) !== 0) die('docker build failed');
      const tar = path.join(os.tmpdir(), `${imageName}-${Date.now()}.tar`);
      try {
        if (runInherit('docker', ['save', `${imageName}:latest`, '-o', tar]) !== 0) die('docker save failed');
        if (runInherit('container', ['image', 'load', '-i', tar]) !== 0) die('container image load failed');
      } finally {
        fs.rmSync(tar, { force: true });
      }
    } else {
      console.log(`==> Building ${imageName} from ${dir}`);
      if (runInherit(runtime, ['build', '-t', imageName, dir]) !== 0) die(`${runtime} build failed`);
    }
  };

  if (target === 'base' || target === 'all') buildOne('agent-sandbox-base', path.join(REPO_DIR, 'base'));
  if (target === 'agents' || target === 'claude' || target === 'all') {
    buildOne('agent-sandbox-agents', path.join(REPO_DIR, 'agents'));
  }
  if (!['base', 'agents', 'claude', 'all'].includes(target)) die('usage: vivary build [base|agents|all]');
  console.log('==> Done');
}

// -------------------------------------------------------------------- help --

const HELP = `vivary ${pkg.version} — sandboxed AI agents in Docker / Apple container

Usage:
  vivary <command> [options]
  slaude [agent args...]      start a sandboxed Claude Code here (= vivary start)
  sodex [agent args...]       start a sandboxed Codex here

Commands:
  start | run [name]   Start an interactive agent session (auto-creates the
                       sandbox on first use — name and workspace default to
                       the current directory). Extra args go to the agent.
  create [name]        Create a sandbox explicitly, with an interactive
                       import wizard (MCP servers, skills, settings).
  up [name]            Long-running container with sshd — for Claude Desktop
                       (Code tab -> "+ Add SSH connection"), IDEs, ssh.
  down [name]          Stop the long-running container.
  ls | list            List sandboxes across runtimes.
  shell [name]         Bash in the sandbox (attaches if running, otherwise
                       starts a container; auto-creates like start).
  rm [name] [--purge]  Remove the container (--purge also deletes state).
  build [base|claude]  Build the container images (default: all).
  help, --help         Show this help.
  --version            Show version.

Options (start/create/up):
  --name <name>        Sandbox name (default: derived from directory name)
  --workspace <dir>    Workspace directory (default: current directory)
  --runtime <r>        docker | container — chosen at creation, stored per
                       sandbox (default: $SANDBOX_RUNTIME, else autodetect)
  --agent <a>          claude | codex (default agent for the sandbox)
  --headed             Enable the GUI stack; browser visible via noVNC
  --docker             Docker-in-sandbox: agents can build/run containers
                       inside (sticky — remembered in the sandbox config)
  --host-open          URLs open in the HOST browser, workspace files in the
                       HOST editor (xdg-open/open/code inside forward to the
                       vivary broker; sticky). "vivary broker stop" stops the broker.
                       OAuth logins work: localhost callbacks are relayed
                       from the host into the sandbox automatically.
  --own-modules[=N]    Keep node_modules container-side (sticky): every dir
                       with a package.json (scanned N levels deep, default 4)
                       gets a per-sandbox overlay, so Linux modules never mix
                       with the host's macOS ones. New package.json files are
                       picked up live. --own-modules=0 turns it off.
  --clipboard          Bridge the HOST clipboard into the sandbox (sticky):
                       Ctrl+V pastes host screenshots/text into the agent
                       (xclip/pbpaste shims), pbcopy inside sets the host
                       clipboard.
  --memory <m>         Container memory (default: $SANDBOX_MEMORY or 4g)
  --cpus <n>           Container CPUs (default: $SANDBOX_CPUS or 4)

Examples:
  cd ~/work/myproj && slaude          # sandboxed claude for this project
  slaude -r                           # ...resume picker (args go to claude)
  vivary start --headed -- -c            # headed + claude --continue
  vivary create --runtime docker         # explicit create with import wizard
  vivary up && ssh claude-sandbox-myproj # ssh into the sandbox
  vivary ls                              # all sandboxes, both runtimes

State lives in ~/claude-sandboxes/<name>/ (login, settings, skills, ssh keys).
Chat history is shared with the host's ~/.claude/projects — visible from
host Claude Code and vice versa. See README for details.`;

// -------------------------------------------------------------------- main --

async function main() {
  const argv0 = path.basename(process.argv[1] || '');
  const argv = process.argv.slice(2);

  // Agent launchers: `slot [args]` / `sodex [args]` — our flags are parsed,
  // everything unknown is passed to the agent.
  const forcedAgent = AGENT_BINS[argv0.replace(/\.mjs$/, '')];
  if (forcedAgent) {
    if (argv[0] === '--help' || argv[0] === 'help') {
      console.log(`${argv0} — sandboxed ${forcedAgent} in the current directory (wraps 'vivary start')\n`);
      console.log(HELP);
      return;
    }
    await cmdStart(argv, forcedAgent);
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'start':
    case 'run':
      await cmdStart(rest);
      break;
    case 'create':
      await cmdCreate(rest);
      break;
    case 'up':
      await cmdUp(rest);
      break;
    case 'down':
      cmdDown(rest);
      break;
    case 'ls':
    case 'list':
      cmdList();
      break;
    case 'shell':
      await cmdShell(rest);
      break;
    case 'rm':
      await cmdRm(rest);
      break;
    case 'build':
      cmdBuild(rest);
      break;
    case 'broker':
      cmdBroker(rest);
      break;
    case '--version':
    case 'version':
      console.log(pkg.version);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      die(`unknown command: ${cmd} (see 'vivary help')`);
  }
}

main().catch((e) => die(e.message || String(e)));
