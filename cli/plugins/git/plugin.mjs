// git: the sandbox reaches git repositories through the Mac, and no git
// credential ever enters it.
//
// Two ways out, the same rules (policy.mjs):
// - HTTPS hosts (github.com, ...): the sandbox's git talks smart HTTP to the
//   broker — `url.<broker>/git/<host>/.insteadOf https://<host>/` (and the
//   ssh spellings) in a gitconfig handed into its RAM. The broker checks the
//   repository and, for a push, the refs being updated, then forwards to the
//   real host with credentials it gets from `git credential fill` on the Mac
//   (gh, the osxkeychain helper — whatever the Mac's own git uses).
// - SSH hosts (uuCodebase speaks only ssh): `core.sshCommand` is the
//   vivary-git-ssh shim, which carries the stream to the broker over an HTTP
//   Upgrade; the broker allows only git-upload-pack / git-receive-pack on an
//   allowed repository and runs `ssh` ON THE MAC with the Mac's keys.
// The sandbox authenticates to the broker with its own broker token (RAM,
// fresh per start): the shim reads it, and for HTTPS a credential helper
// hands it to git as the password for the broker's URL.
//
// Which repositories: `git` in the approved .vivary.json and in profiles —
// read here without die() (the broker must not exit on a broken profile).
// No entry, no feature: nothing is handed in and the broker refuses all.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { STATUS_CODES } from 'node:http';
import { parseConfig, profilesDir } from '../../core/config.mjs';
import { approvedProject } from '../../core/effective.mjs';
import { pluginFlagDefs, pluginsLoaded } from '../../core/plugins.mjs';
import {
  PackEnd, capabilityInjector, denialText, findEntry, judgePush, mergePolicy, objectFormatOf, parsePushCommands,
  rejectReport, repoKey, transportFor, pkt,
} from './policy.mjs';
import { MAX_PUSH_BODY, Spool, historyCacheDir, notFastForward } from './pushcheck.mjs';

const BROKER_IN_SANDBOX = 'http://host.docker.internal:7377';
const MAX_PUSH_HEAD = 1 << 20; // the command list of a push; refs, not packs

// The sandbox's git rules: approved project file + its profiles. Never dies.
export function gitPolicy(cfg, { defs = pluginsLoaded() ? pluginFlagDefs() : {}, dir = profilesDir() } = {}) {
  if (!cfg) return [];
  let project = null;
  try { project = cfg.workspace ? approvedProject(cfg, defs) : null; } catch { project = null; }
  const names = [...new Set([...(cfg.profiles || []), ...(project?.profiles || [])])];
  const fromProfiles = names.map((n) => {
    try {
      return parseConfig(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'), { scope: 'profile', file: n, knownFlags: defs }).git;
    } catch {
      return null;
    }
  });
  return mergePolicy(project?.git || [], ...fromProfiles);
}

// The gitconfig the sandbox's /etc/gitconfig includes from RAM.
export function sandboxGitconfig(policy, broker = BROKER_IN_SANDBOX) {
  const hosts = [...new Set(policy.filter((e) => transportFor(e) === 'https').map((e) => e.repo.split('/')[0].toLowerCase()))];
  const lines = [
    '# vivary git proxy — handed in at every start; edits are lost on the next one.',
    '[core]', '\tsshCommand = /usr/local/bin/vivary-git-ssh',
    '[ssh]', '\tvariant = ssh',
    `[credential "${broker}"]`, '\thelper =', '\thelper = /usr/local/bin/vivary-git-credential',
  ];
  for (const h of hosts) {
    lines.push(`[url "${broker}/git/${h}/"]`, `\tinsteadOf = https://${h}/`,
      `\tinsteadOf = git@${h}:`, `\tinsteadOf = ssh://git@${h}/`);
  }
  return `${lines.join('\n')}\n`;
}

// --- credentials on the Mac -------------------------------------------------------

const credCache = new Map();
export function macCredential(host, account, { run = spawnSync, now = Date.now() } = {}) {
  const key = `${host}\n${account || ''}`;
  const hit = credCache.get(key);
  if (hit && hit.until > now) return hit.value;
  const input = `protocol=https\nhost=${host}\n${account ? `username=${account}\n` : ''}\n`;
  const r = run('git', ['credential', 'fill'], {
    input, encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const fields = Object.fromEntries(String(r.stdout || '').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
  if (r.status !== 0 || !fields.password) return null;
  const value = { username: fields.username || account || 'x-access-token', password: fields.password };
  credCache.set(key, { value, until: now + 5 * 60 * 1000 });
  return value;
}

// --- smart HTTP ---------------------------------------------------------------------

const ROUTE = /^\/git\/([a-z0-9][a-z0-9.-]*)\/(.+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/i;

function tokenFromBasic(req) {
  const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  const s = Buffer.from(m[1], 'base64').toString('utf8');
  return s.slice(s.indexOf(':') + 1) || null;
}

// git shows an ERR pkt from the ref advertisement as "remote error: <msg>".
function errAdvertisement(res, service, msg) {
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' });
  res.end(Buffer.concat([pkt(`ERR ${msg}\n`)]));
}

// Where the server's history is kept for the fast-forward check (pushcheck.mjs).
const historyCache = (dir, key) => `${path.join(dir || historyCacheDir(), ...key.split('/'))}.git`;

export function makeHttpHandler({
  policyFor = gitPolicy, credential = macCredential, request = https.request, upstreamBase, historyDir,
} = {}) {
  return function brokerRaw({ req, res, log, sandboxByToken }) {
    const url = new URL(req.url, 'http://broker');
    const m = url.pathname.match(ROUTE);
    if (!url.pathname.startsWith('/git/')) return false;
    const deny = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(`${msg}\n`); };
    if (!m) { deny(404, 'not a git path'); return true; }
    const sandbox = sandboxByToken(tokenFromBasic(req));
    if (!sandbox) {
      if (req.headers.authorization) log(`DENIED git bad token from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'www-authenticate': 'Basic realm="vivary git proxy"', 'content-type': 'text/plain' });
      res.end('vivary: no sandbox token\n');
      return true;
    }
    const [, host, rawPath, what] = m;
    const service = what === 'info/refs' ? url.searchParams.get('service') : what;
    if (!['git-upload-pack', 'git-receive-pack'].includes(service)) { deny(403, 'vivary: only fetch and push'); return true; }
    const key = repoKey(host, rawPath);
    const entry = findEntry(policyFor(sandbox), key);
    const push = service === 'git-receive-pack';
    if (!entry || transportFor(entry) !== 'https') {
      log(`DENIED git ${sandbox.name} ${push ? 'push' : 'fetch'} ${key || rawPath}: not allowed`);
      if (what === 'info/refs') errAdvertisement(res, service, `vivary: ${key} is not allowed for sandbox ${sandbox.name}`);
      else deny(403, `vivary: ${key} is not allowed`);
      return true;
    }
    if (push && !(entry.push || []).length) {
      log(`DENIED git ${sandbox.name} push ${key}: read-only`);
      if (what === 'info/refs') errAdvertisement(res, service, `vivary: ${key} is read-only for sandbox ${sandbox.name}`);
      else deny(403, 'vivary: read-only');
      return true;
    }
    const cred = credential(host, entry.account);
    if (!cred) { deny(502, `vivary: the Mac has no git credential for ${host}`); return true; }

    // body: { head } = these bytes then the rest of req; { spool } = the
    // spooled body (disposed when sent). inject: add a capability to the
    // ref advertisement coming back.
    const forward = ({ head: bodyHead, spool, inject } = {}) => {
      const target = new URL(`${upstreamBase || `https://${host}`}/${rawPath}/${what}${url.search}`);
      const headers = { authorization: `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}` };
      for (const h of ['content-type', 'accept', 'content-encoding', 'git-protocol', 'user-agent']) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      if (req.method === 'POST') headers['transfer-encoding'] = 'chunked';
      const up = request(target, { method: req.method, headers }, (ures) => {
        if (ures.statusCode === 401 || ures.statusCode === 403) {
          log(`ERROR git ${sandbox.name} ${key}: ${host} refused the Mac's credential (${ures.statusCode})`);
          ures.resume();
          return deny(502, `vivary: ${host} refused the Mac's credential (${ures.statusCode})`);
        }
        const out = {};
        for (const h of ['content-type', 'cache-control', 'content-encoding', 'expires', 'pragma']) {
          if (ures.headers[h]) out[h] = ures.headers[h];
        }
        res.writeHead(ures.statusCode, out);
        if (!inject || ures.statusCode !== 200) return ures.pipe(res);
        const filter = capabilityInjector(inject);
        ures.on('data', (d) => { const b = filter.feed(d); if (b.length) res.write(b); });
        ures.on('end', () => res.end(filter.end()));
        return undefined;
      });
      up.on('error', (e) => {
        spool?.dispose();
        if (!res.headersSent) deny(502, `vivary: ${host}: ${e.message}`); else res.destroy();
      });
      if (req.method !== 'POST') return up.end();
      if (spool) {
        const rs = fs.createReadStream(spool.file);
        rs.on('close', () => spool.dispose());
        rs.pipe(up);
        return undefined;
      }
      if (bodyHead) up.write(bodyHead);
      req.pipe(up);
      req.resume();
      return undefined;
    };

    if (!(push && what === 'git-receive-pack')) {
      if (what !== 'info/refs') log(`GIT ${sandbox.name} ${push ? 'push' : 'fetch'} ${key}`);
      // no-thin: the pack must be checkable on its own (policy.mjs).
      forward({ inject: push ? 'no-thin' : null });
      return true;
    }
    // A push: read the ref-update commands before anything leaves the Mac.
    if (/gzip|deflate/i.test(req.headers['content-encoding'] || '')) { deny(415, 'vivary: compressed push bodies are not supported'); return true; }
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const parsed = parsePushCommands(head);
      if (!parsed.done && !parsed.error && head.length < MAX_PUSH_HEAD) return;
      req.off('data', onData);
      req.pause();
      if (parsed.error || !parsed.done) {
        log(`DENIED git ${sandbox.name} push ${key}: ${parsed.error || 'command list too long'}`);
        return deny(400, `vivary: ${parsed.error || 'command list too long'}`);
      }
      const refs = parsed.commands.map((c) => c.ref).join(',');
      const reject = (denied) => {
        log(`DENIED git ${sandbox.name} push ${key} ${denied.map((d) => `${d.ref}(${d.why})`).join(',')}`);
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
        const sideband = parsed.caps.some((c) => c.startsWith('side-band'));
        res.end(rejectReport(parsed.commands, denialText(denied), { sideband }));
      };
      const verdict = judgePush(entry, parsed.commands);
      if (verdict.denied.length) return reject(verdict.denied);
      if (!verdict.ancestry.length) {
        log(`GIT ${sandbox.name} push ${key} ${refs}`);
        return forward({ head });
      }
      // Updates without force: the whole body first, then the check.
      const spool = new Spool();
      spool.write(head);
      const fail = (code, msg) => { spool.dispose(); log(`DENIED git ${sandbox.name} push ${key}: ${msg}`); deny(code, `vivary: ${msg}`); };
      req.on('data', (d) => {
        if (spool.size + d.length > MAX_PUSH_BODY) { req.destroy(); return fail(413, 'push too large to check'); }
        return spool.write(d);
      });
      req.on('error', () => spool.dispose());
      req.on('end', async () => {
        spool.close();
        // The Mac's own git asks the server: its credential helper, the account as user name.
        const url = upstreamBase ? `${upstreamBase}/${rawPath}`
          : `https://${entry.account ? `${encodeURIComponent(entry.account)}@` : ''}${host}/${rawPath}`;
        const r = await notFastForward(spool.file, parsed.end, verdict.ancestry, {
          objectFormat: objectFormatOf(parsed.caps), server: { cache: historyCache(historyDir, key), url },
        });
        if (r.error) { spool.dispose(); return reject(verdict.ancestry.map((c) => ({ ref: c.ref, why: 'check', note: r.error }))); }
        if (r.bad.length) { spool.dispose(); return reject(r.bad.map((c) => ({ ref: c.ref, why: 'force' }))); }
        log(`GIT ${sandbox.name} push ${key} ${refs} (fast-forward checked${r.asked ? ', asked the server' : ''})`);
        return forward({ spool });
      });
      req.resume();
      return undefined;
    };
    req.on('data', onData);
    return true;
  };
}

// --- ssh over an HTTP Upgrade -----------------------------------------------------
//
// Broker -> shim frames: [type][len u32 BE][payload]; 1 stdout, 2 stderr,
// 3 exit (payload: one byte, the code). Shim -> broker: the raw stdin stream.

export const frame = (type, data) => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

const SSH_COMMAND = /^(git-upload-pack|git-receive-pack) '([^']+)'$/;

const sshUrl = ({ user, host, port, rawPath }) => `ssh://${user}@${host}:${port}${rawPath.startsWith('/') ? '' : '/~/'}${rawPath}`;

export function makeSshHandler({
  policyFor = gitPolicy, sshSpawn = (args) => spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  serverUrl = sshUrl, historyDir,
} = {}) {
  return function brokerUpgrade({ req, socket, head, sandbox, log }) {
    if (new URL(req.url, 'http://broker').pathname !== '/git-ssh') return false;
    const refuse = (code, msg) => {
      socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Type: text/plain\r\n`
        + `Content-Length: ${Buffer.byteLength(msg) + 1}\r\n\r\n${msg}\n`);
    };
    const host = String(req.headers['x-git-host'] || '').toLowerCase();
    const port = String(req.headers['x-git-port'] || '22');
    const user = String(req.headers['x-git-user'] || 'git');
    const command = Buffer.from(String(req.headers['x-git-command'] || ''), 'base64').toString('utf8');
    const m = command.match(SSH_COMMAND);
    if (!m || !/^[a-z0-9][a-z0-9.-]*$/.test(host) || !/^\d{1,5}$/.test(port) || !/^[A-Za-z0-9._-]+$/.test(user)) {
      log(`DENIED git-ssh ${sandbox.name}: not a git command (${command.slice(0, 60)})`);
      refuse(403, 'vivary: only git fetch/push go through the proxy');
      return true;
    }
    const [, service, rawPath] = m;
    const push = service === 'git-receive-pack';
    const key = repoKey(host, rawPath);
    const entry = findEntry(policyFor(sandbox), key);
    if (!key || !entry || transportFor(entry) !== 'ssh') {
      log(`DENIED git ${sandbox.name} ${push ? 'push' : 'fetch'} ${key || rawPath}: not allowed`);
      refuse(403, `vivary: ${key || rawPath} is not allowed for sandbox ${sandbox.name}`);
      return true;
    }
    if (push && !(entry.push || []).length) {
      log(`DENIED git ${sandbox.name} push ${key}: read-only`);
      refuse(403, `vivary: ${key} is read-only for sandbox ${sandbox.name}`);
      return true;
    }
    if (!/^[A-Za-z0-9._~/-]+$/.test(rawPath)) { refuse(403, 'vivary: unusual repository path'); return true; }

    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: vivary-git\r\n\r\n');
    const child = sshSpawn(['-T', '-o', 'BatchMode=yes', '-p', port, `${user}@${host}`, `${service} '${rawPath}'`]);
    let finished = false;
    const finish = (code, msg) => {
      if (finished) return;
      finished = true;
      if (msg) socket.write(frame(2, `${msg}\n`));
      socket.end(frame(3, Buffer.from([code & 0xff])));
    };
    const filter = push ? capabilityInjector('no-thin') : null; // see policy.mjs
    child.stdout.on('data', (d) => {
      const b = filter ? filter.feed(d) : d;
      if (b.length) socket.write(frame(1, b));
    });
    child.stdout.on('end', () => { const b = filter?.end(); if (b?.length) socket.write(frame(1, b)); });
    child.stderr.on('data', (d) => socket.write(frame(2, d)));
    child.on('error', (e) => finish(255, `vivary: ssh: ${e.message}`));
    child.on('close', (code) => finish(code ?? 255));
    child.stdin.on('error', () => {});
    socket.on('close', () => { if (!finished) child.kill('SIGTERM'); });

    if (!push) {
      log(`GIT ${sandbox.name} fetch ${key} (ssh)`);
      if (head?.length) child.stdin.write(head);
      socket.pipe(child.stdin);
      return true;
    }
    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const check = () => {
      const parsed = parsePushCommands(buf);
      if (!parsed.done && !parsed.error && buf.length < MAX_PUSH_HEAD) return false;
      socket.off('data', onData);
      if (parsed.error || !parsed.done) {
        log(`DENIED git ${sandbox.name} push ${key}: ${parsed.error || 'command list too long'}`);
        child.kill('SIGTERM');
        finish(1, `vivary: ${parsed.error || 'command list too long'}`);
        return true;
      }
      const refs = parsed.commands.map((c) => c.ref).join(',');
      const reject = (denied) => {
        log(`DENIED git ${sandbox.name} push ${key} ${denied.map((d) => `${d.ref}(${d.why})`).join(',')} (ssh)`);
        child.kill('SIGTERM');
        finish(1, denialText(denied));
      };
      const verdict = judgePush(entry, parsed.commands);
      if (verdict.denied.length) { reject(verdict.denied); return true; }
      if (!verdict.ancestry.length) {
        log(`GIT ${sandbox.name} push ${key} ${refs} (ssh)`);
        child.stdin.write(buf);
        socket.pipe(child.stdin);
        return true;
      }
      // Updates without force: the whole pack first (ssh has no body end —
      // PackEnd spots the pack's trailing hash), then the check.
      socket.pause();
      const spool = new Spool();
      socket.on('close', () => spool.dispose());
      const packEnd = new PackEnd(objectFormatOf(parsed.caps));
      const decide = async () => {
        socket.off('data', onPack);
        socket.pause();
        spool.close();
        const r = await notFastForward(spool.file, parsed.end, verdict.ancestry, {
          objectFormat: objectFormatOf(parsed.caps),
          server: { cache: historyCache(historyDir, key), url: serverUrl({ user, host, port, rawPath }) },
        });
        if (r.error || r.bad.length) {
          spool.dispose();
          return reject(r.error ? verdict.ancestry.map((c) => ({ ref: c.ref, why: 'check', note: r.error }))
            : r.bad.map((c) => ({ ref: c.ref, why: 'force' })));
        }
        log(`GIT ${sandbox.name} push ${key} ${refs} (ssh, fast-forward checked${r.asked ? ', asked the server' : ''})`);
        const rs = fs.createReadStream(spool.file);
        rs.pipe(child.stdin, { end: false });
        rs.on('end', () => { spool.dispose(); socket.pipe(child.stdin); });
        return undefined;
      };
      const onPack = (d) => {
        spool.write(d);
        if (spool.size > MAX_PUSH_BODY) {
          socket.off('data', onPack);
          spool.dispose();
          log(`DENIED git ${sandbox.name} push ${key}: too large to check (ssh)`);
          child.kill('SIGTERM');
          return finish(1, 'vivary: push too large to check');
        }
        if (packEnd.feed(d)) decide();
        return undefined;
      };
      spool.write(buf);
      if (packEnd.feed(buf.subarray(parsed.end))) decide();
      else { socket.on('data', onPack); socket.resume(); }
      return true;
    };
    const onData = (d) => { buf = Buffer.concat([buf, d]); check(); };
    if (!check()) socket.on('data', onData);
    return true;
  };
}

export default {
  name: 'git',
  order: 52,
  needsBroker: (cfg) => gitPolicy(cfg).length > 0,
  // The gitconfig, into RAM: /etc/gitconfig includes it (image.dockerfile).
  runSecrets(ctx) {
    const policy = gitPolicy(ctx.cfg);
    if (!policy.length) return null;
    ctx.log?.(`==> git: ${policy.length} repo rule(s) through the Mac (no credential in the sandbox)`);
    return { gitconfig: sandboxGitconfig(policy) };
  },
  brokerRaw: makeHttpHandler(),
  brokerUpgrade: makeSshHandler(),
};
