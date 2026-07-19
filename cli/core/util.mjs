// Shared utilities and constants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const SANDBOXES_DIR = process.env.SANDBOXES_DIR || path.join(HOME, 'claude-sandboxes');
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
