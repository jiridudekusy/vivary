// Managing one sandbox from the web: how to connect, its settings, and the
// project-file approval. Everything that CHANGES something runs as a vivary
// child process (`vivary set`, `vivary approve`, `vivary up/down`), behind a
// passkey step-up bound to the exact request (server.mjs); this module only
// reads and shapes.
//
// Not offered, on purpose: the workspace, --volume and --publish (raw access
// to the Mac's disk and network), and anything the project .vivary.json sets
// (it sits above the sandbox's own layer; `vivary set` refuses those).
import fs from 'node:fs';
import path from 'node:path';
import { configHash, parseConfig, unifiedDiff } from '../../core/config.mjs';
import { sandboxDir } from '../../core/sandbox.mjs';
import { resolveRuntime } from '../../core/runtimes/index.mjs';
import { HttpError } from './auth.mjs';

const PROJECT_FILE = '.vivary.json';
const APPROVED_COPY = 'vivary-approved.json';
const MAX_PROJECT_BYTES = 256 * 1024;

// The workspace's .vivary.json, read the way an agent-writable file must be:
// never through a symlink (an agent could point it at ~/.ssh/id_ed25519 and
// have the diff show the key in the browser), regular files only, bounded.
export function readProjectFile(workspace) {
  const file = path.join(workspace, PROJECT_FILE);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') return { file, error: `${PROJECT_FILE} is a symlink — vivary does not follow it` };
    return { file, error: `cannot read ${PROJECT_FILE}: ${e.code || e.message}` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { file, error: `${PROJECT_FILE} is not a regular file` };
    if (st.size > MAX_PROJECT_BYTES) return { file, error: `${PROJECT_FILE} is larger than ${MAX_PROJECT_BYTES / 1024} KB` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return { file, raw: buf.subarray(0, off).toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

// What waits for approval: null when nothing does (no file, or approved as
// is). `validate` parses with the plugin flag set when it is available.
export function pendingApproval(cfg, { validate } = {}) {
  if (!cfg?.workspace) return null;
  const cur = readProjectFile(cfg.workspace);
  if (!cur) return null;
  if (cur.error) return { file: cur.file, error: cur.error };
  const sha = configHash(cur.raw);
  if (sha === cfg.configApproved) return null;
  let prev = '';
  try { prev = fs.readFileSync(path.join(sandboxDir(cfg.name), APPROVED_COPY), 'utf8'); } catch { /* none yet */ }
  let invalid = null;
  try { validate?.(cur.raw, cur.file); } catch (e) { invalid = e.message; }
  return {
    file: cur.file, sha, first: !prev, invalid,
    diff: unifiedDiff(prev, cur.raw, prev ? 'approved' : '(none approved yet)', cur.file),
  };
}

export function projectValidator(defs) {
  return defs ? (raw, file) => parseConfig(raw, { scope: 'project', file, knownFlags: defs }) : undefined;
}

// How to get in, from a device on the tailnet and from this Mac. A device
// key (vivary key add) opens every sandbox, so a phone or laptop needs only
// the address; the ssh_config block gives IDEs an alias to point at.
export function connectDetails(cfg, fqdn, { paseoUrl = null } = {}) {
  const alias = resolveRuntime(cfg.runtime).instanceName(cfg.name);
  const ws = encodeURI(cfg.workspace);
  const ide = (host) => ({
    cursor: `cursor://vscode-remote/ssh-remote+${host}${ws}`,
    vscode: `vscode://vscode-remote/ssh-remote+${host}${ws}`,
  });
  const out = {
    mac: { ssh: `ssh ${alias}`, ide: ide(alias) },
    tailnet: null,
    hint: null,
    paseo: paseoUrl ? { url: paseoUrl, passwordFile: `~/.vivary/${cfg.name}/dot-paseo/.vivary-password` } : null,
  };
  if (!cfg.tailscale) {
    out.hint = 'Reachable from this Mac only — turn on Tailscale in the settings below to reach it from other devices.';
  } else if (!fqdn) {
    out.hint = 'Tailscale is not reporting this Mac\'s name — is it running?';
  } else if (!cfg.tsSshPort) {
    out.hint = 'No tailnet SSH port yet — start the sandbox once.';
  } else {
    const host = `vivary-${cfg.name}`;
    out.tailnet = {
      ssh: `ssh -p ${cfg.tsSshPort} agent@${fqdn}`,
      sshConfig: `Host ${host}\n  HostName ${fqdn}\n  Port ${cfg.tsSshPort}\n  User agent\n`,
      ide: ide(host),
    };
  }
  return out;
}

// A settings change from the page -> `vivary set` argv. Only the shapes the
// page sends; the CLI checks the rest (layers, profile names, flag types).
const FORBIDDEN = new Set(['publish', 'volume', 'workspace', 'runtime', 'agent', 'name', 'json', 'recreate', 'ephemeral']);
export function settingsArgv(name, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'changes must be an object');
  const argv = ['set', name, '--json'];
  const { memory, cpus, profiles, flags = {}, ...unknown } = changes;
  if (Object.keys(unknown).length) throw new HttpError(400, `unknown change: ${Object.keys(unknown).join(', ')}`);
  for (const [key, v] of [['memory', memory], ['cpus', cpus]]) {
    if (v === undefined) continue;
    if (!/^[0-9]{1,5}[mMgG]?$/.test(String(v))) throw new HttpError(400, `${key}: invalid value`);
    argv.push(`--${key}=${v}`);
  }
  if (profiles !== undefined) {
    if (!Array.isArray(profiles) || profiles.some((p) => !/^[A-Za-z0-9._-]{1,64}$/.test(p))) {
      throw new HttpError(400, 'profiles: a list of profile names');
    }
    argv.push(`--profile=${profiles.length ? profiles.join(',') : 'none'}`);
  }
  if (typeof flags !== 'object' || Array.isArray(flags)) throw new HttpError(400, 'flags must be an object');
  for (const [flag, v] of Object.entries(flags)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(flag) || FORBIDDEN.has(flag)) throw new HttpError(400, `--${flag} cannot be changed from the web`);
    if (typeof v === 'boolean') argv.push(`--${flag}=${v ? 'on' : 'off'}`);
    else if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v)) argv.push(`--${flag}=${v}`);
    else throw new HttpError(400, `--${flag}: invalid value`);
  }
  if (argv.length === 3) throw new HttpError(400, 'nothing to change');
  return argv;
}

// The last line of a child's stdout that is JSON (vivary prints only that with --json).
export function lastJson(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const l of lines) {
    try { return JSON.parse(l); } catch { /* not this one */ }
  }
  return null;
}
