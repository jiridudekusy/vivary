// node-modules: per-sandbox node_modules overlays — Linux modules never mix
// with the host's macOS ones. Docker gets one bind mount per package dir (no
// mount limit); Apple `container` gets in-VM bind mounts done by the
// bind-modules helper (driven by a manifest; modules-watch extends it live for
// new package.json files created inside the sandbox).
//
// On Apple `container` the overlays live on a per-sandbox VOLUME
// (`vivary-<name>-modules`, an ext4 disk image), not on the Mac. They used to
// sit in ~/.vivary/<name>/modules behind the virtiofs share, because a
// container was thrown away on every exit before containers persisted. But
// virtiofs keeps a host file open for every file the guest has cached, and
// node_modules are the biggest trees there are: measured on an 85k-file tree,
// the share pinned +82 671 host files, the volume +1 — and the volume wrote it
// 65x faster and walked it cold 700x faster. A volume is separate from the
// container, so it survives --recreate; `rm --purge` deletes it. The host
// share stays mounted for the manifest (the host rewrites it every start) and
// as the source of the one-time migration of what was stored there before.
//
// The dir set is either discovered (depth N below the workspace root) or given
// explicitly as workspace-relative paths in .vivary.json.
import fs from 'node:fs';
import path from 'node:path';
import { capture, die } from '../../core/util.mjs';
import { sandboxDir } from '../../core/sandbox.mjs';

// The store volume. Sparse: an empty 256G image costs ~34 MB on the Mac, and it
// grows only with what is written (bind-modules fstrims it at every start, so
// deleted modules are handed back). Volume names share the sandbox-name
// alphabet ([a-z0-9-]).
export const modulesVolume = (name) => `vivary-${name}-modules`;
export const STORE_SIZE = '256G';
export const STORE_MOUNT = '/vivary-modules-store';
const usesStoreVolume = (cfg) => !!cfg.nodeModules && cfg.runtime === 'container';

function ensureStoreVolume(name, run = capture) {
  const vol = modulesVolume(name);
  if (run('container', ['volume', 'inspect', vol]).status === 0) return vol;
  const r = run('container', ['volume', 'create', '-s', STORE_SIZE, vol]);
  if (r.status !== 0) die(`node-modules: cannot create volume ${vol}: ${(r.stderr || r.stdout).trim()}`);
  return vol;
}

// Find workspace dirs containing package.json — candidates for an overlay.
// No symlink following (a workspace symlink must not lead us to create dirs
// outside the workspace); depth = directory levels below the workspace root.
function discoverPackageDirs(root, maxDepth, cap = 500) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && found.length < cap) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      found.push(path.relative(root, dir) || '.');
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue; // isDirectory() is false for symlinks
      if (['node_modules', '.git', '.hg'].includes(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

const moduleSlug = (rel) => (rel === '.' ? 'root' : rel.replace(/[^a-zA-Z0-9._-]/g, '-'));

// Normalize an explicit list of workspace-relative dirs. The list comes from
// .vivary.json, which the agent can write, so every entry must provably stay
// inside the workspace: relative only, no '..' escape, and no symlinked
// component (a symlink would let a dir outside the workspace receive an
// overlay). Existence is required too — a typo must not silently do nothing.
// Throws (pure, unit-tested); the flag/normalize path turns it into a die.
export function normalizeModuleDirs(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const entry = String(raw).trim();
    if (!entry) throw new Error("node-modules: empty path in the list (use '.' for the workspace root)");
    if (path.isAbsolute(entry)) {
      throw new Error(`node-modules: '${entry}' must be workspace-relative, not absolute`);
    }
    // normalize keeps a trailing separator ('a/b/' -> 'a/b/'), which would
    // produce a second slug for the same dir — strip it.
    const rel = path.normalize(entry).replace(new RegExp(`${path.sep}+$`), '');
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
      throw new Error(`node-modules: '${entry}' escapes the workspace`);
    }
    const key = rel === '' ? '.' : rel;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// Resolve the configured dirs against a real workspace, failing loudly on
// anything that is not a plain existing directory inside it.
export function resolveModuleDirs(workspace, dirs, stat = fs.lstatSync) {
  for (const rel of dirs) {
    let st;
    try {
      st = stat(path.join(workspace, rel));
    } catch {
      throw new Error(`node-modules: '${rel}' does not exist in ${workspace}`);
    }
    if (st.isSymbolicLink()) throw new Error(`node-modules: '${rel}' is a symlink — refusing to overlay it`);
    if (!st.isDirectory()) throw new Error(`node-modules: '${rel}' is not a directory`);
  }
  return dirs;
}

export default {
  name: 'node-modules',
  order: 70,
  flags: {
    'node-modules': {
      type: 'optional',
      // .vivary.json may give an explicit array of workspace-relative dirs
      // instead of a scan depth (CLI keeps --node-modules[=N]).
      list: true,
      sticky: true,
      cfgKey: 'nodeModules',
      normalize(v) {
        if (Array.isArray(v)) {
          let dirs;
          try {
            dirs = normalizeModuleDirs(v);
          } catch (e) {
            die(e.message);
          }
          return dirs.length ? dirs : false;
        }
        const depth = v === true ? 4 : Number(v);
        if (!Number.isInteger(depth) || depth < 0) {
          die('--node-modules expects a level, e.g. --node-modules=2');
        }
        return depth === 0 ? false : depth;
      },
      help: 'Keep node_modules container-side (sticky): every dir\nwith a package.json (scanned N levels deep, default 4)\ngets a per-sandbox overlay, so Linux modules never mix\nwith the host\'s macOS ones. New package.json files are\npicked up live. --node-modules=0 turns it off. In\n.vivary.json the value may instead be an array of\nworkspace-relative dirs (exact list, no scanning).',
    },
  },
  needsCaps: (cfg) => !!cfg.nodeModules,

  runArgs({ cfg, log }) {
    if (!cfg.nodeModules) return [];
    const explicit = Array.isArray(cfg.nodeModules);
    const depth = explicit ? 0 : Number(cfg.nodeModules);
    if (!explicit && !depth) return [];
    const modulesRoot = path.join(sandboxDir(cfg.name), 'modules');
    fs.mkdirSync(modulesRoot, { recursive: true });
    let pkgs;
    try {
      pkgs = explicit
        ? resolveModuleDirs(cfg.workspace, normalizeModuleDirs(cfg.nodeModules))
        : discoverPackageDirs(cfg.workspace, depth);
    } catch (e) {
      die(e.message); // an unapproved/typo'd dir list must not start silently
    }
    const args = [];
    const manifest = [];
    for (const rel of pkgs) {
      const target = path.join(cfg.workspace, rel, 'node_modules');
      fs.mkdirSync(target, { recursive: true });
      if (cfg.runtime === 'docker') {
        const state = path.join(modulesRoot, moduleSlug(rel));
        fs.mkdirSync(state, { recursive: true });
        args.push('-v', `${state}:${target}`);
      } else {
        manifest.push(`${moduleSlug(rel)}\t${target}`);
      }
    }
    if (cfg.runtime !== 'docker') {
      fs.writeFileSync(path.join(modulesRoot, '.manifest'), manifest.join('\n') + '\n');
      args.push(
        '-v', `${modulesRoot}:/vivary-modules`,
        '-v', `${ensureStoreVolume(cfg.name)}:${STORE_MOUNT}`,
        '-e', 'SANDBOX_MODULES=1',
        '-e', `SANDBOX_MODULES_DEPTH=${depth}`,
        '-e', `SANDBOX_WORKSPACE=${cfg.workspace}`,
        // An explicit list is exactly that list: no live pickup of new
        // package.json files (the watcher would extend the manifest).
        '-e', `SANDBOX_MODULES_WATCH=${explicit ? 0 : 1}`,
      );
    }
    log(`==> node_modules overlays: ${pkgs.length} dir(s), ${explicit ? 'explicit list' : `depth ${depth}`}`);
    return args;
  },

  // The store volume is baked in at creation. A kept container from before the
  // switch has no such key in its snapshot, so it is refused with the
  // --recreate hint rather than restarted with node_modules still on the Mac.
  containerSnapshot: (cfg) => (usesStoreVolume(cfg) ? { nodeModulesStore: 'volume' } : {}),

  // Wait until bind-modules has put the overlays in place. Without this an
  // agent exec'd right after start could run `npm install` into the Mac's own
  // node_modules — the exact mix the overlays exist to prevent. The window is
  // usually under a second, but the one-time migration off the host share can
  // take minutes. bind-modules marks completion with the VM's boot_id, so a
  // marker left by the previous boot of a kept container never counts.
  async postUp({ cfg, cname }) {
    if (!usesStoreVolume(cfg)) return;
    const probe = 'grep -q vivary-modules.ready /usr/local/bin/bind-modules || exit 3; '
      + '[ "$(cat /run/vivary-modules.ready 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id)" ]';
    const started = Date.now();
    let told = false;
    for (;;) {
      const { status } = capture('container', ['exec', cname, 'sh', '-c', probe], { timeout: 15000 });
      if (status === 0 || status === 3) return; // ready, or an image without the marker
      const waited = Date.now() - started;
      if (!told && waited > 2000) {
        console.log('==> node_modules: waiting for the overlays (the first start after the move\n'
          + '    copies them off the Mac onto the sandbox volume — one-time, can take minutes)');
        told = true;
      }
      if (waited > 30 * 60 * 1000) {
        console.error(`WARNING: node_modules overlays not ready after 30 min — see: container logs ${cname}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  },

  // Deleting the sandbox deletes its modules. Runs after the container is gone
  // (a volume cannot be removed while attached); no volume is fine.
  onPurge(name) {
    const vol = modulesVolume(name);
    if (capture('container', ['volume', 'inspect', vol]).status !== 0) return;
    const r = capture('container', ['volume', 'rm', vol]);
    if (r.status === 0) console.log(`==> node_modules volume ${vol} deleted.`);
    else console.error(`WARNING: could not delete volume ${vol}: ${(r.stderr || r.stdout).trim()}`);
  },
};
