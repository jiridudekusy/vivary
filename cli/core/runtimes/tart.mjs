// tart (Cirrus Labs) runtime provider: macOS guest VMs. Pure argv builders
// live at the top (regression-testable); the DI'd orchestration follows.
//
// tart facts this file relies on (verified, tart 2.34.0): `list --format
// json`; `set --cpu N --memory MB`; `ip --wait s`; `exec [-i] [-t]` via the
// guest agent; `run` is foreground (spawned detached here); virtiofs shares
// mount in-guest with `sudo /sbin/mount_virtiofs <tag> <path>`.

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
