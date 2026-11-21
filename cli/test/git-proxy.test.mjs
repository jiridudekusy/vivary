// The git proxy, end to end with real git on both sides: a "sandbox" client
// (its git rewritten to the broker exactly as the handed-in gitconfig does,
// the ssh shim as core.sshCommand) -> the broker's handlers -> an upstream
// bare repository (git http-backend for the HTTPS path, local
// git-upload-pack/git-receive-pack standing in for ssh). Only the policy and
// the credential lookup are stand-ins.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { makeHttpHandler, makeSshHandler, sandboxGitconfig } = await import('../plugins/git/plugin.mjs');
const {
  findEntry, parsePushCommands, refAllowed, repoKey, validateGitConfig, mergePolicy, pkt, FLUSH,
} = await import('../plugins/git/policy.mjs');

const SHIM = fileURLToPath(new URL('../plugins/git/rootfs/vivary-git-ssh.mjs', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-git-'));
const ROOT = path.join(TMP, 'upstream');
const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...opts.env } });
  return { ...r, out: `${r.stdout}${r.stderr}` };
};

// Two upstream repositories with a commit on main.
for (const repo of ['owner/repo.git', 'owner/other.git', 'awid/name.git']) {
  const dir = path.join(ROOT, repo);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', dir]);
}
const seed = path.join(TMP, 'seed');
git(['init', '-q', '-b', 'main', seed]);
fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
git(['-C', seed, 'add', '.']);
git(['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
for (const repo of ['owner/repo.git', 'owner/other.git', 'awid/name.git']) git(['-C', seed, 'push', '-q', path.join(ROOT, repo), 'main']);

const POLICY = validateGitConfig([
  { repo: 'github.com/owner/repo', push: ['agent/*'] },
  { repo: 'github.com/owner/readonly' },
  { repo: 'uucodebase.test/awid/name', push: ['agent/*'] },
], 'test');

// --- an upstream smart-HTTP server: git http-backend as CGI ---------------------
const seenAuth = [];
const upstream = http.createServer((req, res) => {
  seenAuth.push(req.headers.authorization || '');
  const u = new URL(req.url, 'http://x');
  const cgi = spawn('git', ['http-backend'], {
    env: {
      ...process.env, GIT_PROJECT_ROOT: ROOT, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'mac', REMOTE_ADDR: '127.0.0.1',
      REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
      GIT_PROTOCOL: req.headers['git-protocol'] || '',
    },
  });
  req.pipe(cgi.stdin);
  let buf = Buffer.alloc(0);
  let headDone = false;
  cgi.stdout.on('data', (d) => {
    if (headDone) return res.write(d);
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return undefined;
    headDone = true;
    let status = 200;
    const headers = {};
    for (const line of buf.subarray(0, end).toString().split('\r\n')) {
      const [k, ...v] = line.split(':');
      if (/^status$/i.test(k)) status = parseInt(v.join(':'), 10);
      else headers[k.toLowerCase()] = v.join(':').trim();
    }
    res.writeHead(status, headers);
    return res.write(buf.subarray(end + 4));
  });
  cgi.on('close', () => res.end());
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

// --- the broker: just the two git handlers ---------------------------------------
const logs = [];
const log = (l) => logs.push(l);
const sandboxByToken = (t) => (t === 'T0KEN' ? { name: 'sb' } : null);
const brokerRaw = makeHttpHandler({
  policyFor: () => POLICY,
  credential: () => ({ username: 'mac-user', password: 'mac-secret' }),
  request: http.request,
  upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
});
const brokerUpgrade = makeSshHandler({
  policyFor: () => POLICY,
  // stands in for `ssh -p ... git@host "<service> '<path>'"`
  sshSpawn: (args) => {
    const [, service, p] = args.at(-1).match(/^(\S+) '(.+)'$/);
    return spawn(service, [path.join(ROOT, p.replace(/^\//, ''))], { stdio: ['pipe', 'pipe', 'pipe'] });
  },
});
const broker = http.createServer((req, res) => {
  if (!brokerRaw({ req, res, log, sandboxByToken })) { res.writeHead(404); res.end(); }
});
broker.on('upgrade', (req, socket, head) => {
  const sandbox = sandboxByToken(req.headers['x-vivary-token']);
  if (!sandbox) return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  if (!brokerUpgrade({ req, socket, head, sandbox, log })) socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  return undefined;
});
await new Promise((r) => broker.listen(0, '127.0.0.1', r));
const BROKER = `http://127.0.0.1:${broker.address().port}`;
after(() => { broker.close(); upstream.close(); });

// --- the "sandbox": the gitconfig vivary hands in, pointed at this broker ---------
const helper = path.join(TMP, 'helper.sh');
fs.writeFileSync(helper, '#!/bin/sh\n[ "$1" = get ] || exit 0\ncat >/dev/null\nprintf "username=vivary\\npassword=T0KEN\\n"\n', { mode: 0o755 });
const gitconfig = path.join(TMP, 'sandbox.gitconfig');
fs.writeFileSync(gitconfig, sandboxGitconfig(POLICY, BROKER)
  .replace('/usr/local/bin/vivary-git-ssh', `node ${SHIM}`)
  .replace('/usr/local/bin/vivary-git-credential', helper));
// Async: the broker and the upstream live in THIS process, so a synchronous
// git client would block the very servers it talks to.
const runAsync = (cmd, args, { cwd = TMP, env = {} } = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } });
  let out = '';
  let stderr = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; stderr += d; });
  c.on('close', (status) => resolve({ status, out, stderr }));
});
const SBX_ENV = { GIT_CONFIG_GLOBAL: gitconfig, SBX_OPEN_URL: `${BROKER}/`, SBX_OPEN_TOKEN: 'T0KEN', GIT_TERMINAL_PROMPT: '0' };
const sbx = (args, cwd = TMP, env = SBX_ENV) => runAsync('git', args, { cwd, env });
const commit = async (dir, msg) => {
  fs.writeFileSync(path.join(dir, `${msg}.txt`), `${msg}\n`);
  await sbx(['add', '.'], dir);
  await sbx(['-c', 'user.name=agent', '-c', 'user.email=a@a', 'commit', '-q', '-m', msg], dir);
};
const upstreamHas = (repo, ref) => git(['--git-dir', path.join(ROOT, repo), 'rev-parse', '--verify', '-q', ref]).status === 0;

test('HTTPS: clone, push to an allowed branch, refused push to main — the Mac credential never reaches git', async () => {
  const dir = path.join(TMP, 'h1');
  const c = await sbx(['clone', '-q', 'https://github.com/owner/repo.git', dir]);
  assert.equal(c.status, 0, c.out);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
  await commit(dir, 'one');
  const ok = await sbx(['push', 'origin', 'HEAD:refs/heads/agent/one'], dir);
  assert.equal(ok.status, 0, ok.out);
  assert.ok(upstreamHas('owner/repo.git', 'refs/heads/agent/one'));
  const bad = await sbx(['push', 'origin', 'HEAD:refs/heads/main'], dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /remote rejected.*vivary: push to refs\/heads\/main is not allowed/);
  assert.equal(git(['--git-dir', path.join(ROOT, 'owner/repo.git'), 'rev-parse', 'main']).stdout,
    git(['-C', seed, 'rev-parse', 'main']).stdout, 'main unchanged upstream');
  assert.ok(seenAuth.every((a) => a === `Basic ${Buffer.from('mac-user:mac-secret').toString('base64')}`));
  assert.ok(!fs.readFileSync(path.join(dir, '.git/config'), 'utf8').includes('mac-secret'));
});

test('HTTPS: a repository not listed is not even fetchable; a listed one without push is read-only', async () => {
  const r = await sbx(['clone', '-q', 'https://github.com/owner/other.git', path.join(TMP, 'h2')]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /remote error: vivary: github\.com\/owner\/other is not allowed/);
  const s = await sbx(['ls-remote', 'git@github.com:owner/other.git']);
  assert.match(s.out, /not allowed/, 'the ssh spelling of a github URL is rewritten to the proxy too');
  assert.ok(logs.some((l) => /DENIED git sb fetch github\.com\/owner\/other/.test(l)));
  const ro = await sbx(['push', 'https://github.com/owner/readonly.git', 'HEAD:refs/heads/agent/x'], path.join(TMP, 'h1'));
  assert.notEqual(ro.status, 0);
  assert.match(ro.out, /remote error: vivary: github\.com\/owner\/readonly is read-only/);
});

test('SSH (uuCodebase): clone and an allowed push through the shim; main refused, nothing sent', async () => {
  const dir = path.join(TMP, 's1');
  const c = await sbx(['clone', '-q', 'ssh://git@uucodebase.test:9422/awid/name.git', dir]);
  assert.equal(c.status, 0, c.out);
  await commit(dir, 'two');
  const ok = await sbx(['push', 'origin', 'HEAD:refs/heads/agent/two'], dir);
  assert.equal(ok.status, 0, ok.out);
  assert.ok(upstreamHas('awid/name.git', 'refs/heads/agent/two'));
  const bad = await sbx(['push', 'origin', 'HEAD:refs/heads/main'], dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /vivary: push to refs\/heads\/main is not allowed/);
  assert.equal(git(['--git-dir', path.join(ROOT, 'awid/name.git'), 'rev-parse', 'main']).stdout,
    git(['-C', seed, 'rev-parse', 'main']).stdout, 'main unchanged upstream');
  const other = await sbx(['ls-remote', 'ssh://git@uucodebase.test:9422/awid/secret.git']);
  assert.match(other.out, /not allowed for sandbox sb/);
});

test('SSH: a wrong token, or anything but git fetch/push, is refused', async () => {
  const r = await sbx(['ls-remote', 'ssh://git@uucodebase.test:9422/awid/name.git'], TMP, { ...SBX_ENV, SBX_OPEN_TOKEN: 'wrong' });
  assert.notEqual(r.status, 0);
  const shell = await runAsync('node', [SHIM, '-p', '9422', 'git@uucodebase.test', 'cat /etc/passwd'], { env: SBX_ENV });
  assert.notEqual(shell.status, 0);
  assert.match(shell.stderr, /only git fetch\/push/);
});

test('policy: repo keys, globs, branch patterns, merging, validation', () => {
  assert.equal(repoKey('GitHub.com', '/Owner/Repo.git'), 'github.com/Owner/Repo');
  assert.equal(repoKey('h', '/a/../b'), null);
  assert.equal(repoKey('h', "a/b'; rm"), null);
  const pol = [{ repo: 'github.com/acme/*', push: ['**'] }, { repo: 'github.com/acme/core', push: ['agent/*'] }];
  assert.equal(findEntry(pol, 'github.com/acme/core').push[0], 'agent/*', 'an exact entry beats a glob');
  assert.equal(findEntry(pol, 'github.com/acme/x/y'), null, '* stays within a segment');
  assert.ok(refAllowed({ push: ['agent/*'] }, 'refs/heads/agent/a'));
  assert.ok(!refAllowed({ push: ['agent/*'] }, 'refs/heads/agent/a/b'));
  assert.ok(refAllowed({ push: ['agent/**'] }, 'refs/heads/agent/a/b'));
  assert.ok(!refAllowed({ push: ['agent/*'] }, 'refs/tags/agent/a'));
  assert.ok(refAllowed({ push: ['refs/tags/v*'] }, 'refs/tags/v1'));
  assert.ok(!refAllowed({}, 'refs/heads/x'));
  assert.deepEqual(mergePolicy([{ repo: 'h/a', push: ['x'] }], [{ repo: 'H/a', push: ['y'] }])[0].push, ['x', 'y']);
  assert.throws(() => validateGitConfig([{ repo: 'github.com' }], 'f'), /host\/path/);
  assert.throws(() => validateGitConfig([{ repo: 'h/a', push: 'main' }], 'f'), /array of branch patterns/);
  assert.throws(() => validateGitConfig([{ repo: 'h/a', token: 'x' }], 'f'), /unknown key 'token'/);
  const z = '0'.repeat(40);
  assert.deepEqual(parsePushCommands(Buffer.concat([pkt(`${z} ${'1'.repeat(40)} refs/heads/a\0report-status`)])), { done: false });
  assert.match(parsePushCommands(Buffer.concat([pkt('push-cert\0x'), FLUSH])).error, /signed pushes/);
});
