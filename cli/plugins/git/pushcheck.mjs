// The fast-forward check of a push, on the Mac, from the pushed pack alone
// (why that is enough: policy.mjs, "proving a fast-forward").
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
import { parseBatchCommits, reaches } from './policy.mjs';

export const MAX_PUSH_BODY = 2 * 1024 ** 3; // GitHub's own push limit

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

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };

function git(args, { input, from } = {}) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { env: { ...process.env, ...GIT_ENV }, stdio: ['pipe', 'pipe', 'pipe'] });
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

// The updates in `updates` ({ old, new, ref }) that the pack in `file` (from
// byte `offset`) does NOT prove to be fast-forwards. { bad } or { error }.
export async function notFastForward(file, offset, updates, { objectFormat = 'sha1' } = {}) {
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
    return { bad: updates.filter((c) => !reaches(parents, c.new, c.old)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
