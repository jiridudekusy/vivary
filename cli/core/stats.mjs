// `vivary stats` — how hard the sandbox VMs press on the Mac itself: RAM, CPU,
// and the kernel tables that have actually taken it down (open files).
// `--trim` makes the guests drop their dentry/inode caches, which is what
// releases the host files virtiofs holds for them (see host.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOXES_DIR, capture, die, hasCmd, parseArgs } from './util.mjs';
import {
  DEFAULT_MEMORY_BUDGET, checkMemoryBudget, countBrokerEnfile, displayName, formatBytes,
  hostSnapshot, levelOf, parseBudget, runningVmMemory, vmProcesses, vnodeLevel,
} from './host.mjs';

const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// Join the configured sizes with the live processes into one row per VM.
export function vmRows(memory, procs) {
  const rows = new Map();
  for (const m of memory) {
    const kind = m.runtime === 'docker' ? 'docker' : m.runtime;
    rows.set(`${kind}:${m.id}`, { kind, id: m.id, bytes: m.bytes, cpus: m.cpus, proc: null });
  }
  for (const p of procs) {
    const key = `${p.owner.kind}:${p.owner.id}`;
    const row = rows.get(key) || { kind: p.owner.kind, id: p.owner.id, bytes: null, cpus: null };
    row.proc = p;
    rows.set(key, row);
  }
  return [...rows.values()].map((r) => ({ ...r, name: displayName({ kind: r.kind, id: r.id }) }))
    .sort((a, b) => (b.proc?.fds ?? 0) - (a.proc?.fds ?? 0));
}

// Findings, worst first. Each carries the one thing to do about it.
export function diagnose({ host, rows, budget, committedBytes, brokerEnfile = 0 }) {
  const out = [];
  const files = host.files;
  const vl = vnodeLevel(host.vnodes);
  if (vl !== 'ok') {
    out.push({
      level: vl,
      text: `only ${n(host.vnodes.free)} of ${n(host.vnodes.max)} file handles (vnodes) are free. `
        + 'At zero nothing on the Mac can open a file — the broker crashes first, then the Mac hangs.',
      fix: 'vivary stats --trim',
    });
  }
  if (brokerEnfile) {
    out.push({
      level: 'warning',
      text: `the broker ran out of file handles ${brokerEnfile}x in the last 24 h (ENFILE in broker.log) — `
        + 'the Mac hit the limit, even if it is fine right now.',
      fix: 'vivary stats --trim',
    });
  }
  const fl = levelOf(files.num / files.max);
  if (fl !== 'ok') {
    out.push({
      level: fl,
      text: `open-file table ${pct(files.num, files.max)} full (${n(files.num)} / ${n(files.max)}). `
        + 'When it fills, nothing on the Mac can open a file and it can hang outright.',
      fix: 'vivary stats --trim',
    });
  }
  for (const r of rows) {
    if (r.proc?.fds == null) continue;
    const l = levelOf(r.proc.fds / files.perProc, 0.5, 0.8);
    if (l === 'ok') continue;
    out.push({
      level: l,
      text: `${r.name} holds ${n(r.proc.fds)} host files — ${pct(r.proc.fds, files.perProc)} of the per-process cap `
        + `(${n(files.perProc)}); at the cap its file I/O starts failing inside the sandbox.`,
      fix: 'vivary stats --trim',
    });
  }
  if (committedBytes > budget.bytes) {
    out.push({
      level: 'warning',
      text: `VMs are configured for ${formatBytes(committedBytes)}, over the ${formatBytes(budget.bytes)} budget `
        + `(${budget.label}) — something was started with --ignore-memory-budget or outside vivary.`,
      fix: 'vivary down <name>',
    });
  }
  if (host.memFreePct && host.memFreePct < 20) {
    out.push({ level: 'warning', text: `only ${host.memFreePct}% of RAM free (memory pressure)`, fix: 'vivary down <name>' });
  }
  if (host.swap.used > 2 * 1024 ** 3) {
    out.push({ level: 'warning', text: `${formatBytes(host.swap.used)} of swap in use`, fix: 'vivary down <name>' });
  }
  const rank = { critical: 0, warning: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function renderStats({ host, rows, budget, committedBytes, findings }) {
  const L = [];
  const gb = (b) => (b == null ? '—' : formatBytes(b));
  L.push(`Host        ${gb(host.memBytes)} RAM · ${host.ncpu} CPU · load ${host.loadavg.map((x) => x.toFixed(1)).join(' ')}`
    + ` · ${host.memFreePct}% RAM free · swap ${gb(host.swap.used)} used`);
  L.push(`Open files  ${n(host.files.num).padStart(9)} / ${n(host.files.max)}  ${pct(host.files.num, host.files.max).padStart(4)}`
    + `   (per process: ${n(host.files.perProc)})`);
  L.push(`Handles     ${n(host.vnodes.free).padStart(9)} free of ${n(host.vnodes.max)} vnodes  ${pct(host.vnodes.free, host.vnodes.max).padStart(4)}`
    + '   (the real limit: at 0 free nothing on the Mac can open a file)');
  L.push(`Processes   ${n(host.procs.num).padStart(9)} / ${n(host.procs.max)}  ${pct(host.procs.num, host.procs.max).padStart(4)}`);
  L.push(`VM memory   ${gb(committedBytes)} configured of ${gb(budget.bytes)} budget (${budget.label})`);
  L.push('');
  if (!rows.length) {
    L.push('No VMs running.');
  } else {
    const head = ['VM', 'RUNTIME', 'MEMORY', 'CPUS', 'HOST RSS', 'CPU%', 'OPEN FILES', 'OF SYSTEM'];
    const body = rows.map((r) => [
      r.name,
      r.kind === 'foreign' ? 'not vivary' : r.kind,
      gb(r.bytes),
      r.cpus ?? '—',
      gb(r.proc?.rss),
      r.proc ? r.proc.cpu.toFixed(1) : '—',
      n(r.proc?.fds),
      r.proc?.fds != null ? pct(r.proc.fds, host.files.max) : '—',
    ].map(String));
    const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const fmt = (cells) => cells.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
    L.push(fmt(head), ...body.map(fmt));
    if (rows.some((r) => r.kind === 'foreign')) {
      L.push('', '"not vivary" VMs are shown for their load; they are outside the memory budget.');
    }
  }
  L.push('');
  if (!findings.length) {
    L.push('No problems found.');
  } else {
    for (const f of findings) {
      L.push(`${f.level === 'critical' ? 'CRITICAL' : 'WARNING '} ${f.text}`);
      L.push(`         -> ${f.fix}`);
    }
    if (findings.some((f) => f.fix === 'vivary stats --trim')) {
      L.push('', 'Why files: virtiofs keeps a host file open for every file the guest kernel has cached.',
        '--trim makes the guests drop that cache (dentries/inodes); the files are released at once.');
    }
  }
  return L.join('\n');
}

function budgetSetting(loadGlobalBudget) {
  try {
    return loadGlobalBudget() ?? DEFAULT_MEMORY_BUDGET;
  } catch {
    return DEFAULT_MEMORY_BUDGET;
  }
}

// The tail of broker.log is enough for 24 h of ENFILE tags; the whole file is
// tens of MB.
function brokerLogTail(bytes = 4 * 1024 * 1024) {
  const file = path.join(SANDBOXES_DIR, '.broker', 'broker.log');
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function collect(loadGlobalBudget) {
  const host = hostSnapshot();
  const memory = runningVmMemory();
  const procs = vmProcesses();
  const budget = parseBudget(budgetSetting(loadGlobalBudget), host.memBytes);
  const { used: committedBytes } = checkMemoryBudget({ budgetBytes: budget.bytes, committed: memory });
  const rows = vmRows(memory, procs);
  const brokerEnfile = countBrokerEnfile(brokerLogTail());
  return {
    host, rows, budget, committedBytes, brokerEnfile,
    findings: diagnose({ host, rows, budget, committedBytes, brokerEnfile }),
  };
}

// Drop the dentry/inode cache in every running vivary sandbox on Apple
// `container`. Measured: 189 945 -> 27 310 host fds for one VM. Costs the guest
// its warm metadata cache (the next walk of the tree re-looks files up), nothing
// else — `sync` first, and only clean caches are dropped. Run as root via the
// runtime, so it works whether or not the sandbox has --sudo.
function trim() {
  if (!hasCmd('container')) die('--trim needs Apple `container` (docker sandboxes share Docker Desktop\'s VM)');
  const before = new Map(vmProcesses().map((p) => [p.owner.id, p.fds]));
  const targets = runningVmMemory().filter((v) => v.runtime === 'container' && v.id.startsWith('claude-sandbox-'));
  if (!targets.length) {
    console.log('No running vivary sandboxes on Apple `container`.');
    return;
  }
  for (const t of targets) {
    const r = capture('container', ['exec', '--user', 'root', t.id, 'sh', '-c', 'sync; echo 2 > /proc/sys/vm/drop_caches'],
      { timeout: 60000 });
    if (r.status !== 0) console.error(`    ${displayName({ kind: 'container', id: t.id })}: failed — ${(r.stderr || r.stdout).trim()}`);
  }
  const after = new Map(vmProcesses().map((p) => [p.owner.id, p.fds]));
  for (const t of targets) {
    const name = displayName({ kind: 'container', id: t.id });
    console.log(`==> ${name.padEnd(24)} ${n(before.get(t.id)).padStart(9)} -> ${n(after.get(t.id)).padStart(9)} host files`);
  }
}

export function cmdStats(argv, { loadGlobalBudget } = {}) {
  if (process.platform !== 'darwin') die('vivary stats measures a macOS host; this is not one');
  const { flags } = parseArgs(argv, { json: 'boolean', trim: 'boolean' });
  if (flags.trim) {
    trim();
    console.log('');
  }
  const s = collect(loadGlobalBudget);
  if (flags.json) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(renderStats(s));
  }
  if (s.findings.some((f) => f.level === 'critical')) process.exitCode = 2;
}
