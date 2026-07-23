// Fat-image composition: one Dockerfile assembled from the core image plus
// every plugin's fragment; plugin features are activated at RUNTIME via env
// variables, so a single image serves all sandboxes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_DIR, IMAGE, capture, die, hasCmd, parseArgs, runInherit,
} from './util.mjs';
import { detectRuntime } from './runtime.mjs';
import { getPlugins } from './plugins.mjs';
import { bootVm, MACOS_BASE, tartLogFile } from './runtimes/tart.mjs';

const IMAGE_DIR = path.join(CLI_DIR, 'image');

// Assemble the build context: core rootfs + entrypoint hooks + per-plugin
// rootfs/fragments. Returns the staging directory.
export function composeContext() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-build-'));
  fs.cpSync(path.join(IMAGE_DIR, 'rootfs'), path.join(staging, 'rootfs'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'entrypoint.d'), { recursive: true });
  fs.cpSync(path.join(IMAGE_DIR, 'entrypoint.d'), path.join(staging, 'entrypoint.d'), { recursive: true });

  const fragments = [];
  for (const p of getPlugins()) {
    const rootfs = path.join(p.dir, 'rootfs');
    if (fs.existsSync(rootfs)) {
      fs.cpSync(rootfs, path.join(staging, 'plugins', p.name, 'rootfs'), { recursive: true });
    }
    const hooks = path.join(p.dir, 'entrypoint.d');
    if (fs.existsSync(hooks)) {
      fs.cpSync(hooks, path.join(staging, 'entrypoint.d'), { recursive: true });
    }
    const fragment = path.join(p.dir, 'image.dockerfile');
    if (fs.existsSync(fragment)) {
      fragments.push(`# ===== plugin: ${p.name} =====\n${fs.readFileSync(fragment, 'utf8')}`);
    }
  }

  const dockerfile = [
    fs.readFileSync(path.join(IMAGE_DIR, 'Dockerfile.core'), 'utf8'),
    ...fragments,
    fs.readFileSync(path.join(IMAGE_DIR, 'Dockerfile.footer'), 'utf8'),
  ].join('\n');
  fs.writeFileSync(path.join(staging, 'Dockerfile'), dockerfile);
  return staging;
}

const MACOS_BASE_SRC = process.env.SANDBOX_MACOS_BASE_SRC || 'ghcr.io/cirruslabs/macos-tahoe-base:latest';

// Provisioning steps contributed by plugins (agent installs), in plugin order.
export function collectMacosProvision(plugins) {
  const steps = [];
  for (const p of plugins) {
    for (const line of p.macosProvision || []) steps.push({ plugin: p.name, line });
  }
  return steps;
}

// Clone the cirruslabs base, boot it with an OPEN network, run every
// plugin's macosProvision step over the guest agent, stop. Sandboxes then
// clone the result copy-on-write. Building with the network open resolves
// the chicken-and-egg with egress-locked sandboxes.
function buildMacosBase({ force = false } = {}) {
  if (!hasCmd('tart')) die("'tart' not found on PATH (brew install cirruslabs/cli/tart)");
  const listed = capture('tart', ['list', '--format', 'json']);
  if (listed.status !== 0) die(`tart list failed: ${listed.stderr || listed.stdout}`);
  const local = new Map(JSON.parse(listed.stdout || '[]')
    .filter((vm) => vm.Source === 'local').map((vm) => [vm.Name, vm.Running === true]));
  if (local.has(MACOS_BASE)) {
    if (!force) die(`VM '${MACOS_BASE}' already exists — rebuild with: vivary build --runtime tart --force`);
    if (local.get(MACOS_BASE)) die(`VM '${MACOS_BASE}' is running — stop it first: tart stop ${MACOS_BASE}`);
    if (capture('tart', ['delete', MACOS_BASE]).status !== 0) die(`cannot delete '${MACOS_BASE}'`);
  }
  console.log(`==> Cloning ${MACOS_BASE_SRC} -> ${MACOS_BASE} (pulls the OCI image when not cached)`);
  if (runInherit('tart', ['clone', MACOS_BASE_SRC, MACOS_BASE]) !== 0) die('tart clone failed');
  console.log('==> Booting the base VM for provisioning (open network)');
  bootVm(MACOS_BASE); // throws on failure; vivary.mjs catch prints it
  for (const { plugin, line } of collectMacosProvision(getPlugins())) {
    console.log(`==> [${plugin}] ${line}`);
    if (runInherit('tart', ['exec', MACOS_BASE, '/bin/zsh', '-lc', line]) !== 0) {
      capture('tart', ['stop', MACOS_BASE]);
      die(`provisioning step failed (plugin '${plugin}') — the half-provisioned base was stopped; rebuild with --force (log: ${tartLogFile(MACOS_BASE)})`);
    }
  }
  capture('tart', ['stop', MACOS_BASE]);
  console.log(`==> macOS base '${MACOS_BASE}' ready — tart sandboxes clone it on first start.`);
}

export function cmdBuild(argv = []) {
  const { flags } = parseArgs(argv, { runtime: 'string', force: 'boolean' });
  if (flags.runtime === 'tart') return buildMacosBase({ force: flags.force });
  const runtime = detectRuntime();
  console.log(`==> Using runtime: ${runtime}`);
  const context = composeContext();
  console.log(`==> Composed image context: ${context} (${getPlugins().length} plugins)`);

  try {
    // Apple `container`'s builder VM has broken Node.js DNS (EAI_AGAIN), so
    // `npm install` steps never succeed there. When Docker is available,
    // build with Docker and load the result into the container store.
    // Force a native `container build` with SANDBOX_NATIVE_BUILD=1.
    if (runtime === 'container' && process.env.SANDBOX_NATIVE_BUILD !== '1' && hasCmd('docker')) {
      console.log(`==> Building ${IMAGE} with Docker, then loading into the container store`);
      if (runInherit('docker', ['build', '-t', IMAGE, context]) !== 0) die('docker build failed');
      const tar = path.join(os.tmpdir(), `${IMAGE}-${Date.now()}.tar`);
      try {
        if (runInherit('docker', ['save', `${IMAGE}:latest`, '-o', tar]) !== 0) die('docker save failed');
        if (runInherit('container', ['image', 'load', '-i', tar]) !== 0) die('container image load failed');
      } finally {
        fs.rmSync(tar, { force: true });
      }
    } else {
      console.log(`==> Building ${IMAGE}`);
      if (runInherit(runtime, ['build', '-t', IMAGE, context]) !== 0) die(`${runtime} build failed`);
    }
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  console.log('==> Done');
}
