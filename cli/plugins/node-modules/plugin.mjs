// node-modules: per-sandbox node_modules overlays — Linux modules never mix
// with the host's macOS ones. Docker gets one bind mount per package dir (no
// mount limit); Apple `container` tops out at ~120 virtiofs shares, so it
// gets a single share plus in-VM bind mounts done by the bind-modules helper
// (driven by a manifest; modules-watch extends it live for new package.json
// files created inside the sandbox).
//
// The dir set is either discovered (depth N below the workspace root) or given
// explicitly as workspace-relative paths in .vivary.json.
import fs from 'node:fs';
import path from 'node:path';
import { die } from '../../core/util.mjs';
import { sandboxDir } from '../../core/sandbox.mjs';

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
      const state = path.join(modulesRoot, moduleSlug(rel));
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(state, { recursive: true });
      if (cfg.runtime === 'docker') args.push('-v', `${state}:${target}`);
      else manifest.push(`${moduleSlug(rel)}\t${target}`);
    }
    if (cfg.runtime !== 'docker') {
      fs.writeFileSync(path.join(modulesRoot, '.manifest'), manifest.join('\n') + '\n');
      args.push(
        '-v', `${modulesRoot}:/vivary-modules`,
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
};
