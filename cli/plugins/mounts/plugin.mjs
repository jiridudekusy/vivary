// mounts: extra host paths inside the sandbox, docker-style.
//
//   vivary up -v ~/data:/data -v ~/models:ro      (repeatable, sticky)
//   .vivary.json: { "flags": { "volume": ["~/data:/data:ro"] } }
//
// A bare host path mounts at the SAME absolute path in the sandbox, which is
// vivary's standing invariant for the workspace (tool paths keep working, and
// Claude's history slug derives from cwd). The RunSpec carries mounts
// structurally, so all three runtimes are covered: docker/Apple `container`
// render -v, tart renders --dir= plus an in-guest mount_virtiofs.
//
// SECURITY. A mount is direct host filesystem access, and .vivary.json is
// agent-writable, so the two sources are NOT equally trusted:
//   * ~/.vivary is refused outright, from either source — it holds every
//     sandbox's broker token (impersonate another sandbox at the broker) and
//     the approved-config baseline (self-approve future .vivary.json changes).
//     Mounting it would dismantle the approval gate that protects everything
//     else here.
//   * from .vivary.json, a deny-list of credential stores and system dirs is
//     refused as well: the human does see a diff and type [y/N], but a plausible
//     line in a long config is a poor last line of defence.
//   * from the CLI a human typed the path, so anything else is allowed — with a
//     loud warning when the path is an ancestor of ~/.vivary (mounting $HOME
//     re-exposes it through the back door).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, SANDBOXES_DIR, die } from '../../core/util.mjs';

// Credential stores and system trees that .vivary.json may not reach for.
// Relative entries resolve against $HOME.
export const FILE_DENY_LIST = [
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config/gh', '.config/gcloud',
  '.npmrc', 'Library/Keychains', 'Library/Application Support/com.apple.TCC',
  '/etc', '/var', '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc',
];

const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

// True when `p` is `base` or lives inside it.
export function isInside(p, base) {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Parse one mount spec. Accepted:
//   HOST                 -> same absolute path inside the sandbox
//   HOST:ro              -> same path, read-only
//   HOST:GUEST[:ro|rw]
// HOST may use ~ or be relative to cwd; GUEST must be absolute (the sandbox
// has no meaningful cwd at mount time). Throws; callers turn it into a die.
export function parseMount(spec, { home = HOME, cwd = process.cwd() } = {}) {
  const parts = String(spec).trim().split(':');
  if (parts.some((p) => p === '') || parts.length > 3) {
    throw new Error(`--volume '${spec}': expected HOST[:GUEST][:ro]`);
  }
  const host = path.resolve(cwd, expandHome(parts[0], home));
  let guest = host;
  let ro = false;
  if (parts.length === 2 && /^(ro|rw)$/.test(parts[1])) {
    ro = parts[1] === 'ro';
  } else if (parts.length >= 2) {
    guest = parts[1];
    if (parts.length === 3) {
      if (!/^(ro|rw)$/.test(parts[2])) {
        throw new Error(`--volume '${spec}': mode '${parts[2]}' must be ro or rw`);
      }
      ro = parts[2] === 'ro';
    }
  }
  if (!path.isAbsolute(guest)) {
    throw new Error(`--volume '${spec}': sandbox path '${guest}' must be absolute`);
  }
  return { host, guest, ro };
}

// Policy check for a parsed mount. Returns an error string (refuse) or null.
export function mountDenyReason(host, { origin = 'cli', home = HOME, stateDir = SANDBOXES_DIR } = {}) {
  if (isInside(host, stateDir)) {
    return `refusing to mount '${host}': ${stateDir} holds broker tokens and the `
      + 'approved-config baseline for every sandbox';
  }
  if (origin !== 'file') return null;
  for (const entry of FILE_DENY_LIST) {
    const denied = path.isAbsolute(entry) ? entry : path.join(home, entry);
    if (isInside(host, denied)) {
      return `refusing to mount '${host}' from .vivary.json: '${entry}' is on the deny-list `
        + 'for config-file mounts (pass it on the command line if you really mean it)';
    }
  }
  return null;
}

// Non-fatal note: a CLI mount that CONTAINS the vivary state dir (e.g. $HOME)
// exposes it indirectly. Refusing $HOME outright would be overreach — the human
// typed it — but it must not pass silently.
export function mountWarning(host, { stateDir = SANDBOXES_DIR } = {}) {
  return isInside(stateDir, host) && host !== stateDir
    ? `WARNING: mount '${host}' contains ${stateDir} — the sandbox can read every sandbox's broker token`
    : null;
}

export function mountList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((s) => String(s).trim()).filter(Boolean);
}

// Parse + policy-check + verify existence. Returns [{host, guest, ro}].
export function resolveMounts(specs, { origin = 'cli', home = HOME, cwd = process.cwd(),
  stateDir = SANDBOXES_DIR, exists = fs.existsSync } = {}) {
  return mountList(specs).map((spec) => {
    const m = parseMount(spec, { home, cwd });
    const denied = mountDenyReason(m.host, { origin, home, stateDir });
    if (denied) throw new Error(denied);
    if (!exists(m.host)) throw new Error(`--volume '${spec}': host path '${m.host}' does not exist`);
    return m;
  });
}

export default {
  name: 'mounts',
  order: 26,
  flags: {
    volume: {
      type: 'list',
      short: 'v',
      sticky: true,
      cfgKey: 'volumes',
      normalize(v, { origin } = {}) {
        const specs = mountList(v);
        try {
          // Validate (and policy-check for this origin) at the point the value
          // enters the config, so a bad or forbidden mount never reaches a run.
          // The non-fatal warning is emitted once per run from runArgs instead —
          // normalize runs several times per invocation.
          resolveMounts(specs, { origin });
        } catch (e) {
          die(e.message);
        }
        return specs.length ? specs : false;
      },
      help: 'Mount a host path into the sandbox (sticky, repeatable),\n'
        + 'docker syntax: -v ~/data:/data, -v ~/data:/data:ro.\n'
        + 'A bare path mounts at the SAME absolute path inside\n'
        + '(-v ~/models, -v ~/models:ro). Works on all runtimes.\n'
        + 'Mounts from .vivary.json are deny-listed for credential\n'
        + 'stores and system dirs (it is agent-writable); ~/.vivary\n'
        + 'is never mountable.',
    },
  },

  runArgs({ cfg, log }) {
    const specs = mountList(cfg.volumes);
    if (!specs.length) return [];
    const args = [];
    try {
      // origin 'cli' here on purpose: the file deny-list was already applied
      // when the value entered the config (normalize knows the real origin), so
      // this pass only re-checks what always holds — shape, ~/.vivary, existence.
      for (const m of resolveMounts(specs, { origin: 'cli' })) {
        args.push('-v', `${m.host}:${m.guest}${m.ro ? ':ro' : ''}`);
        log(`==> mount: ${m.host} -> ${m.guest}${m.ro ? ' (ro)' : ''}`);
        const warn = mountWarning(m.host);
        if (warn) console.error(warn);
      }
    } catch (e) {
      die(e.message);
    }
    return args;
  },

  // tart: the same mounts, structurally — the provider turns them into
  // --dir=<host>:[ro,]tag=wsN and mounts each tag in the guest after boot.
  vmContribute({ cfg, log }) {
    const specs = mountList(cfg.volumes);
    if (!specs.length) return {};
    let mounts;
    try {
      mounts = resolveMounts(specs, { origin: 'cli' });
    } catch (e) {
      die(e.message);
    }
    for (const m of mounts) {
      log(`==> mount: ${m.host} -> ${m.guest}${m.ro ? ' (ro)' : ''}`);
      const warn = mountWarning(m.host);
      if (warn) console.error(warn);
    }
    return { mounts };
  },
};
