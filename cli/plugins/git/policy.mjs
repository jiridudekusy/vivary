// Git proxy policy — pure, unit-tested. Which repositories a sandbox may
// reach and which refs it may push, and the bits of the git wire protocol the
// broker reads to enforce that (the ref-update commands at the start of a
// push).
//
// Config (`.vivary.json` — approval-gated — or a profile):
//   "git": [
//     { "repo": "github.com/jiridudekusy/findmy", "push": ["agent/*"] },
//     { "repo": "uucodebase.plus4u.net/<awid>/<name>", "push": [] },
//     { "repo": "github.com/acme/*", "account": "jdk-acme" }
//   ]
// - repo: host/path, `*` matches within one path segment. A repository no
//   entry names cannot even be fetched.
// - push: branch patterns (`agent/*`; `**` crosses `/`); a pattern starting
//   with `refs/` is a full ref (tags). Missing or [] = read-only.
// - transport: https | ssh — how the MAC reaches the host. Default https for
//   github.com/gitlab.com/bitbucket.org, ssh for anything else (uuCodebase
//   speaks only ssh).
// - account: the username asked of `git credential` (several GitHub logins).

export const HTTPS_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const HOST = /^[a-z0-9][a-z0-9.-]*$/;
const SEG = /^[A-Za-z0-9._~*-]+$/;

export function validateGitConfig(git, file) {
  if (!Array.isArray(git)) throw new Error(`${file}: 'git' must be an array of { repo, push?, transport?, account? }`);
  git.forEach((e, i) => {
    const at = `${file}: git[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(e)) {
      if (!['repo', 'push', 'transport', 'account'].includes(k)) throw new Error(`${at}: unknown key '${k}' (known: repo, push, transport, account)`);
    }
    const [host, ...segs] = String(e.repo || '').toLowerCase().split('/');
    if (!HOST.test(host) || !segs.length || segs.some((s) => !SEG.test(s) || s === '..' || s === '.')) {
      throw new Error(`${at}: 'repo' must be host/path, e.g. github.com/owner/name`);
    }
    if (e.push !== undefined && (!Array.isArray(e.push) || e.push.some((p) => typeof p !== 'string' || !/^[A-Za-z0-9._/*-]+$/.test(p)))) {
      throw new Error(`${at}: 'push' must be an array of branch patterns`);
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

export function refAllowed(entry, ref) {
  return (entry?.push || []).some((p) => globRe(p.startsWith('refs/') ? p : `refs/heads/${p}`).test(ref));
}

// Merge entries from several layers: the same repo twice = its push patterns joined.
export function mergePolicy(...lists) {
  const out = new Map();
  for (const e of lists.flat().filter(Boolean)) {
    const key = e.repo.toLowerCase();
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, ...e, push: [...new Set([...(prev.push || []), ...(e.push || [])])] } : { ...e });
  }
  return [...out.values()];
}

// --- the wire: pkt-lines ---------------------------------------------------------

// Read the command list a push starts with: pkt-lines up to the first flush.
// Returns { done: false } until the flush has arrived, then
// { done: true, commands: [{ old, new, ref }], end } (end = bytes consumed),
// or { error } for anything that is not a plain command list.
export function parsePushCommands(buf) {
  const commands = [];
  let caps = [];
  let off = 0;
  for (;;) {
    if (buf.length < off + 4) return { done: false };
    const len = parseInt(buf.toString('latin1', off, off + 4), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4)) return { error: 'malformed pkt-line' };
    if (len === 0) return { done: true, commands, caps, end: off + 4 };
    if (buf.length < off + len) return { done: false };
    let line = buf.toString('latin1', off + 4, off + len).replace(/\n$/, '');
    off += len;
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
