import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMemoryBudget, displayName, formatBudgetRefusal, formatBytes, levelOf, openFilesWarning,
  parseBudget, parseContainerLs, parseLsofF, parseMemory, requestedMemoryBytes, vmOwnerFromPath,
} from '../core/host.mjs';
import { diagnose, renderStats, vmRows } from '../core/stats.mjs';
import { validateConfig } from '../core/config.mjs';

const GiB = 1024 ** 3;

test('parseMemory: binary units, bare number is bytes', () => {
  assert.equal(parseMemory('8g'), 8 * GiB);
  assert.equal(parseMemory('8G'), 8 * GiB);
  assert.equal(parseMemory('8gb'), 8 * GiB);
  assert.equal(parseMemory('8GiB'), 8 * GiB);
  assert.equal(parseMemory('8192m'), 8 * GiB);
  assert.equal(parseMemory('1.5g'), 1.5 * GiB);
  assert.equal(parseMemory('4294967296'), 4 * GiB);
  assert.throws(() => parseMemory('lots'), /cannot parse memory size/);
  assert.throws(() => parseMemory(''), /cannot parse memory size/);
});

test('requestedMemoryBytes: tart reads a bare number as MB, containers as bytes', () => {
  assert.equal(requestedMemoryBytes('4096', 'tart'), 4 * GiB);
  assert.equal(requestedMemoryBytes('4g', 'tart'), 4 * GiB);
  assert.equal(requestedMemoryBytes('4g', 'container'), 4 * GiB);
});

test('parseBudget: share of host RAM or absolute size', () => {
  assert.deepEqual(parseBudget('50%', 64 * GiB), { bytes: 32 * GiB, label: '50% of 64.0 GiB' });
  assert.equal(parseBudget('62.5%', 64 * GiB).bytes, 40 * GiB);
  assert.deepEqual(parseBudget('40g', 64 * GiB), { bytes: 40 * GiB, label: '40.0 GiB' });
  assert.throws(() => parseBudget('0%', 64 * GiB), /above 0 and at most 100/);
  assert.throws(() => parseBudget('150%', 64 * GiB), /above 0 and at most 100/);
  assert.throws(() => parseBudget('half', 64 * GiB), /'50%'.*'32g'/);
});

test('checkMemoryBudget: sums what runs plus the request', () => {
  const committed = [{ bytes: 8 * GiB }, { bytes: 20 * GiB }];
  assert.deepEqual(checkMemoryBudget({ budgetBytes: 32 * GiB, committed, requestBytes: 4 * GiB }),
    { ok: true, used: 28 * GiB, total: 32 * GiB }); // exactly at the budget is allowed
  assert.equal(checkMemoryBudget({ budgetBytes: 32 * GiB, committed, requestBytes: 8 * GiB }).ok, false);
  assert.equal(checkMemoryBudget({ budgetBytes: 32 * GiB, requestBytes: 8 * GiB }).ok, true);
});

test('parseContainerLs: running VMs only, configured size', () => {
  const json = JSON.stringify([
    { id: 'claude-sandbox-a', configuration: { id: 'claude-sandbox-a', resources: { cpus: 6, memoryInBytes: 8 * GiB } }, status: { state: 'running' } },
    { id: 'claude-sandbox-b', configuration: { id: 'claude-sandbox-b', resources: { cpus: 4, memoryInBytes: 4 * GiB } }, status: { state: 'stopped' } },
    { id: 'buildkit', configuration: { id: 'buildkit', resources: { cpus: 2, memoryInBytes: 2 * GiB } }, status: { state: 'running' } },
  ]);
  assert.deepEqual(parseContainerLs(json), [
    { id: 'claude-sandbox-a', runtime: 'container', bytes: 8 * GiB, cpus: 6 },
    { id: 'buildkit', runtime: 'container', bytes: 2 * GiB, cpus: 2 },
  ]);
  assert.deepEqual(parseContainerLs('not json'), []);
});

test('vmOwnerFromPath: identifies a VM process by the images it holds', () => {
  const base = '/Users/x/Library/Application Support';
  assert.deepEqual(vmOwnerFromPath(`${base}/com.apple.container/containers/claude-sandbox-smarta/rootfs.ext4`),
    { kind: 'container', id: 'claude-sandbox-smarta' });
  assert.deepEqual(vmOwnerFromPath('/Users/x/.tart/vms/vivary-mac/disk.img'), { kind: 'tart', id: 'vivary-mac' });
  assert.equal(vmOwnerFromPath(`${base}/Claude/vm_bundles/claudevm.bundle/rootfs.img`).kind, 'foreign');
  assert.equal(vmOwnerFromPath('/Users/x/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw').kind, 'docker');
  assert.equal(vmOwnerFromPath('/usr/lib/libSystem.B.dylib'), null);
});

test('displayName strips the runtime prefixes', () => {
  assert.equal(displayName({ kind: 'container', id: 'claude-sandbox-smarta' }), 'smarta');
  assert.equal(displayName({ kind: 'container', id: 'vivary-ashp' }), 'vivary-ashp');
  assert.equal(displayName({ kind: 'tart', id: 'vivary-mac' }), 'mac');
  assert.equal(displayName({ kind: 'foreign', id: 'Claude desktop VM' }), 'Claude desktop VM');
});

test('parseLsofF: one f line per fd, names per process', () => {
  const out = 'p10\nf3\nn/a/kernel.bin\nf4\nn/a/rootfs.ext4\np20\nf0\nf1\nf2\n';
  const m = parseLsofF(out);
  assert.deepEqual(m.get(10), { fds: 2, paths: ['/a/kernel.bin', '/a/rootfs.ext4'] });
  assert.equal(m.get(20).fds, 3);
});

test('levelOf thresholds', () => {
  assert.equal(levelOf(0.49), 'ok');
  assert.equal(levelOf(0.5), 'warning');
  assert.equal(levelOf(0.75), 'critical');
  assert.equal(levelOf(0.79, 0.5, 0.8), 'warning');
});

test('openFilesWarning: silent below half the system table', () => {
  assert.equal(openFilesWarning({ num: 200000, max: 491520 }), null);
  assert.match(openFilesWarning({ num: 300000, max: 491520 }), /61% full \(300,000 \/ 491,520\)/);
  assert.equal(openFilesWarning({ num: 5, max: 0 }), null);
});

test('formatBudgetRefusal names what runs, the request, and every way out', () => {
  const msg = formatBudgetRefusal({
    name: 'big', runtime: 'container', mode: 'up', requestBytes: 20 * GiB,
    committed: [{ id: 'claude-sandbox-smarta', runtime: 'container', bytes: 8 * GiB }],
    budget: { bytes: 32 * GiB, label: '50% of 64.0 GiB' }, total: 28 * GiB + 8 * GiB, setting: '50%',
  });
  assert.match(msg, /not starting 'big'.*36\.0 GiB/);
  assert.match(msg, /32\.0 GiB budget \(50% of 64\.0 GiB\)/);
  assert.match(msg, /smarta\s+container\s+8\.0 GiB/);
  assert.match(msg, /big\s+container\s+20\.0 GiB/);
  assert.match(msg, /vivary down <name>/);
  assert.match(msg, /vivary up --name big --memory <size> --recreate/);
  assert.match(msg, /"memoryBudget".*now "50%"/);
  assert.match(msg, /--ignore-memory-budget/);
});

test('memoryBudget: global file only — a project file must not raise the ceiling', () => {
  assert.doesNotThrow(() => validateConfig({ memoryBudget: '60%' }, { scope: 'global', file: 'vivary.json' }));
  assert.throws(() => validateConfig({ memoryBudget: '60%' }, { scope: 'project' }), /host policy/);
  assert.throws(() => validateConfig({ memoryBudget: 'lots' }, { scope: 'global', file: 'vivary.json' }),
    /vivary\.json: memoryBudget 'lots'/);
  assert.throws(() => validateConfig({ memoryBudget: 50 }, { scope: 'global', file: 'vivary.json' }), /must be a string/);
});

// --- stats ---

const host = {
  memBytes: 64 * GiB, ncpu: 16, loadavg: [1, 2, 3], memFreePct: 80,
  swap: { total: GiB, used: 0 },
  files: { num: 200000, max: 491520, perProc: 245760 },
  vnodes: { num: 263168, max: 263168 }, procs: { num: 800, max: 16000 },
};
const budget = { bytes: 32 * GiB, label: '50% of 64.0 GiB' };

test('vmRows joins configured sizes with live processes, busiest first', () => {
  const rows = vmRows(
    [{ id: 'claude-sandbox-a', runtime: 'container', bytes: 8 * GiB, cpus: 6 },
      { id: 'claude-sandbox-b', runtime: 'container', bytes: 4 * GiB, cpus: 2 }],
    [{ pid: 1, rss: GiB, cpu: 3, fds: 100, owner: { kind: 'container', id: 'claude-sandbox-b' } },
      { pid: 2, rss: GiB, cpu: 0, fds: 24, owner: { kind: 'foreign', id: 'Claude desktop VM' } }],
  );
  assert.deepEqual(rows.map((r) => r.name), ['b', 'Claude desktop VM', 'a']);
  assert.equal(rows[0].bytes, 4 * GiB);
  assert.equal(rows[0].proc.fds, 100);
  assert.equal(rows[2].proc, null); // configured but no process seen
});

test('diagnose: a VM near the per-process cap and a filling system table', () => {
  const rows = [{ name: 'smarta', proc: { fds: 200000 } }];
  const f = diagnose({ host: { ...host, files: { ...host.files, num: 400000 } }, rows, budget, committedBytes: 8 * GiB });
  assert.equal(f[0].level, 'critical');
  assert.match(f.map((x) => x.text).join('\n'), /open-file table 81% full/);
  assert.match(f.map((x) => x.text).join('\n'), /smarta holds 200,000 host files — 81% of the per-process cap/);
  assert.ok(f.every((x) => x.fix));
});

test('diagnose: over budget, pressure and swap are reported; a quiet host is clean', () => {
  assert.deepEqual(diagnose({ host, rows: [], budget, committedBytes: 8 * GiB }), []);
  const f = diagnose({
    host: { ...host, memFreePct: 10, swap: { total: 4 * GiB, used: 3 * GiB } },
    rows: [], budget, committedBytes: 40 * GiB,
  });
  const text = f.map((x) => x.text).join('\n');
  assert.match(text, /over the 32\.0 GiB budget/);
  assert.match(text, /only 10% of RAM free/);
  assert.match(text, /3\.0 GiB of swap/);
});

test('renderStats prints the host tables, the VM table and the findings', () => {
  const rows = [{ name: 'smarta', kind: 'container', bytes: 8 * GiB, cpus: 6, proc: { rss: 5 * GiB, cpu: 2.5, fds: 32910 } }];
  const out = renderStats({ host, rows, budget, committedBytes: 8 * GiB, findings: [] });
  assert.match(out, /Open files\s+200,000 \/ 491,520\s+41%/);
  assert.match(out, /VM memory\s+8\.0 GiB configured of 32\.0 GiB budget/);
  assert.match(out, /smarta\s+container\s+8\.0 GiB\s+6\s+5\.0 GiB\s+2\.5\s+32,910\s+7%/);
  assert.match(out, /No problems found\./);
});
