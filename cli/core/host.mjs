// Host resource accounting: how much of the Mac the sandbox VMs take, and the
// memory budget that keeps them from taking all of it.
//
// Two different failures have taken the Mac down, and they need different
// numbers:
//
// - MEMORY: every sandbox is a VM sized at start (`--memory`), and a Linux
//   guest fills that size with page cache over time — Virtualization.framework
//   does not hand it back. So the CONFIGURED sizes are where the VMs end up,
//   whatever their RSS says shortly after boot. The budget gate sums those.
//
// - OPEN FILES: Apple's virtiofs keeps one host file descriptor open for every
//   file the guest kernel holds in its dentry/inode cache. A sandbox walking a
//   big workspace (node_modules, the node-modules share) pins hundreds of
//   thousands of them in the VM process. Measured on `smarta`: 189 945 host fds
//   minutes after start, 27 310 after the guest dropped its dentry/inode cache.
//   When the system-wide table (kern.maxfiles) fills, every process on the Mac
//   gets ENFILE — on 2026-10-01 that was logged as "Too many open files in
//   system" a minute before a watchdog reset.
import os from 'node:os';
import { capture, hasCmd } from './util.mjs';
import { parseMemoryMb } from './runtimes/tart.mjs';

export const DEFAULT_MEMORY_BUDGET = '50%';
const GiB = 1024 ** 3;
const UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: GiB, t: 1024 ** 4 };

// --- pure ------------------------------------------------------------------------

// '8g', '8G', '8192m', '8gb', '8GiB', '4294967296' -> bytes. Binary units, which
// is what `container run --memory 8g` means (memoryInBytes 8589934592). A bare
// number is BYTES, as on the docker/container CLIs.
export function parseMemory(v) {
  const m = String(v ?? '').trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/);
  if (!m) throw new Error(`cannot parse memory size '${v}' (use e.g. 8g or 512m)`);
  return Math.round(parseFloat(m[1]) * UNITS[m[2]]);
}

// What a sandbox's `--memory` means in bytes. tart takes a bare number as MB
// (its own CLI's unit), the container runtimes as bytes — keep each consistent
// with how the value is actually passed on.
export function requestedMemoryBytes(memory, runtime) {
  return runtime === 'tart' ? parseMemoryMb(memory) * 1024 ** 2 : parseMemory(memory);
}

// memoryBudget: '50%' of host RAM, or an absolute size ('32g').
export function parseBudget(v, hostBytes) {
  const s = String(v ?? '').trim();
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) {
    const p = parseFloat(pct[1]);
    if (!(p > 0 && p <= 100)) throw new Error(`memoryBudget '${v}': a percentage must be above 0 and at most 100`);
    return { bytes: Math.floor((hostBytes * p) / 100), label: `${p}% of ${formatBytes(hostBytes)}` };
  }
  let bytes;
  try {
    bytes = parseMemory(s);
  } catch {
    throw new Error(`memoryBudget '${v}': use a share of host RAM ('50%') or a size ('32g')`);
  }
  return { bytes, label: formatBytes(bytes) };
}

export function formatBytes(n) {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GiB`;
  return `${Math.round(n / 1024 ** 2)} MiB`;
}

// `committed` is what already runs; `requestBytes` the VM about to start.
export function checkMemoryBudget({ budgetBytes, committed = [], requestBytes = 0 }) {
  const used = committed.reduce((sum, vm) => sum + vm.bytes, 0);
  const total = used + requestBytes;
  return { ok: total <= budgetBytes, used, total };
}

// `container ls --format json` -> running VMs with their configured size.
export function parseContainerLs(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(list) ? list : [])
    .filter((c) => c?.status?.state === 'running')
    .map((c) => ({
      id: c.configuration?.id ?? c.id,
      runtime: 'container',
      bytes: Number(c.configuration?.resources?.memoryInBytes) || 0,
      cpus: c.configuration?.resources?.cpus ?? null,
    }));
}

// A VM process is identified by the image files it holds open — the only link
// from a Virtualization.framework XPC process (parent: launchd) back to what it
// runs. Returns null for paths that identify nothing.
export function vmOwnerFromPath(p) {
  let m = p.match(/\/com\.apple\.container\/containers\/([^/]+)\//);
  if (m) return { kind: 'container', id: m[1] };
  m = p.match(/\/\.tart\/vms\/([^/]+)\//);
  if (m) return { kind: 'tart', id: m[1] };
  if (/\/Claude\/vm_bundles\//.test(p)) return { kind: 'foreign', id: 'Claude desktop VM' };
  if (/Docker\.raw|\/com\.docker\.docker\//.test(p)) return { kind: 'docker', id: 'Docker Desktop VM' };
  return null;
}

// Sandbox name for display: 'claude-sandbox-smarta' -> 'smarta', tart's
// 'vivary-smarta' -> 'smarta'; anything else (buildkit, vivary-ashp) as is.
export function displayName(owner) {
  if (owner.kind === 'container') return owner.id.replace(/^claude-sandbox-/, '');
  if (owner.kind === 'tart') return owner.id.replace(/^vivary-/, '');
  return owner.id;
}

// `lsof -F` output -> Map(pid -> { fds, paths[] }). Every fd is one 'f' line
// under its 'p' line; 'n' lines carry names when requested.
export function parseLsofF(out) {
  const by = new Map();
  let cur = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') {
      cur = { fds: 0, paths: [] };
      by.set(Number(line.slice(1)), cur);
    } else if (!cur) {
      continue;
    } else if (line[0] === 'f') {
      cur.fds++;
    } else if (line[0] === 'n') {
      cur.paths.push(line.slice(1));
    }
  }
  return by;
}

// Thresholds for the diagnosis. Files are about the SYSTEM table: once it is
// full nothing on the Mac can open a file, which is what preceded the reset.
export function levelOf(ratio, warn = 0.5, crit = 0.75) {
  if (ratio >= crit) return 'critical';
  if (ratio >= warn) return 'warning';
  return 'ok';
}

// --- IO --------------------------------------------------------------------------

function sysctlNumbers(keys) {
  const { status, stdout } = capture('sysctl', ['-n', ...keys]);
  const vals = status === 0 ? stdout.trim().split('\n') : [];
  return Object.fromEntries(keys.map((k, i) => [k, Number(vals[i]) || 0]));
}

export function hostSnapshot() {
  const s = sysctlNumbers([
    'kern.num_files', 'kern.maxfiles', 'kern.maxfilesperproc',
    'kern.num_vnodes', 'kern.maxvnodes', 'kern.maxproc', 'kern.memorystatus_level',
  ]);
  const swap = capture('sysctl', ['-n', 'vm.swapusage']).stdout;
  const sw = (k) => {
    const m = swap.match(new RegExp(`${k} = ([\\d.]+)([KMG])`));
    return m ? parseFloat(m[1]) * UNITS[m[2].toLowerCase()] : 0;
  };
  const procs = capture('ps', ['-A', '-o', 'pid=']).stdout.split('\n').filter(Boolean).length;
  return {
    memBytes: os.totalmem(),
    ncpu: os.cpus().length,
    loadavg: os.loadavg(),
    memFreePct: s['kern.memorystatus_level'],
    swap: { total: sw('total'), used: sw('used') },
    files: { num: s['kern.num_files'], max: s['kern.maxfiles'], perProc: s['kern.maxfilesperproc'] },
    vnodes: { num: s['kern.num_vnodes'], max: s['kern.maxvnodes'] },
    procs: { num: procs, max: s['kern.maxproc'] },
  };
}

// Every running VM vivary can size from configuration. Apple `container` VMs of
// any origin count (buildkit and the egress proxy are VMs too); tart VMs; and
// Docker Desktop's VM once — docker sandboxes live inside it, so they add
// nothing of their own.
export function runningVmMemory() {
  const vms = [];
  if (hasCmd('container')) {
    const r = capture('container', ['ls', '--format', 'json'], { timeout: 15000 });
    if (r.status === 0) vms.push(...parseContainerLs(r.stdout));
  }
  if (hasCmd('tart')) {
    const r = capture('tart', ['list', '--format', 'json'], { timeout: 15000 });
    let list = [];
    try { list = JSON.parse(r.stdout); } catch { /* none */ }
    for (const vm of list.filter((v) => v.Running || v.State === 'running')) {
      const g = capture('tart', ['get', vm.Name, '--format', 'json'], { timeout: 15000 });
      let info = {};
      try { info = JSON.parse(g.stdout); } catch { /* unknown size */ }
      vms.push({ id: vm.Name, runtime: 'tart', bytes: (Number(info.Memory) || 0) * 1024 ** 2, cpus: info.CPU ?? null });
    }
  }
  if (hasCmd('docker')) {
    const r = capture('docker', ['info', '--format', '{{.MemTotal}} {{.NCPU}}'], { timeout: 5000 });
    const [mem, cpus] = r.status === 0 ? r.stdout.trim().split(/\s+/).map(Number) : [];
    if (mem) vms.push({ id: 'Docker Desktop VM', runtime: 'docker', bytes: mem, cpus });
  }
  return vms;
}

const VM_PROCESS = /Virtualization\.VirtualMachine|com\.docker\.virtualization|com\.docker\.krun|qemu-system/;

// Host-side cost of each VM process: RSS, CPU, and open files — mapped back to
// the container/tart VM it runs.
export function vmProcesses() {
  const ps = capture('ps', ['-axo', 'pid=,rss=,%cpu=,comm=']).stdout;
  const procs = ps.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/))
    .filter((m) => m && VM_PROCESS.test(m[4]))
    .map((m) => ({ pid: Number(m[1]), rss: Number(m[2]) * 1024, cpu: Number(m[3]) }));
  if (!procs.length) return [];
  const pids = procs.map((p) => p.pid).join(',');
  // Who is who: the kernel/disk images are opened first, so fds 0-31 are
  // enough — keeps this call tiny however many files the VM holds.
  const names = parseLsofF(capture('lsof', ['-n', '-P', '-w', '-F', 'pn', '-a', '-p', pids, '-d', '0-31'],
    { timeout: 30000 }).stdout);
  // How many: one 'f' line per fd. Can be 200k+ lines per VM, hence the buffer.
  const counts = parseLsofF(capture('lsof', ['-n', '-P', '-w', '-F', 'f', '-p', pids],
    { timeout: 60000, maxBuffer: 512 * 1024 ** 2 }).stdout);
  return procs.map((p) => {
    const owner = (names.get(p.pid)?.paths || []).map(vmOwnerFromPath).find(Boolean)
      || { kind: 'unknown', id: `VM pid ${p.pid}` };
    return { ...p, owner, fds: counts.get(p.pid)?.fds ?? null };
  });
}

// --- the start gate's wording (pure, so it is testable) -----------------------------

export function formatBudgetRefusal({ name, runtime, mode, requestBytes, committed, budget, total, setting }) {
  const row = (label, rt, bytes) => `      ${label.padEnd(22)} ${rt.padEnd(10)} ${formatBytes(bytes).padStart(9)}`;
  const running = committed.map((vm) => row(displayName({ kind: vm.runtime, id: vm.id }), vm.runtime, vm.bytes));
  return `not starting '${name}': the VMs would be configured for ${formatBytes(total)} of RAM,\n`
    + `    over the ${formatBytes(budget.bytes)} budget (${budget.label}).\n`
    + '    Already running:\n'
    + `${running.length ? running.join('\n') : '      (nothing)'}\n`
    + '    This one:\n'
    + `${row(name, runtime, requestBytes)}\n`
    + '    Make room:   vivary down <name>\n'
    + `    Or smaller:  vivary ${mode} --name ${name} --memory <size> --recreate\n`
    + '                 (a kept container bakes its size in; --recreate rebuilds it)\n'
    + `    The budget:  "memoryBudget" in ~/.vivary/vivary.json, now "${setting}"\n`
    + '    Just once:   --ignore-memory-budget';
}

// Open files are warned about, not enforced: what a VM pins depends on what its
// agent walks AFTER boot, so the count at start predicts little. Being told the
// table is already half full before adding another VM is still worth a line.
export function openFilesWarning(files) {
  if (!files.max || files.num / files.max < 0.5) return null;
  return `WARNING: the Mac's open-file table is ${Math.round((files.num / files.max) * 100)}% full `
    + `(${files.num.toLocaleString('en-US')} / ${files.max.toLocaleString('en-US')}).\n`
    + '    Sandbox VMs hold a host file for everything their guests cache; when the\n'
    + '    table fills, nothing on the Mac can open a file and it can hang. Starting\n'
    + '    anyway. See: vivary stats   Release: vivary stats --trim';
}
