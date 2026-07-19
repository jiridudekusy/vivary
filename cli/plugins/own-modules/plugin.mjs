// own-modules: per-sandbox node_modules overlays — Linux modules never mix
// with the host's macOS ones. Docker gets one bind mount per package dir (no
// mount limit); Apple `container` tops out at ~120 virtiofs shares, so it
// gets a single share plus in-VM bind mounts done by the bind-modules helper
// (driven by a manifest; modules-watch extends it live for new package.json
// files created inside the sandbox).
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

export default {
  name: 'own-modules',
  order: 70,
  flags: {
    'own-modules': {
      type: 'optional',
      sticky: true,
      cfgKey: 'ownModules',
      normalize(v) {
        const depth = v === true ? 4 : Number(v);
        if (!Number.isInteger(depth) || depth < 0) {
          die('--own-modules expects a level, e.g. --own-modules=2');
        }
        return depth === 0 ? false : depth;
      },
      help: 'Keep node_modules container-side (sticky): every dir\nwith a package.json (scanned N levels deep, default 4)\ngets a per-sandbox overlay, so Linux modules never mix\nwith the host\'s macOS ones. New package.json files are\npicked up live. --own-modules=0 turns it off.',
    },
  },
  needsCaps: (cfg) => !!cfg.ownModules,

  runArgs({ cfg, log }) {
    const depth = Number(cfg.ownModules);
    if (!depth) return [];
    const modulesRoot = path.join(sandboxDir(cfg.name), 'modules');
    fs.mkdirSync(modulesRoot, { recursive: true });
    const pkgs = discoverPackageDirs(cfg.workspace, depth);
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
      );
    }
    log(`==> node_modules overlays: ${pkgs.length} package dir(s), depth ${depth}`);
    return args;
  },
};
