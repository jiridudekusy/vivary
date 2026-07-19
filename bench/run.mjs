#!/usr/bin/env node
// Benchmark orchestrator: native (host) vs docker vs Apple `container`.
// Containers get --cpus 4 --memory 4g; CPU-multi uses 4 workers everywhere,
// so the CPU numbers are comparable. FS "mount" = host dir bind-mounted into
// the container (virtiofs) vs plain APFS natively; "local" = container-local
// filesystem vs another host dir natively.
//
// Usage: node bench/run.mjs [native docker container]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'agent-sandbox-agents';
const WORK = fs.mkdtempSync(path.join(os.homedir(), '.vivary-bench-'));
const envs = process.argv.slice(2).length ? process.argv.slice(2) : ['native', 'docker', 'container'];
const results = [];

function collect(out) {
  for (const line of out.split('\n')) {
    if (line.startsWith('RESULT,')) {
      const [, env, test, value, unit] = line.split(',');
      results.push({ env, test, value: Number(value), unit });
    } else if (line.startsWith('#')) {
      console.log(line);
    }
  }
}

function measureStartup(runtime) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = spawnSync(runtime, ['run', '--rm', IMAGE, 'true'], { stdio: 'ignore' });
    if (r.status !== 0) return;
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  results.push({ env: runtime, test: 'startup-run-true', value: Math.round(times[1]), unit: 'ms' });
  console.log(`# ${runtime}: startup median ${Math.round(times[1])}ms (runs: ${times.map((t) => Math.round(t)).join(', ')})`);
}

for (const env of envs) {
  console.log(`\n=== ${env} ===`);
  const dir = path.join(WORK, env);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'workload.mjs'), path.join(dir, 'workload.mjs'));

  if (env === 'native') {
    const local = path.join(WORK, 'native-local');
    fs.mkdirSync(local, { recursive: true });
    const r = spawnSync('node', [path.join(dir, 'workload.mjs'), 'native', dir, local],
      { encoding: 'utf8', timeout: 900000 });
    collect(r.stdout || '');
  } else {
    measureStartup(env);
    const r = spawnSync(env, [
      'run', '--rm', '--cpus', '4', '--memory', '4g',
      '-v', `${dir}:/bench`,
      IMAGE, 'node', '/bench/workload.mjs', env, '/bench', '/tmp/bench-local',
    ], { encoding: 'utf8', timeout: 900000 });
    collect(r.stdout || '');
    if (r.status !== 0) console.log(`# ${env}: workload exited ${r.status}: ${(r.stderr || '').slice(-300)}`);
  }
}

// ------------------------------------------------------------------- report --
const tests = [...new Set(results.map((r) => r.test))];
const cols = [...new Set(results.map((r) => r.env))];
const unitOf = (t) => results.find((r) => r.test === t)?.unit || '';
console.log('\n=== RESULTS ===');
const header = ['test (unit)', ...cols];
const rows = tests.map((t) => [
  `${t} (${unitOf(t)})`,
  ...cols.map((c) => {
    const hit = results.find((r) => r.test === t && r.env === c);
    return hit ? String(hit.value) : '-';
  }),
]);
const widths = header.map((_, i) => Math.max(header[i].length, ...rows.map((r) => r[i].length)));
console.log(header.map((h, i) => h.padEnd(widths[i] + 2)).join(''));
for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i] + 2)).join(''));

fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n(raw: ${WORK}/results.json)`);
