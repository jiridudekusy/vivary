// tart (Cirrus Labs) runtime provider: macOS guest VMs. Pure argv builders
// live at the top (regression-testable); the DI'd orchestration follows.
//
// tart facts this file relies on (verified, tart 2.34.0): `list --format
// json`; `set --cpu N --memory MB`; `ip --wait s`; `exec [-i] [-t]` via the
// guest agent; `run` is foreground (spawned detached here); virtiofs shares
// mount in-guest with `sudo /sbin/mount_virtiofs <tag> <path>`.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  SANDBOXES_DIR, capture as realCapture, hasCmd as realHasCmd, runInherit as realRunInherit,
} from '../util.mjs';

export function tartVmName(sandboxName) {
  return `vivary-${sandboxName}`;
}

export function parseMemoryMb(s) {
  const m = String(s).trim().match(/^(\d+)([gGmM])?$/);
  if (!m) throw new Error(`cannot parse memory value '${s}' (use e.g. 4g, 2048m, or plain MB)`);
  return Number(m[1]) * (m[2]?.toLowerCase() === 'g' ? 1024 : 1);
}

export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function envPairsToObject(pairs = []) {
  const env = {};
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i] !== '-e') continue;
    const kv = pairs[++i] || '';
    const eq = kv.indexOf('=');
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return env;
}

// Headless boot argv. Mount i is shared under tag ws<i>; the boot flow
// mounts each tag at its (same-path) guest destination after the agent is up.
export function buildTartRunArgv(spec) {
  const argv = ['run', spec.name, '--no-graphics'];
  (spec.mounts || []).forEach((m, i) => {
    argv.push(`--dir=${m.host}:${m.ro ? 'ro,' : ''}tag=ws${i}`);
  });
  argv.push(...(spec.tartRunArgs || []));
  return argv;
}

// In-guest command via the guest agent: env(1) injects variables (tart exec
// has no -e), a login zsh resolves brew paths, cd sets the cwd (no -w either).
export function buildGuestExecArgv(vm, argv, { interactive = false, env = {}, cwd } = {}) {
  const line = `${cwd ? `cd ${shq(cwd)} && ` : ''}exec ${argv.map(shq).join(' ')}`;
  return [
    'exec', ...(interactive ? ['-i', '-t'] : []), vm,
    '/usr/bin/env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    '/bin/zsh', '-lc', line,
  ];
}

export const MACOS_BASE = process.env.SANDBOX_MACOS_BASE || 'vivary-macos-base';

export function tartLogFile(vm) {
  return path.join(SANDBOXES_DIR, '.tart', `${vm}.log`);
}

function defaultSpawnDetached(argv, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  spawn('tart', argv, { detached: true, stdio: ['ignore', log, log] }).unref();
}

function defaultSleep(ms) {
  spawnSync('sleep', [String(ms / 1000)]);
}

// Local VMs by name -> { running }. OCI cache entries are not local VMs.
function listLocalVms(capture) {
  const r = capture('tart', ['list', '--format', 'json']);
  if (r.status !== 0) return new Map();
  const map = new Map();
  for (const vm of JSON.parse(r.stdout || '[]')) {
    if (vm.Source === 'local') map.set(vm.Name, { running: vm.Running === true });
  }
  return map;
}

// Block until the VM has an IP and its guest agent answers `exec true`.
export function waitForVm(vm, { capture = realCapture, sleep = defaultSleep, timeoutSec = 90 } = {}) {
  const ip = capture('tart', ['ip', vm, '--wait', String(timeoutSec)]);
  if (ip.status !== 0) {
    throw new Error(`VM '${vm}' got no IP within ${timeoutSec}s (log: ${tartLogFile(vm)})`);
  }
  for (let i = 0; i < timeoutSec; i++) {
    if (capture('tart', ['exec', vm, 'true']).status === 0) return ip.stdout.trim();
    sleep(1000);
  }
  throw new Error(`VM '${vm}' guest agent is not answering (log: ${tartLogFile(vm)})`);
}

// Detached headless boot + readiness wait. Returns the guest IP.
export function bootVm(vm, {
  mounts = [], runArgs = [], capture = realCapture, sleep = defaultSleep, spawnDetached = defaultSpawnDetached,
} = {}) {
  const running = [...listLocalVms(capture).values()].filter((v) => v.running).length;
  if (running >= 2) {
    console.error(`WARNING: ${running} macOS VMs already running — Apple caps concurrent guests at 2; this boot may fail.`);
  }
  spawnDetached(buildTartRunArgv({ name: vm, mounts, tartRunArgs: runArgs }), tartLogFile(vm));
  try {
    return waitForVm(vm, { capture, sleep });
  } catch (e) {
    capture('tart', ['stop', vm]); // don't orphan a half-booted VM
    throw e;
  }
}

// Mount every share at its (same-path) guest destination. Tag ws<i> matches
// buildTartRunArgv. /sbin/mount_virtiofs needs the full path under sudo.
function mountShares(vm, mounts, capture) {
  mounts.forEach((m, i) => {
    if (capture('tart', ['exec', vm, 'sudo', 'mkdir', '-p', m.guest]).status !== 0) {
      throw new Error(`cannot create mountpoint '${m.guest}' in VM '${vm}'`);
    }
    const r = capture('tart', ['exec', vm, 'sudo', '/sbin/mount_virtiofs', `ws${i}`, m.guest]);
    if (r.status !== 0) {
      throw new Error(`mounting '${m.guest}' (virtiofs tag ws${i}) failed: ${r.stderr || r.stdout}`);
    }
  });
}

// The guest's default IPv4 gateway = the host address it reaches published
// services on. Resolved in-guest (netstat) once the VM is up.
export function guestGateway(vm, capture = realCapture) {
  const r = capture('tart', ['exec', vm, '/bin/zsh', '-lc',
    "netstat -rn -f inet | awk '/^default/{print $2; exit}'"]);
  const gw = r.status === 0 ? r.stdout.trim() : '';
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(gw) ? gw : null;
}

// Substitute the literal __GATEWAY__ placeholder in an env map with the guest's
// gateway (egress HTTPS_PROXY / host-open SBX_OPEN_URL need it, but it is only
// known after boot). No placeholder -> no exec cost, so container-shaped envs
// and plain tart sandboxes pay nothing.
export function withGateway(env, vm, capture = realCapture) {
  if (!Object.values(env).some((v) => String(v).includes('__GATEWAY__'))) return env;
  const gw = guestGateway(vm, capture);
  if (!gw) throw new Error(`could not resolve the guest gateway for VM '${vm}'`);
  const out = {};
  for (const [k, v] of Object.entries(env)) out[k] = String(v).split('__GATEWAY__').join(gw);
  return out;
}

// Guest login env. `tart exec` injects the plugin-contributed env via env(1),
// so the agent session vivary spawns is fine — but an ssh / `vivary ide`
// session inherits NOTHING: `open` would fall back to the guest's own
// /usr/bin/open (opening inside the VM), and a missing HTTPS_PROXY leaves the
// session with no route out at all under the egress softnet floor. So persist
// the same env as a sourced snippet. Rewritten on every boot — the vmnet
// gateway is DHCP-fresh each time. The values (broker/ASHP tokens) are readable
// by the guest's only user, which already has them in its process env anyway.
export const GUEST_ENV_FILE = '/etc/vivary-env.sh';

// A non-interactive ssh session gets PATH=/usr/bin:/bin:/usr/sbin:/sbin from
// sshd and never runs path_helper (that lives in the LOGIN files, zprofile /
// profile), so /usr/local/bin is missing and `open` silently resolves to the
// guest's own /usr/bin/open — the URL then opens inside the VM and the caller
// still sees rc=0. Prepend it, idempotently and in POSIX sh syntax (this file
// is sourced from both /etc/zshenv and /etc/profile).
const GUEST_PATH_FIX = 'case ":$PATH:" in *:/usr/local/bin:*) ;; '
  + '*) export PATH="/usr/local/bin:$PATH";; esac';

export function guestEnvScript(env) {
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`);
  return `# generated by vivary on every boot — do not edit\n${GUEST_PATH_FIX}\n${lines.join('\n')}\n`;
}

// Idempotent: the snippet is overwritten, the source hook appended once per rc
// file. zshenv covers zsh (the macOS default, and every non-interactive `tart
// exec`); profile covers sh/bash logins.
export function guestEnvInstallCmd(script) {
  const b64 = Buffer.from(script).toString('base64');
  const hook = `[ -r ${GUEST_ENV_FILE} ] && . ${GUEST_ENV_FILE}`;
  return [
    `printf '%s' ${shq(b64)} | base64 -d | sudo tee ${GUEST_ENV_FILE} >/dev/null`,
    `sudo chmod 644 ${GUEST_ENV_FILE}`,
    ...['/etc/zshenv', '/etc/profile'].map((rc) => `{ sudo grep -qF ${shq(GUEST_ENV_FILE)} ${rc} `
      + `2>/dev/null || echo ${shq(hook)} | sudo tee -a ${rc} >/dev/null; }`),
  ].join(' && ');
}

export function writeGuestEnv(vm, env, capture = realCapture) {
  if (!env || !Object.keys(env).length) return true;
  const r = capture('tart', ['exec', vm, '/bin/zsh', '-lc', guestEnvInstallCmd(guestEnvScript(env))]);
  if (r.status !== 0) {
    console.error(`WARNING: could not persist the guest login env in VM '${vm}' — `
      + 'ssh sessions will miss host-open / proxy settings '
      + `(${(r.stderr || r.stdout || '').trim()})`);
  }
  return r.status === 0;
}

export function makeTartRuntime({
  capture = realCapture,
  runInherit = realRunInherit,
  spawnDetached = defaultSpawnDetached,
  sleep = defaultSleep,
  hasCmd = realHasCmd,
} = {}) {
  const ensureBooted = (spec) => {
    if (listLocalVms(capture).get(spec.name)?.running) return;
    bootVm(spec.name, { mounts: spec.mounts || [], runArgs: spec.tartRunArgs || [], capture, sleep, spawnDetached });
    mountShares(spec.name, spec.mounts || [], capture);
    writeGuestEnv(spec.name, withGateway({ ...spec.env }, spec.name, capture), capture);
  };
  return {
    name: 'tart',
    kind: 'vm-tart',
    instanceName(sandboxName) { return tartVmName(sandboxName); },
    // "Image" for tart = the per-sandbox VM, cloned copy-on-write from the
    // provisioned base. tart set only works on a stopped VM — skip if running.
    ensureImage(spec) {
      const hasTartCmd = hasCmd('tart');
      if (!hasTartCmd) throw new Error("'tart' not found on PATH (brew install cirruslabs/cli/tart)");
      let vms = listLocalVms(capture);
      if (!vms.has(spec.name)) {
        if (!vms.has(MACOS_BASE)) {
          throw new Error(`macOS base VM '${MACOS_BASE}' not found — build it first: vivary build --runtime tart`);
        }
        const r = capture('tart', ['clone', MACOS_BASE, spec.name]);
        if (r.status !== 0) throw new Error(`tart clone failed: ${r.stderr || r.stdout}`);
        console.log(`==> Cloned macOS VM '${spec.name}' from '${MACOS_BASE}' (APFS copy-on-write)`);
        vms = listLocalVms(capture);
      }
      if (!vms.get(spec.name)?.running) {
        const r = capture('tart', ['set', spec.name, '--cpu', String(spec.cpus), '--memory', String(parseMemoryMb(spec.memory))]);
        if (r.status !== 0) throw new Error(`tart set failed: ${r.stderr || r.stdout}`);
      }
      return spec.name;
    },
    run(spec, { detached = false } = {}) {
      ensureBooted(spec);
      if (detached) return { status: 0 };
      const env = withGateway({ ...envPairsToObject(spec.termEnv), ...spec.env }, spec.name, capture);
      console.log(`    (macOS VM '${spec.name}' keeps running after the command exits — stop with: vivary down)`);
      return runInherit('tart', buildGuestExecArgv(spec.name, spec.command, {
        interactive: spec.interactive, env, cwd: spec.cwd,
      }));
    },
    exec(vm, argv, opts = {}) {
      const env = withGateway(opts.env || {}, vm, capture);
      return runInherit('tart', buildGuestExecArgv(vm, argv, { ...opts, env }));
    },
    // Boot (+ mount + guest env) without attaching, so the lifecycle can run
    // the vmPostUp hooks on the start/shell paths too, not just on `up`.
    ensureUp(spec) { ensureBooted(spec); },
    stop(vm) { return capture('tart', ['stop', vm]); },
    // The VM disk IS the sandbox state (in-guest logins, chats) — plain rm
    // keeps it; purge deletes it. Lifecycle prints the kind-aware message.
    rm() { return { status: 0 }; },
    purge(vm) { return capture('tart', ['delete', vm]); },
    isRunning(sandboxName) { return listLocalVms(capture).get(tartVmName(sandboxName))?.running === true; },
    runningSet() {
      return new Set([...listLocalVms(capture)].filter(([, v]) => v.running).map(([n]) => n));
    },
    ip(vm) {
      const r = capture('tart', ['ip', vm, '--wait', '2']);
      return r.status === 0 ? r.stdout.trim() : null;
    },
  };
}
