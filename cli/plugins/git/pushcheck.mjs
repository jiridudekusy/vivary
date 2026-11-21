// The fast-forward check of a push, on the Mac: from the pushed pack (why
// that is enough: policy.mjs, "proving a fast-forward") and, only when the
// walk runs into commits the server already has, from the server itself.
//
// The body is spooled to a private temp dir (never held in memory: a pack can
// be big), indexed by `git index-pack` into a throwaway bare repository of its
// own — never the sandbox's .git, which the agent can rewrite, and running git
// there would also read the agent's config (core.fsmonitor = a command on the
// Mac) — and the commits are walked in JS.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOXES_DIR } from '../../core/util.mjs';
import { parseBatchCommits, walkPack } from './policy.mjs';

export const MAX_PUSH_BODY = 2 * 1024 ** 3; // GitHub's own push limit
export const historyCacheDir = () => path.join(SANDBOXES_DIR, '.git-cache');

export class Spool {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-push-'));
    this.file = path.join(this.dir, 'body');
    this.fd = fs.openSync(this.file, 'wx', 0o600);
    this.size = 0;
  }

  write(buf) {
    for (let off = 0; off < buf.length;) off += fs.writeSync(this.fd, buf, off);
    this.size += buf.length;
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  dispose() {
    this.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
};

function git(args, { input, from, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { env: { ...process.env, ...GIT_ENV }, stdio: ['pipe', 'pipe', 'pipe'], timeout });
    const out = [];
    let err = '';
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => { err += d; });
    c.stdin.on('error', () => {});
    c.on('error', (e) => resolve({ status: 255, stdout: Buffer.alloc(0), stderr: e.message }));
    c.on('close', (status) => resolve({ status, stdout: Buffer.concat(out), stderr: err }));
    if (from) from.pipe(c.stdin);
    else c.stdin.end(input || '');
  });
}

// --- the server's history ----------------------------------------------------------
//
// A bare, commits-only (`--filter=tree:0`) copy of the server's branches and
// tags per repository under ~/.vivary/.git-cache — the Mac's own, filled only
// from the server (with the Mac's credentials, through its credential helper
// or ssh keys), so it can be trusted where the sandbox's .git cannot. A
// server without filter support gets a full copy instead (git falls back by
// itself). One fetch at a time per repository.

const locks = new Map();
function serialized(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

const REFSPECS = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];

async function refreshHistory(cache, url) {
  if (!fs.existsSync(path.join(cache, 'HEAD'))) {
    fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    const r = await git(['clone', '-q', '--bare', '--filter=tree:0', url, cache], { timeout: 600000 });
    if (r.status !== 0) {
      fs.rmSync(cache, { recursive: true, force: true });
      return `cannot read the server's history: ${r.stderr.trim().split('\n').pop()}`;
    }
    await git(['--git-dir', cache, 'config', '--unset-all', 'remote.origin.fetch']);
    for (const spec of REFSPECS) await git(['--git-dir', cache, 'config', '--add', 'remote.origin.fetch', spec]);
    return null;
  }
  await git(['--git-dir', cache, 'remote', 'set-url', 'origin', url]);
  const r = await git(['--git-dir', cache, 'fetch', '-q', '--prune', 'origin'], { timeout: 600000 });
  return r.status === 0 ? null : `cannot read the server's history: ${r.stderr.trim().split('\n').pop()}`;
}

// Is `old` behind any of `exits`, according to the server? { ok } or { error }.
async function serverConfirms(cache, url, old, exits) {
  return serialized(cache, async () => {
    const error = await refreshHistory(cache, url);
    if (error) return { error };
    for (const x of exits) {
      const r = await git(['--git-dir', cache, 'merge-base', '--is-ancestor', old, x]);
      if (r.status === 0) return { ok: true };
    }
    return { ok: false };
  });
}

// The updates in `updates` ({ old, new, ref }) that are NOT fast-forwards.
// `server` = { cache, url }: where to ask when the pack alone cannot tell.
// { bad, asked } or { error }.
export async function notFastForward(file, offset, updates, { objectFormat = 'sha1', server } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-ff-'));
  try {
    const repo = path.join(dir, 'r.git');
    let r = await git(['init', '-q', '--bare', `--object-format=${objectFormat}`, repo]);
    if (r.status !== 0) return { error: `git init: ${r.stderr.trim()}` };
    // No --fix-thin: a delta against an object outside the pack fails here.
    r = await git(['--git-dir', repo, 'index-pack', '--stdin'], { from: fs.createReadStream(file, { start: offset }) });
    if (r.status !== 0) return { error: `the pushed pack cannot be checked (${r.stderr.trim().split('\n').pop()})` };
    r = await git(['--git-dir', repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
    const commits = r.stdout.toString('latin1').split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]);
    r = await git(['--git-dir', repo, 'cat-file', '--batch'], { input: commits.length ? `${commits.join('\n')}\n` : '' });
    const parents = parseBatchCommits(r.stdout);
    const bad = [];
    let asked = false;
    for (const c of updates) {
      const walk = walkPack(parents, c.new, c.old);
      if (walk.reached) continue;
      if (!walk.exits.size || !server) { bad.push(c); continue; }
      asked = true;
      const s = await serverConfirms(server.cache, server.url, c.old, walk.exits);
      if (s.error) return { error: s.error };
      if (!s.ok) bad.push(c);
    }
    return { bad, asked };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
