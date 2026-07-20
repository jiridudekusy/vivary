// npmrc: carry the user's ~/.npmrc into the sandbox — default/company
// registries and their credentials — with sandbox-safe transformations:
//
//   * localhost registries are rewritten to host.docker.internal (values AND
//     the //host/:_authToken auth keys, which npm matches by URL)
//   * cafile paths are copied into the sandbox state and rewritten
//   * ${ENV_VAR} references stay UNEXPANDED in the persisted file; the
//     referenced variables are injected as container env at start and the
//     entrypoint hook expands them into the container-local ~/.npmrc — so
//     env-provided tokens never land in the sandbox state on disk
//
// The import is re-derived from the host ~/.npmrc on every start (token
// rotation just works; in-container edits of ~/.npmrc don't survive).
//
// Flag values (sticky):
//   --npmrc              = all: the whole file
//   --npmrc=registries   registry/scope mappings and options, NO credentials
//   --npmrc=<t1,t2,...>  selective; tokens: default (default registry line
//                        + its auth), @scope (scoped registry + its auth),
//                        anything else = hostname fragment matching auth
//                        entries (e.g. nexus.cams, repo.plus4u.net)
//   --npmrc=off          disable
import fs from 'node:fs';
import path from 'node:path';
import { HOME, die } from '../../core/util.mjs';

const CRED_RE = /^\/\/.+:(_authToken|_auth|_password|username|email)$/;

function parseLine(raw) {
  const m = raw.match(/^\s*([^;#=][^=]*?)\s*=\s*(.*)\s*$/);
  return m ? { raw, key: m[1], value: m[2] } : { raw };
}

// npm "nerf-dart" of a registry URL: //host/path/ (auth keys are matched
// against this prefix, walking up path segments).
function nerf(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return `//${u.host}${p}`;
  } catch {
    return null;
  }
}

function credMatchesRegistry(credKey, registryUrl) {
  const n = nerf(registryUrl);
  if (!n) return false;
  const prefix = credKey.replace(/:(_authToken|_auth|_password|username|email)$/, '')
    .replace(/\/?$/, '/');
  return n.startsWith(prefix) || prefix.startsWith(n);
}

function rewriteLocalhost(s) {
  return s.replace(/(^|\/\/)(localhost|127\.0\.0\.1)(?=[:/])/g, '$1host.docker.internal');
}

// Filter + transform the npmrc content. Exported for tests.
export function transformNpmrc(text, selection, { caDir, caContainerPath } = {}) {
  const lines = text.split('\n').map(parseLine);
  const tokens = selection === 'all' || selection === 'registries'
    ? [] : selection.split(',').map((t) => t.trim()).filter(Boolean);
  const wantDefault = tokens.includes('default');
  const scopes = tokens.filter((t) => t.startsWith('@'));
  const hosts = tokens.filter((t) => t !== 'default' && !t.startsWith('@'));

  const defaultRegistry = lines.find((l) => l.key === 'registry')?.value;
  const scopeRegistry = (scope) => lines.find((l) => l.key === `${scope}:registry`)?.value;

  const keep = lines.filter((l) => {
    if (l.key === undefined) return true;             // comments/blank
    const isCred = CRED_RE.test(l.key);
    if (selection === 'all') return true;
    if (selection === 'registries') return !isCred;
    // selective mode
    if (l.key === 'registry') return wantDefault;
    if (l.key.endsWith(':registry')) return scopes.includes(l.key.slice(0, -':registry'.length));
    if (isCred) {
      if (hosts.some((h) => l.key.includes(h))) return true;
      if (wantDefault && defaultRegistry && credMatchesRegistry(l.key, defaultRegistry)) return true;
      return scopes.some((s) => {
        const reg = scopeRegistry(s);
        return reg && credMatchesRegistry(l.key, reg);
      });
    }
    return true;                                      // global options
  });

  const envRefs = new Set();
  const out = keep.map((l) => {
    let raw = rewriteLocalhost(l.raw);
    // cafile/certfile: copy the file into sandbox state, rewrite the path
    const cm = raw.match(/^\s*(cafile|certfile|keyfile)\s*=\s*(.+)\s*$/);
    if (cm && caDir) {
      const hostPath = cm[2].replace(/^~(?=\/)/, HOME);
      if (fs.existsSync(hostPath)) {
        const dest = path.join(caDir, `npm-${cm[1]}${path.extname(hostPath) || '.pem'}`);
        fs.copyFileSync(hostPath, dest);
        raw = `${cm[1]}=${caContainerPath}/${path.basename(dest)}`;
      } else {
        console.error(`WARNING: npmrc ${cm[1]} not found on host: ${cm[2]}`);
      }
    }
    for (const m of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) envRefs.add(m[1]);
    return raw;
  });

  return { content: out.join('\n'), envRefs: [...envRefs] };
}

export default {
  name: 'npmrc',
  order: 45,
  flags: {
    npmrc: {
      type: 'optional',
      sticky: true,
      cfgKey: 'npmrc',
      normalize(v) {
        if (v === true) return 'all';
        const s = String(v).trim();
        if (s === '0' || s === 'off') return false;
        if (!/^[@\w.,-]+$/.test(s)) die('--npmrc expects all|registries|off or a comma list of @scopes/hosts/default');
        return s;
      },
      help: "Carry the host ~/.npmrc into the sandbox (sticky), re-read\non every start. Values: bare = all; 'registries' = no\ncredentials; comma list = selective (default, @scope,\nhostname fragment — e.g. --npmrc=default,nexus.cams);\n'off' disables. localhost registries are rewritten to\nhost.docker.internal; ${VAR} tokens are injected via env,\nnever stored in sandbox state.",
    },
  },

  runArgs({ cfg, dir, log }) {
    if (!cfg.npmrc) return [];
    const hostNpmrc = path.join(HOME, '.npmrc');
    if (!fs.existsSync(hostNpmrc)) {
      console.error('WARNING: --npmrc enabled but host ~/.npmrc does not exist');
      return [];
    }
    const configDir = path.join(dir, 'dot-config');
    fs.mkdirSync(configDir, { recursive: true });
    const { content, envRefs } = transformNpmrc(
      fs.readFileSync(hostNpmrc, 'utf8'), cfg.npmrc,
      { caDir: configDir, caContainerPath: '/home/agent/.config' },
    );
    fs.writeFileSync(path.join(configDir, 'npmrc-import'), content, { mode: 0o600 });

    const args = ['-e', 'SANDBOX_NPMRC=1'];
    for (const name of envRefs) {
      if (process.env[name] !== undefined) args.push('-e', `${name}=${process.env[name]}`);
      else console.error(`WARNING: ~/.npmrc references \${${name}} but it is not set on the host`);
    }
    log(`==> npmrc import: mode '${cfg.npmrc}'${envRefs.length ? `, env refs: ${envRefs.join(', ')}` : ''}`);
    return args;
  },
};
