// Shared utilities and constants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const SANDBOXES_DIR = process.env.SANDBOXES_DIR || path.join(HOME, '.vivary');
const LEGACY_SANDBOXES_DIR = path.join(HOME, 'claude-sandboxes');

// One-time ~/claude-sandboxes -> ~/.vivary migration. Everything inside
// (.broker, .ashp, per-sandbox dirs) moves with the rename; managed
// ~/.ssh/config blocks reference identity files under the old path, so they
// are rewritten in place (only inside vivary/sbx/sandbox.sh marker blocks).
// Running containers keep their old mounts until restarted — the notice says
// so. Skipped when SANDBOXES_DIR is overridden via env.
export function migrateLegacyHome() {
  if (process.env.SANDBOXES_DIR) return;
  if (!fs.existsSync(LEGACY_SANDBOXES_DIR)) return;
  if (fs.existsSync(SANDBOXES_DIR)) {
    console.error(`WARNING: both ${LEGACY_SANDBOXES_DIR} and ${SANDBOXES_DIR} exist — ` +
      `using ${SANDBOXES_DIR}, the legacy dir is ignored (merge or remove it manually).`);
    return;
  }
  fs.renameSync(LEGACY_SANDBOXES_DIR, SANDBOXES_DIR);
  rewriteSshConfigPaths();
  console.log(`==> Migrated sandbox home: ${LEGACY_SANDBOXES_DIR} -> ${SANDBOXES_DIR}`);
  console.log('    Running containers keep the old mounts until restarted ' +
    '(vivary down/up; vivary egress stop for the egress proxy; broker restarts itself).');
}

// Rewrite legacy identity-file paths inside marker-delimited ~/.ssh/config
// blocks (the ssh plugin owns the block format; markers match its writers).
function rewriteSshConfigPaths() {
  const cfgFile = path.join(HOME, '.ssh/config');
  if (!fs.existsSync(cfgFile)) return;
  const lines = fs.readFileSync(cfgFile, 'utf8').split('\n');
  let inBlock = false;
  let changed = false;
  const out = lines.map((line) => {
    if (/^# >>> claude-sandbox:/.test(line)) inBlock = true;
    const isEnd = /^# <<< claude-sandbox:/.test(line);
    let next = line;
    if (inBlock && line.includes(LEGACY_SANDBOXES_DIR)) {
      next = line.split(LEGACY_SANDBOXES_DIR).join(SANDBOXES_DIR);
      changed = true;
    }
    if (isEnd) inBlock = false;
    return next;
  });
  if (changed) {
    fs.writeFileSync(cfgFile, out.join('\n'));
    console.log('==> Rewrote sandbox identity paths in ~/.ssh/config managed blocks');
  }
}
export const IMAGE = process.env.SANDBOX_IMAGE || 'agent-sandbox-agents';
export const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_TTY = process.stdin.isTTY && process.stdout.isTTY;
export const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'));

export function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

export function hasCmd(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0;
}

export function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function runInherit(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

export function sanitizeName(s) {
  const name = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'sandbox';
}

// Tiny flag parser: known flags per spec ('string' | 'boolean' | 'optional'),
// `--key=value` form supported, `--` starts passthrough args, unknown tokens
// land in positionals (or passthrough when unknownToRest).
export function parseArgs(argv, spec, { unknownToRest = false } = {}) {
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
