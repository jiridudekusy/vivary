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
  mounts = [], capture = realCapture, sleep = defaultSleep, spawnDetached = defaultSpawnDetached,
} = {}) {
  const running = [...listLocalVms(capture).values()].filter((v) => v.running).length;
  if (running >= 2) {
    console.error(`WARNING: ${running} macOS VMs already running — Apple caps concurrent guests at 2; this boot may fail.`);
  }
  spawnDetached(buildTartRunArgv({ name: vm, mounts }), tartLogFile(vm));
  return waitForVm(vm, { capture, sleep });
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

export function makeTartRuntime({
  capture = realCapture,
  runInherit = realRunInherit,
  spawnDetached = defaultSpawnDetached,
  sleep = defaultSleep,
  hasCmd = realHasCmd,
} = {}) {
  const ensureBooted = (spec) => {
    if (listLocalVms(capture).get(spec.name)?.running) return;
    bootVm(spec.name, { mounts: spec.mounts || [], capture, sleep, spawnDetached });
    mountShares(spec.name, spec.mounts || [], capture);
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
      const env = { ...envPairsToObject(spec.termEnv), ...spec.env };
      console.log(`    (macOS VM '${spec.name}' keeps running after the command exits — stop with: vivary down)`);
      return runInherit('tart', buildGuestExecArgv(spec.name, spec.command, {
        interactive: spec.interactive, env, cwd: spec.cwd,
      }));
    },
    exec(vm, argv, opts = {}) {
      return runInherit('tart', buildGuestExecArgv(vm, argv, opts));
    },
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
