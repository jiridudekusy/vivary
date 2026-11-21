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
import { createHash } from 'node:crypto';

const { makeHttpHandler, makeSshHandler, sandboxGitconfig } = await import('../plugins/git/plugin.mjs');
const {
  PackEnd, capabilityInjector, findEntry, judgePush, parseBatchCommits, parsePushCommands, walkPack, refAllowed, repoKey,
  validateGitConfig, mergePolicy, pkt, FLUSH,
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
  git(['--git-dir', dir, 'config', 'uploadpack.allowFilter', 'true']);
}
const seed = path.join(TMP, 'seed');
git(['init', '-q', '-b', 'main', seed]);
fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
git(['-C', seed, 'add', '.']);
git(['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
for (const repo of ['owner/repo.git', 'owner/other.git', 'awid/name.git']) git(['-C', seed, 'push', '-q', path.join(ROOT, repo), 'main']);

const POLICY = validateGitConfig([
  { repo: 'github.com/owner/repo', push: ['agent/**'], force: ['agent/scratch/*'], delete: ['agent/scratch/*'] },
  { repo: 'github.com/owner/readonly' },
  { repo: 'uucodebase.test/awid/name', push: ['agent/**'], force: ['agent/scratch/*'], delete: ['agent/scratch/*'] },
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
  historyDir: path.join(TMP, 'history'),
});
const brokerUpgrade = makeSshHandler({
  policyFor: () => POLICY,
  // stands in for `ssh -p ... git@host "<service> '<path>'"`
  sshSpawn: (args) => {
    const [, service, p] = args.at(-1).match(/^(\S+) '(.+)'$/);
    return spawn(service, [path.join(ROOT, p.replace(/^\//, ''))], { stdio: ['pipe', 'pipe', 'pipe'] });
  },
  serverUrl: ({ rawPath }) => `file://${path.join(ROOT, rawPath)}`,
  historyDir: path.join(TMP, 'history'),
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
const upstreamRev = (repo, ref) => git(['--git-dir', path.join(ROOT, repo), 'rev-parse', '--verify', '-q', ref]).stdout.trim();
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

// Fast-forward, force and delete rules, the same over both transports. The
// big file makes a delta against the server's copy tempting: a thin pack
// would lean on it and fail the check, so a pass also proves no-thin works.
for (const [label, url, repo] of [
  ['HTTPS', 'https://github.com/owner/repo.git', 'owner/repo.git'],
  ['SSH', 'ssh://git@uucodebase.test:9422/awid/name.git', 'awid/name.git'],
]) {
  test(`${label}: fast-forwards pass, rewrites and deletes only where force/delete allow`, async () => {
    const dir = path.join(TMP, `ff-${label}`);
    assert.equal((await sbx(['clone', '-q', url, dir])).status, 0);
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} of a file that deltas well`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), `${big}\n`);
    await commit(dir, 'base');
    for (const b of ['agent/ff', 'agent/scratch/x']) {
      assert.equal((await sbx(['push', 'origin', `HEAD:refs/heads/${b}`], dir)).status, 0);
    }
    fs.writeFileSync(path.join(dir, 'big.txt'), `${big}\nchanged\n`);
    await commit(dir, 'next');
    const ff = await sbx(['push', 'origin', 'HEAD:refs/heads/agent/ff'], dir);
    assert.equal(ff.status, 0, ff.out);
    const head = (await sbx(['rev-parse', 'HEAD'], dir)).out.trim();
    assert.equal(upstreamRev(repo, 'refs/heads/agent/ff'), head);
    assert.ok(logs.some((l) => l.includes('fast-forward checked')));

    await sbx(['-c', 'user.name=agent', '-c', 'user.email=a@a', 'commit', '-q', '--amend', '-m', 'rewritten'], dir);
    const force = await sbx(['push', '--force', 'origin', 'HEAD:refs/heads/agent/ff'], dir);
    assert.notEqual(force.status, 0);
    assert.match(force.out, /agent\/ff: not a fast-forward, and force push is not allowed/);
    assert.equal(upstreamRev(repo, 'refs/heads/agent/ff'), head, 'the rewrite never reached the server');
    const reset = await sbx(['push', '--force', 'origin', 'HEAD~2:refs/heads/agent/ff'], dir);
    assert.notEqual(reset.status, 0, 'moving a branch back is a rewrite too');
    const allowed = await sbx(['push', '--force', 'origin', 'HEAD:refs/heads/agent/scratch/x'], dir);
    assert.equal(allowed.status, 0, allowed.out);

    const del = await sbx(['push', 'origin', ':refs/heads/agent/ff'], dir);
    assert.notEqual(del.status, 0);
    assert.match(del.out, /deleting refs\/heads\/agent\/ff is not allowed/);
    assert.ok(upstreamHas(repo, 'refs/heads/agent/ff'));
    assert.equal((await sbx(['push', 'origin', ':refs/heads/agent/scratch/x'], dir)).status, 0);
    assert.ok(!upstreamHas(repo, 'refs/heads/agent/scratch/x'));
  });

  test(`${label}: a fast-forward over commits only the server has is confirmed by the server`, async () => {
    const dir = path.join(TMP, `srv-${label}`);
    assert.equal((await sbx(['clone', '-q', url, dir])).status, 0);
    await commit(dir, 'feature');
    assert.equal((await sbx(['push', 'origin', 'HEAD:refs/heads/agent/merged'], dir)).status, 0);
    const feat = (await sbx(['rev-parse', 'HEAD'], dir)).out.trim();
    // as a PR merge would: on the server, main takes the branch and moves on
    const side = path.join(TMP, `side-${label}`);
    git(['clone', '-q', path.join(ROOT, repo), side]);
    git(['-C', side, 'fetch', '-q', 'origin', 'agent/merged']);
    git(['-C', side, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'merge PR', 'FETCH_HEAD']);
    assert.equal(git(['-C', side, 'push', '-q', 'origin', 'main']).status, 0);
    // the agent goes on from main on the same branch: its commit's parent is
    // the merge, which the server has and the pack therefore does not carry
    await sbx(['fetch', '-q', 'origin'], dir);
    await sbx(['checkout', '-q', '-B', 'cont', 'origin/main'], dir);
    await commit(dir, 'continued');
    const cont = await sbx(['push', 'origin', 'HEAD:refs/heads/agent/merged'], dir);
    assert.equal(cont.status, 0, cont.out);
    assert.ok(logs.some((l) => l.includes('agent/merged') && l.includes('asked the server')));
    // a branch behind main moved onto it: the pack is empty
    assert.equal((await sbx(['push', 'origin', `${feat}:refs/heads/agent/behind`], dir)).status, 0);
    const mv = await sbx(['push', 'origin', 'origin/main:refs/heads/agent/behind'], dir);
    assert.equal(mv.status, 0, mv.out);
    // and a rewrite the server's history exposes
    const back = await sbx(['push', '--force', 'origin', 'origin/main:refs/heads/agent/merged'], dir);
    assert.notEqual(back.status, 0);
    assert.match(back.out, /agent\/merged: not a fast-forward/);
    // the Mac's copy of the server's history holds commits, no file contents
    const key = repoKey(new URL(url).hostname, new URL(url).pathname);
    const kinds = git(['--git-dir', `${path.join(TMP, 'history', ...key.split('/'))}.git`, 'cat-file',
      '--batch-all-objects', '--batch-check=%(objecttype)']).stdout;
    assert.match(kinds, /commit/);
    assert.doesNotMatch(kinds, /blob/);
  });
}

test('push rules and the wire helpers', () => {
  const z = '0'.repeat(40);
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const entry = { push: ['agent/**'], force: ['agent/tmp/*'], delete: ['agent/tmp/*'] };
  const v = judgePush(entry, [
    { old: z, new: a, ref: 'refs/heads/agent/new' }, // create: push is enough
    { old: a, new: b, ref: 'refs/heads/agent/x' }, // update: must prove ff
    { old: a, new: b, ref: 'refs/heads/agent/tmp/y' }, // force allowed
    { old: a, new: z, ref: 'refs/heads/agent/x' }, // delete: not allowed
    { old: a, new: z, ref: 'refs/heads/agent/tmp/y' }, // delete allowed
    { old: a, new: b, ref: 'refs/heads/main' }, // not pushable at all
  ]);
  assert.deepEqual(v.ancestry.map((c) => c.ref), ['refs/heads/agent/x']);
  assert.deepEqual(v.denied, [{ ref: 'refs/heads/agent/x', why: 'delete' }, { ref: 'refs/heads/main', why: 'push' }]);
  assert.deepEqual(mergePolicy([{ repo: 'h/a', push: ['x'], force: ['x'] }], [{ repo: 'h/a', delete: ['y'] }])[0],
    { repo: 'h/a', push: ['x'], force: ['x'], delete: ['y'] });
  assert.throws(() => validateGitConfig([{ repo: 'h/a', force: 'x' }], 'f'), /'force' must be an array/);

  // the walk: merges, and a parent outside the pack ends that path
  const parents = new Map([['c3', ['c2', 'm1']], ['c2', ['c1']], ['c1', []], ['m1', ['outside']]]);
  assert.ok(walkPack(parents, 'c3', 'c1').reached);
  assert.ok(walkPack(parents, 'c3', 'outside').reached, 'the old tip itself may be outside the pack');
  assert.deepEqual(walkPack(parents, 'c3', 'elsewhere'), { reached: false, exits: new Set(['outside']) },
    'the walk names where it left the pack: the server decides there');
  assert.deepEqual([...walkPack(parents, 'unknown', 'c1').exits], ['unknown'], 'a new tip not in the pack: ask about it');
  assert.equal(walkPack(new Map([['r', []]]), 'r', 'x').exits.size, 0, 'unrelated history: nothing to ask');
  const batch = Buffer.from('c1 commit 34\ntree t\nparent p1\nparent p2\n\nmsg\nx missing\n');
  assert.deepEqual([...parseBatchCommits(batch)], [['c1', ['p1', 'p2']]]);

  // no-thin lands on the first ref line, split anywhere, and nothing else moves
  const adv = Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH,
    pkt(`${a} refs/heads/main\0report-status side-band-64k\n`), pkt(`${b} refs/heads/x\n`), FLUSH]);
  for (const cut of [3, 40, 70]) {
    const inj = capabilityInjector('no-thin');
    const out = Buffer.concat([inj.feed(adv.subarray(0, cut)), inj.feed(adv.subarray(cut)), inj.end()]).toString();
    assert.ok(out.includes('report-status side-band-64k no-thin\n'), out);
    assert.ok(out.endsWith(`${pkt(`${b} refs/heads/x\n`)}0000`));
  }

  // the pack end: its trailing hash, however the stream is chunked
  const body = Buffer.concat([Buffer.from('PACK\0\0\0\x02\0\0\0\0'), Buffer.from('x'.repeat(50))]);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const pe = new PackEnd();
  assert.ok(!pe.feed(pack.subarray(0, 30)));
  assert.ok(!pe.feed(pack.subarray(30, pack.length - 5)));
  assert.ok(pe.feed(pack.subarray(pack.length - 5)));

  // push-options: the pack starts after their list
  const withOpts = Buffer.concat([pkt(`${z} ${a} refs/heads/x\0report-status push-options`), FLUSH, pkt('ci.skip'), FLUSH, Buffer.from('PACK')]);
  assert.equal(parsePushCommands(withOpts).end, withOpts.length - 4);
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
