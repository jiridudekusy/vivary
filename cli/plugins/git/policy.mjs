// Git proxy policy — pure, unit-tested. Which repositories a sandbox may
// reach and which refs it may push, and the bits of the git wire protocol the
// broker reads to enforce that (the ref-update commands at the start of a
// push).
//
// Config (`.vivary.json` — approval-gated — or a profile):
//   "git": [
//     { "repo": "github.com/jiridudekusy/findmy", "push": ["agent/**"],
//       "force": ["agent/scratch/*"], "delete": ["agent/scratch/*"] },
//     { "repo": "uucodebase.plus4u.net/<awid>/<name>", "push": [] },
//     { "repo": "github.com/acme/*", "account": "jdk-acme" }
//   ]
// - repo: host/path, `*` matches within one path segment. A repository no
//   entry names cannot even be fetched.
// - push: branch patterns (`agent/*`; `**` crosses `/`); a pattern starting
//   with `refs/` is a full ref (tags). Missing or [] = read-only. A ref in
//   push may be created and moved FORWARD only (fast-forward).
// - force: refs (same patterns, and only those also in push) that may also be
//   rewritten — a push that is not a fast-forward. Moving a tag counts.
// - delete: refs (likewise) that may also be deleted.
// - transport: https | ssh — how the MAC reaches the host. Default https for
//   github.com/gitlab.com/bitbucket.org, ssh for anything else (uuCodebase
//   speaks only ssh).
// - account: the username asked of `git credential` (several GitHub logins).
import { createHash } from 'node:crypto';

export const HTTPS_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const HOST = /^[a-z0-9][a-z0-9.-]*$/;
const SEG = /^[A-Za-z0-9._~*-]+$/;
const REF_LISTS = ['push', 'force', 'delete'];
const KEYS = ['repo', ...REF_LISTS, 'transport', 'account'];

export function validateGitConfig(git, file) {
  if (!Array.isArray(git)) throw new Error(`${file}: 'git' must be an array of { repo, push?, force?, delete?, transport?, account? }`);
  git.forEach((e, i) => {
    const at = `${file}: git[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(e)) {
      if (!KEYS.includes(k)) throw new Error(`${at}: unknown key '${k}' (known: ${KEYS.join(', ')})`);
    }
    const [host, ...segs] = String(e.repo || '').toLowerCase().split('/');
    if (!HOST.test(host) || !segs.length || segs.some((s) => !SEG.test(s) || s === '..' || s === '.')) {
      throw new Error(`${at}: 'repo' must be host/path, e.g. github.com/owner/name`);
    }
    for (const k of REF_LISTS) {
      if (e[k] !== undefined && (!Array.isArray(e[k]) || e[k].some((p) => typeof p !== 'string' || !/^[A-Za-z0-9._/*-]+$/.test(p)))) {
        throw new Error(`${at}: '${k}' must be an array of branch patterns`);
      }
    }
    if (e.transport !== undefined && !['https', 'ssh'].includes(e.transport)) throw new Error(`${at}: 'transport' is https or ssh`);
    if (e.account !== undefined && !/^[A-Za-z0-9._@-]{1,64}$/.test(String(e.account))) throw new Error(`${at}: bad 'account'`);
  });
  return git;
}

export const transportFor = (entry) => entry.transport || (HTTPS_HOSTS.has(entry.repo.split('/')[0].toLowerCase()) ? 'https' : 'ssh');

// host + a path as git hands it over ('/awid/x.git', 'owner/x.git', '~u/x')
// -> 'host/awid/x'. Null for anything that is not a plain repository path.
export function repoKey(host, rawPath) {
  const h = String(host || '').toLowerCase();
  const p = String(rawPath || '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!HOST.test(h) || !p) return null;
  const segs = p.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || !/^[A-Za-z0-9._~-]+$/.test(s))) return null;
  return `${h}/${segs.join('/')}`;
}

const globRe = (pattern) => new RegExp(`^${pattern.split(/(\*\*|\*)/).map((part) => {
  if (part === '**') return '.*';
  if (part === '*') return '[^/]*';
  return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}).join('')}$`);

// The entry that covers a repository (exact names first), or null.
export function findEntry(policy, key) {
  if (!key) return null;
  const k = key.toLowerCase();
  const hits = policy.filter((e) => globRe(e.repo.toLowerCase()).test(k));
  return hits.find((e) => !e.repo.includes('*')) || hits[0] || null;
}

const refMatches = (patterns, ref) => (patterns || []).some((p) => globRe(p.startsWith('refs/') ? p : `refs/heads/${p}`).test(ref));
export const refAllowed = (entry, ref) => refMatches(entry?.push, ref);

export const isZeroOid = (oid) => /^0+$/.test(oid);

// What a push may do, ref by ref: { denied: [{ ref, why: push|delete }],
// ancestry: [commands that must prove to be fast-forwards] }. A create
// (old = zeros) needs push; a delete (new = zeros) also needs delete; an
// update also needs force unless it turns out to be a fast-forward.
export function judgePush(entry, commands) {
  const denied = [];
  const ancestry = [];
  for (const c of commands) {
    if (!refAllowed(entry, c.ref)) denied.push({ ref: c.ref, why: 'push' });
    else if (isZeroOid(c.new)) { if (!refMatches(entry.delete, c.ref)) denied.push({ ref: c.ref, why: 'delete' }); }
    else if (!isZeroOid(c.old) && !refMatches(entry.force, c.ref)) ancestry.push(c);
  }
  return { denied, ancestry };
}

export function denialText(denied) {
  const of = (why) => denied.filter((d) => d.why === why).map((d) => d.ref).join(', ');
  return [of('push') && `push to ${of('push')} is not allowed for this sandbox`,
    of('delete') && `deleting ${of('delete')} is not allowed for this sandbox`,
    of('force') && `${of('force')}: not a fast-forward, and force push is not allowed for this sandbox`,
    of('check') && `${of('check')}: could not be checked as a fast-forward — ${denied.find((d) => d.why === 'check').note}`,
  ].filter(Boolean).map((t) => `vivary: ${t}`).join('; ');
}

// Merge entries from several layers: the same repo twice = its ref lists joined.
export function mergePolicy(...lists) {
  const out = new Map();
  for (const e of lists.flat().filter(Boolean)) {
    const key = e.repo.toLowerCase();
    const prev = out.get(key);
    if (!prev) { out.set(key, { ...e }); continue; }
    const merged = { ...prev, ...e };
    for (const k of REF_LISTS) {
      if (prev[k] || e[k]) merged[k] = [...new Set([...(prev[k] || []), ...(e[k] || [])])];
    }
    out.set(key, merged);
  }
  return [...out.values()];
}

// --- the wire: pkt-lines ---------------------------------------------------------

// Read the command list a push starts with: pkt-lines up to the first flush
// (and, when the client announced push-options, the option list up to the
// next one). Returns { done: false } until all of that has arrived, then
// { done: true, commands: [{ old, new, ref }], caps, end } (end = bytes
// consumed, i.e. where the pack starts), or { error } for anything that is not
// a plain command list.
export function parsePushCommands(buf) {
  const commands = [];
  let caps = [];
  let off = 0;
  let options = null; // null = still reading commands
  for (;;) {
    if (buf.length < off + 4) return { done: false };
    const len = parseInt(buf.toString('latin1', off, off + 4), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4)) return { error: 'malformed pkt-line' };
    if (len === 0) {
      off += 4;
      if (options === null && commands.length && caps.includes('push-options')) { options = []; continue; }
      return { done: true, commands, caps, end: off };
    }
    if (buf.length < off + len) return { done: false };
    let line = buf.toString('latin1', off + 4, off + len).replace(/\n$/, '');
    off += len;
    if (options !== null) { options.push(line); continue; }
    const [head, capList] = line.split('\0');
    if (capList !== undefined && !commands.length) caps = capList.trim().split(/\s+/).filter(Boolean);
    line = head;
    if (line.startsWith('shallow ')) continue;
    if (line.startsWith('push-cert')) return { error: 'signed pushes are not supported through the proxy' };
    const m = line.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (refs\/\S+)$/);
    if (!m) return { error: `unexpected push command: ${line.slice(0, 80)}` };
    commands.push({ old: m[1], new: m[2], ref: m[3] });
  }
}

export const objectFormatOf = (caps) => (caps || []).find((c) => c.startsWith('object-format='))?.slice(14) || 'sha1';

export const pkt = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};
export const FLUSH = Buffer.from('0000');

// A receive-pack result that rejects every ref with a reason — what git shows
// as "! [remote rejected] main -> main (vivary: ...)". `sideband` when the
// client asked for side-band(-64k): the report then rides channel 1.
export function rejectReport(commands, reason, { sideband = false } = {}) {
  const report = Buffer.concat([pkt('unpack ok\n'),
    ...commands.map((c) => pkt(`ng ${c.ref} ${reason}\n`)), FLUSH]);
  if (!sideband) return report;
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), FLUSH]);
}

// --- proving a fast-forward from the push alone ------------------------------------
//
// The broker sees, per ref, "from <old> to <new>" and the pack of every object
// the server does not have yet. A pack carries no object names: index-pack
// computes each one from its content, so a commit found under <new> really
// has the parents it lists. Walking those parents inside the pack and meeting
// <old> proves a fast-forward. <old> itself is safe to take from the client:
// the server applies the update only if the ref still IS <old>.
// The catch is a THIN pack, whose deltas may lean on objects only the server
// has — so the broker adds `no-thin` to receive-pack's advertisement, and a
// client MUST NOT send a thin pack then (gitprotocol-capabilities).

// A streaming filter for a ref advertisement that appends `cap` to the
// capabilities of its first ref line. feed(chunk) -> bytes to pass on (may be
// empty while it waits for that line); end() -> whatever is left.
export function capabilityInjector(cap) {
  let buf = Buffer.alloc(0);
  let done = false;
  const release = () => { done = true; const b = buf; buf = Buffer.alloc(0); return b; };
  return {
    feed(chunk) {
      if (done) return chunk;
      buf = Buffer.concat([buf, chunk]);
      for (let off = 0; ;) {
        if (buf.length < off + 4) break;
        const len = parseInt(buf.toString('latin1', off, off + 4), 16);
        if (Number.isNaN(len)) return release(); // not pkt-lines: leave it alone
        if (len < 4) { off += 4; continue; } // flush / delim
        if (buf.length < off + len) break;
        const payload = buf.subarray(off + 4, off + len);
        const nul = payload.indexOf(0);
        if (nul >= 0) {
          const text = payload.subarray(nul + 1).toString('latin1');
          const nl = text.endsWith('\n') ? '\n' : '';
          const list = text.replace(/\n$/, '').split(' ').filter(Boolean);
          if (!list.includes(cap)) list.push(cap);
          const line = pkt(Buffer.concat([payload.subarray(0, nul + 1), Buffer.from(`${list.join(' ')}${nl}`, 'latin1')]));
          const out = Buffer.concat([buf.subarray(0, off), line, buf.subarray(off + len)]);
          done = true;
          buf = Buffer.alloc(0);
          return out;
        }
        off += len;
      }
      return buf.length > 1 << 16 ? release() : Buffer.alloc(0);
    },
    end: () => (done ? Buffer.alloc(0) : release()),
  };
}

// Has a pack fully arrived? A pack ends with the hash of all its bytes before
// it, so feed the stream (from the pack's first byte) and this says true once
// the last 20 (sha1) / 32 (sha256) bytes are that hash.
export class PackEnd {
  constructor(objectFormat = 'sha1') {
    this.n = objectFormat === 'sha256' ? 32 : 20;
    this.hash = createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1');
    this.tail = Buffer.alloc(0);
    this.total = 0;
  }

  feed(chunk) {
    const all = Buffer.concat([this.tail, chunk]);
    const keep = Math.min(all.length, this.n);
    this.hash.update(all.subarray(0, all.length - keep));
    this.tail = all.subarray(all.length - keep);
    this.total += chunk.length;
    return this.total >= 12 + this.n && this.hash.copy().digest().equals(this.tail);
  }
}

// `git cat-file --batch` output of commits -> Map(oid -> [parent oids]).
export function parseBatchCommits(buf) {
  const parents = new Map();
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const [oid, type, size] = buf.toString('latin1', off, nl).split(' ');
    off = nl + 1;
    if (type === undefined || size === undefined) continue; // "<oid> missing"
    const body = buf.toString('latin1', off, off + Number(size));
    off += Number(size) + 1;
    if (type !== 'commit') continue;
    const header = body.slice(0, body.indexOf('\n\n') < 0 ? body.length : body.indexOf('\n\n'));
    parents.set(oid, header.split('\n').filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)));
  }
  return parents;
}

// Does `from` reach `to` through commits in `parents` (the pushed pack)?
export function reaches(parents, from, to) {
  const seen = new Set();
  const todo = [from];
  while (todo.length) {
    const c = todo.pop();
    if (c === to) return true;
    if (seen.has(c) || !parents.has(c)) continue;
    seen.add(c);
    todo.push(...parents.get(c));
  }
  return false;
}
