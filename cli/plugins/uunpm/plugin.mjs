// uunpm: route npm/npx through the Plus4U safe-install wrappers (uunpm/uunpx),
// which screen every package — including transitive deps — against the
// malicious-package list at https://docs.plus4u.net/unsafe_packages before
// letting an install or an npx execution proceed.
// Docs: uu-bookkit-maing01/0238a88bac124b3ca828835b57144ffa page 58494690
//
// The wrappers are baked into the image (see image.dockerfile); this plugin
// only decides whether npm/npx are ALIASED to them, via a PATH shim linked in
// by the 47-uunpm hook. No flag -> plain npm/npx, same as before.
import { capture, die } from '../../core/util.mjs';

// Only registry that carries the uu-safe-* family (anonymous read).
const REGISTRY = process.env.VIVARY_UUNPM_REGISTRY
  || 'https://repo.plus4u.net/repository/public-javascript/';

const PACKAGES = [
  'uu-safe-npm',            // provides uunpm
  'uu-safe-npx',            // provides uunpx + uu-safe-npx
  'uu-safe-install',        // uunpm install|i|add
  'uu-safe-clean-install',  // uunpm ci
  'uu-safe-update',         // uunpm update|upgrade
];

export function parseNpmVersion(text) {
  const v = String(text || '').trim().split('\n').pop().trim();
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

// Resolve every package's current version so the install layer busts exactly
// when one of them ships. A failed probe is NOT fatal — fall back to the bare
// name (npm resolves 'latest' itself); the build then just loses cache-busting
// precision, so say so instead of failing the whole build.
export function resolveSafeSpecs(packages = PACKAGES,
  view = (pkg) => capture('npm', ['view', pkg, 'version', '--registry', REGISTRY])) {
  const specs = [];
  const unresolved = [];
  for (const pkg of packages) {
    const r = view(pkg);
    const version = r.status === 0 ? parseNpmVersion(r.stdout) : null;
    if (version) specs.push(`${pkg}@${version}`);
    else { specs.push(pkg); unresolved.push(pkg); }
  }
  if (unresolved.length) {
    console.error(`WARNING: could not resolve versions from ${REGISTRY} for: ${unresolved.join(', ')} — `
      + 'building unpinned (a cached install layer may keep an older version)');
  }
  return specs.join(' ');
}

export default {
  name: 'uunpm',
  order: 47,   // after npmrc (45): strict mode appends to the ~/.npmrc it writes

  flags: {
    uunpm: {
      type: 'optional',
      sticky: true,
      cfgKey: 'uunpm',
      normalize(v) {
        if (v === true) return 'on';
        const s = String(v).trim().toLowerCase();
        if (s === '1' || s === 'on') return 'on';
        if (s === '0' || s === 'off') return false;
        if (s === 'alias') return 'alias';
        return die('--uunpm expects on|alias|off');
      },
      help: "Alias npm -> uunpm and npx -> uunpx inside the sandbox\n(sticky), so installs and npx runs are screened against the\nPlus4U malicious-package list, AND set ignore-scripts=true\nin the sandbox ~/.npmrc so install scripts cannot run behind\nthe wrappers' back. 'alias' skips the ignore-scripts part\n(escape hatch when a toolchain needs plain-npm scripts);\n'off' disables. uunpm/uunpx are always available by name.",
    },
  },

  buildArgs() {
    return { UUNPM_REGISTRY: REGISTRY, UU_SAFE_SPECS: resolveSafeSpecs() };
  },

  // The wrappers fail CLOSED on an unreachable docs.plus4u.net, so behind
  // deny-all egress the hole has to open together with the feature.
  egressPresets: (cfg) => (cfg.uunpm ? ['uunpm'] : []),

  runArgs({ cfg, log }) {
    if (!cfg.uunpm) return [];
    log(`==> uunpm: npm/npx routed through the uu-safe wrappers (mode '${cfg.uunpm}')`);
    return ['-e', `SANDBOX_UUNPM=${cfg.uunpm}`];
  },
};
