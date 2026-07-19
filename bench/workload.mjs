#!/usr/bin/env node
// Benchmark workload — runs identically on the host and inside containers.
// Usage: node workload.mjs <env-label> <mount-dir> <local-dir>
// Prints CSV lines: RESULT,<env>,<test>,<value>,<unit>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const [env, mntDir, locDir] = process.argv.slice(2);
if (!env || !mntDir || !locDir) {
  console.error('usage: workload.mjs <env> <mount-dir> <local-dir>');
  process.exit(1);
}

const res = (test, value, unit) =>
  console.log(`RESULT,${env},${test},${Math.round(value)},${unit}`);

console.log(`# ${env}: node ${process.version}, ${os.cpus().length} cpus visible, ${Math.round(os.totalmem() / 2 ** 30)}G mem`);

// --- CPU: sha256 over 1MB buffer -------------------------------------------
function cpuBurn(iters) {
  const buf = Buffer.alloc(1 << 20, 7);
  for (let i = 0; i < iters; i++) crypto.createHash('sha256').update(buf).digest();
}

{
  cpuBurn(50); // warmup
  const t0 = performance.now();
  cpuBurn(800);
  res('cpu-single', performance.now() - t0, 'ms');
}

{
  const t0 = performance.now();
  const kids = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', `
    const c=require("crypto");const b=Buffer.alloc(1<<20,7);
    for(let i=0;i<400;i++)c.createHash("sha256").update(b).digest();
  `]));
  await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
  res('cpu-multi4', performance.now() - t0, 'ms');
}

// --- Filesystem -------------------------------------------------------------
function fsSmallFiles(dir, label) {
  const d = path.join(dir, 'fs-small');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  const data = Buffer.alloc(4096, 1);

  let t0 = performance.now();
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(d, `f${i}`), data);
  res(`fs-write-1000x4k-${label}`, performance.now() - t0, 'ms');

  t0 = performance.now();
  for (let i = 0; i < 1000; i++) fs.readFileSync(path.join(d, `f${i}`));
  res(`fs-read-1000x4k-${label}`, performance.now() - t0, 'ms');

  t0 = performance.now();
  fs.rmSync(d, { recursive: true });
  res(`fs-delete-1000-${label}`, performance.now() - t0, 'ms');
}

function fsSequential(dir, label) {
  const file = path.join(dir, 'fs-seq.bin');
  const chunk = Buffer.alloc(4 << 20, 2); // 4MB
  const total = 256 << 20; // 256MB

  let t0 = performance.now();
  let fd = fs.openSync(file, 'w');
  for (let w = 0; w < total; w += chunk.length) fs.writeSync(fd, chunk);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const wMs = performance.now() - t0;
  res(`fs-seqwrite-256m-${label}`, (total / 2 ** 20) / (wMs / 1000), 'MB/s');

  t0 = performance.now();
  fd = fs.openSync(file, 'r');
  const rbuf = Buffer.alloc(4 << 20);
  while (fs.readSync(fd, rbuf, 0, rbuf.length) > 0) { /* drain */ }
  fs.closeSync(fd);
  const rMs = performance.now() - t0;
  res(`fs-seqread-256m-${label}`, (total / 2 ** 20) / (rMs / 1000), 'MB/s');

  fs.rmSync(file, { force: true });
}

for (const [dir, label] of [[mntDir, 'mount'], [locDir, 'local']]) {
  fs.mkdirSync(dir, { recursive: true });
  fsSmallFiles(dir, label);
  fsSequential(dir, label);
}

// --- npm install (real-world: network + many small files on the mount) ------
{
  const d = path.join(mntDir, 'npm-bench');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: 'bench', version: '1.0.0',
    dependencies: { express: '4.21.2', lodash: '4.17.21', typescript: '5.7.3' },
  }));
  const t0 = performance.now();
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: d,
    env: { ...process.env, npm_config_cache: path.join(d, '.npm-cache') },
    stdio: 'ignore',
  });
  if (r.status === 0) res('npm-install', performance.now() - t0, 'ms');
  else console.log(`# ${env}: npm install FAILED`);
  fs.rmSync(d, { recursive: true, force: true });
}

// --- Network: 3 x 25MB download (Cloudflare 403s requests >= ~100MB) ---------
{
  const t0 = performance.now();
  try {
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const resp = await fetch('https://speed.cloudflare.com/__down?bytes=26214400',
        { signal: AbortSignal.timeout(90000) });
      if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
      for await (const c of resp.body) bytes += c.length;
    }
    const ms = performance.now() - t0;
    res('net-download-75m', (bytes / 2 ** 20) / (ms / 1000), 'MB/s');
  } catch (e) {
    console.log(`# ${env}: net test failed: ${e.message}`);
  }
}

console.log(`# ${env}: done`);
