# Tart Provider — Phase 2: tart runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vivary start --runtime tart` boots a macOS guest VM (cloned from a provisioned `vivary-macos-base`), mounts the workspace at the same absolute path, and runs the agent — using the Phase-1 provider seam.

**Architecture:** A new `cli/core/runtimes/tart.mjs` provider (kind `vm-tart`) built from pure argv/helper functions plus a dependency-injected orchestration layer (clone → `tart set` → detached boot → wait IP/agent → `mount_virtiofs` → `tart exec`). A small interface polish on the Phase-1 seam first (provider-owned instance naming, env-object exec contract, `ensureImage(spec)` repositioned) keeps docker/container byte-identical. `vivary build --runtime tart` provisions the base VM from the cirruslabs image using per-agent-plugin `macosProvision` steps. Plugins contribute NOTHING to tart sandboxes in this phase (bare boot + agent; plugin migration is Phase 5).

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` + `node:assert/strict`, `tart` 2.34.0 CLI (Cirrus Labs), macOS guest `cirruslabs/macos-tahoe-base` (user `admin`, passwordless sudo, zsh, brew+node preinstalled).

## Global Constraints

- No behaviour change for `docker`/`container`: same argv byte-for-byte (regression suite is the gate; `cd cli && npm test` currently 41 passing and must stay green, growing with new tests).
- Code + docs in English. ESM `.mjs`, match surrounding style. Tests in `cli/test/`, run via `node --test`.
- Loud failures. Inside `cli/core/runtimes/tart.mjs` and `buildMacosBase`, FAIL BY `throw new Error(...)` — never `die()` — so `vivary.mjs:154`'s `main().catch((e) => die(e.message))` prints it cleanly and tests can `assert.throws`.
- VM naming: per-sandbox VM `vivary-<name>`; base VM `vivary-macos-base` (override: env `SANDBOX_MACOS_BASE`); base source `ghcr.io/cirruslabs/macos-tahoe-base:latest` (override: env `SANDBOX_MACOS_BASE_SRC`).
- tart CLI facts (verified on this host, tart 2.34.0): `tart list --format json` → `[{Name, State, Source: "local"|"OCI", Running: bool}]`; `tart set <vm> --cpu <n> --memory <MB>` (megabytes; flag is `--cpu`, NOT `--cpus`); `tart delete <vm>`; `tart ip <vm> --wait <seconds>` (blocks until IP or timeout); `tart exec [-i] [-t] <vm> <cmd>…` (needs the guest agent; flags separate, not `-it`); `tart run <vm> --no-graphics --dir=<path>[:ro],tag=<T>` is a FOREGROUND process (must be spawned detached); in-guest mount: `sudo /sbin/mount_virtiofs <T> <path>` (full path — not in sudo PATH). Boot→IP ≈ 10 s; guest agent answers a few seconds later.
- Phase 2 scope: bare boot + agent for tart. No plugin runArgs/upArgs/preUp/postUp, no broker env, no egress for tart sandboxes (Phases 3–5). Explicitly gated, with comments saying so.
- Apple caps concurrent macOS guests at ~2: warn (do not die) when booting with ≥2 already running.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. The working tree may hold UNRELATED uncommitted egress WIP — stage ONLY the files each task names; never `git add -A`/`.`/`-a`.

---

### Task 1: Interface polish on the Phase-1 seam (no behaviour change)

**Files:**
- Modify: `cli/core/runtimes/container-cli.mjs` (add `renderExecArgs` + `instanceName`, exec takes env object)
- Modify: `cli/core/runtime.mjs` (add `termEnvVars`, reimplement `termEnvArgs` on top)
- Modify: `cli/core/broker.mjs` (add `brokerEnvVars`, reimplement `brokerEnvArgs` on top)
- Modify: `cli/core/lifecycle.mjs` (makeCtx takes rt; attach paths pass env object + cwd; `ensureImage(spec)` repositioned; cmdDown/cmdRm/cmdList use `rt.instanceName`)
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Consumes: Phase-1 provider (`makeContainerCliRuntime`, `resolveRuntime`, `buildRunSpec`), `containerName` from `runtime.mjs`.
- Produces (later tasks rely on these exact shapes):
  - `renderExecArgs(cname, argv, { interactive?: bool, env?: {K:V} }) -> string[]` (pure, exported)
  - provider method `instanceName(sandboxName) -> string` (container-cli: `containerName(sandboxName)`)
  - provider method `exec(name, argv, { interactive, env: {K:V}, cwd? })` — env is now an OBJECT; container-cli renders `-e K=V` pairs and IGNORES `cwd` (docker/container exec inherit the `-w` set at run time)
  - `termEnvVars() -> {TERM, COLORTERM}` from `runtime.mjs`; `brokerEnvVars(cfg) -> Promise<{}|{SBX_OPEN_URL, SBX_OPEN_TOKEN}>` from `broker.mjs`
  - lifecycle calls `spec.image = rt.ensureImage(spec)` AFTER `buildRunSpec` (container-cli `ensureImage(spec)` already returns `spec.image` — unchanged)

- [ ] **Step 1: Write the failing tests**

```js
// append to cli/test/runtime-provider.test.mjs
import { renderExecArgs } from '../core/runtimes/container-cli.mjs';

test('renderExecArgs reproduces the legacy attach argv (env object -> -e pairs)', () => {
  const argv = renderExecArgs('claude-sandbox-demo', ['claude', '--resume'], {
    interactive: true,
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', SBX_OPEN_URL: 'http://x/' },
  });
  assert.deepEqual(argv, [
    'exec', '-it',
    '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor', '-e', 'SBX_OPEN_URL=http://x/',
    'claude-sandbox-demo', 'claude', '--resume',
  ]);
});

test('renderExecArgs non-interactive omits -it; empty env adds nothing', () => {
  assert.deepEqual(renderExecArgs('c', ['bash'], {}), ['exec', 'c', 'bash']);
});

test('container-cli instanceName is the legacy containerName', () => {
  assert.equal(resolveRuntime('docker').instanceName('demo'), 'claude-sandbox-demo');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — `renderExecArgs` is not exported / `instanceName` undefined.

- [ ] **Step 3: Implement in `container-cli.mjs`**

Add the pure renderer, rewire `exec`, add `instanceName`:

```js
// Renders the `exec` argv for docker/Apple `container`. env is an object;
// cwd is accepted for interface parity but ignored — these CLIs inherit the
// working dir set by `run -w`.
export function renderExecArgs(cname, argv, { interactive = false, env = {} } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['exec', ...(interactive ? ['-it'] : []), ...envArgs, cname, ...argv];
}
```

Inside `makeContainerCliRuntime`, replace the `exec` method and add `instanceName`:

```js
    instanceName(sandboxName) { return containerName(sandboxName); },
    exec(cname, argv, opts = {}) {
      return runInherit(name, renderExecArgs(cname, argv, opts));
    },
```

- [ ] **Step 4: Add `termEnvVars` (runtime.mjs) and `brokerEnvVars` (broker.mjs)**

In `cli/core/runtime.mjs` replace the existing `termEnvArgs` block with:

```js
// Pass the host terminal's capabilities, otherwise the TUI degrades to 16
// colors (illegible menus on themed terminals).
export function termEnvVars() {
  return {
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
  };
}

export function termEnvArgs() {
  return Object.entries(termEnvVars()).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}
```

In `cli/core/broker.mjs` replace `brokerEnvArgs` with:

```js
// Broker announcement for the sandbox (when any enabled plugin needs it) —
// as an env object; brokerEnvArgs renders the docker-args form.
export async function brokerEnvVars(cfg) {
  const needed = getPlugins().some((p) => p.needsBroker?.(cfg));
  if (!needed) return {};
  const { url } = await ensureBroker();
  return { SBX_OPEN_URL: url, SBX_OPEN_TOKEN: sandboxBrokerToken(cfg.name) };
}

export async function brokerEnvArgs(cfg) {
  return Object.entries(await brokerEnvVars(cfg)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}
```

- [ ] **Step 5: Rewire `lifecycle.mjs`**

`makeCtx` gains the provider (cname becomes provider-owned):

```js
function makeCtx(cfg, flags, mode, rt) {
  return {
    cfg,
    flags,
    mode, // 'start' | 'up' | 'shell'
    dir: sandboxDir(cfg.name),
    runtime: cfg.runtime,
    cname: rt.instanceName(cfg.name),
    HOME,
    log: (msg) => console.log(msg),
  };
}
```

`cmdStart` — resolve rt first, env object + cwd on attach, ensureImage after buildRunSpec:

```js
  const rt = resolveRuntime(cfg.runtime);
  const ctx = makeCtx(cfg, flags, 'start', rt);
  if (rt.isRunning(cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    process.exit(rt.exec(ctx.cname, [agent.cmd, ...rest], {
      interactive: IS_TTY,
      env: { ...termEnvVars(), ...(await brokerEnvVars(cfg)) },
      cwd: cfg.workspace,
    }));
  }
  console.log(`==> Runtime: ${cfg.runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image: IMAGE, command: [agent.cmd, ...rest], termEnv: termEnvArgs(),
  });
  spec.image = rt.ensureImage(spec);
  process.exit(rt.run(spec));
```

`cmdShell` — same shape (command `['bash']`, attach env object + cwd, ensureImage after buildRunSpec). `cmdUp` — `const rt = resolveRuntime(cfg.runtime); const ctx = makeCtx(cfg, flags, 'up', rt);`, then after building the spec: `spec.image = rt.ensureImage(spec);` (replacing the pre-spec `const image = rt.ensureImage({ image: IMAGE })` and passing `image: IMAGE` into buildRunSpec). `cmdDown`: `rt.stop(rt.instanceName(name))`. `cmdRm`: `const cname = rt.instanceName(name);` (move the line below `resolveRuntime`). `cmdList` status row becomes:

```js
    const rt = running[cfg.runtime] ? resolveRuntime(cfg.runtime) : null;
    const status = rt && running[cfg.runtime].has(rt.instanceName(name)) ? 'running' : 'stopped';
```

Update imports: `termEnvVars` from `./runtime.mjs`, `brokerEnvVars` from `./broker.mjs` (keep `termEnvArgs`, `brokerEnvArgs` — still used for `buildRunSpec`'s termEnv and by spec.mjs). Drop the now-unused `containerName` import ONLY if nothing in the file still references it after the rewire (check before removing).

- [ ] **Step 6: Run the full suite**

Run: `cd cli && npm test`
Expected: PASS, count ≥ 44 (41 + 3 new). All pre-existing argv regression tests must be untouched and green — they prove docker/container argv did not change.

- [ ] **Step 7: Commit**

```bash
git add cli/core/runtimes/container-cli.mjs cli/core/runtime.mjs cli/core/broker.mjs cli/core/lifecycle.mjs cli/test/runtime-provider.test.mjs
git commit -m "refactor(runtime): provider-owned naming + env-object exec contract

instanceName() moves container naming into the provider, exec takes an env
object (rendered to -e pairs by container-cli; tart will inject via env(1)),
ensureImage(spec) runs after buildRunSpec. No behaviour change for
docker/container — attach argv is byte-identical (renderExecArgs test).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: tart pure helpers

**Files:**
- Create: `cli/core/runtimes/tart.mjs` (pure part only)
- Test: `cli/test/tart-runtime.test.mjs` (new file)

**Interfaces:**
- Produces (exact, used by Tasks 3+5):
  - `tartVmName(sandboxName) -> 'vivary-<name>'`
  - `parseMemoryMb(str) -> number` — `'4g'→4096`, `'2048m'→2048`, `'512'→512` (bare = MB); throws on garbage
  - `shq(s) -> string` — POSIX single-quote escaping
  - `envPairsToObject(['-e','K=V',...]) -> {K:V}`
  - `buildTartRunArgv(spec) -> string[]` — `['run', spec.name, '--no-graphics', '--dir=<host>[:ro],tag=ws<i>'…]` (mount i gets tag `ws<i>`)
  - `buildGuestExecArgv(vm, argv, { interactive, env, cwd }) -> string[]` — `['exec', ('-i','-t')?, vm, '/usr/bin/env', 'K=V'…, '/bin/zsh', '-lc', 'cd <cwd> && exec <argv…>']`

- [ ] **Step 1: Write the failing tests**

```js
// cli/test/tart-runtime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGuestExecArgv, buildTartRunArgv, envPairsToObject, parseMemoryMb, shq, tartVmName,
} from '../core/runtimes/tart.mjs';

test('tartVmName prefixes vivary-', () => {
  assert.equal(tartVmName('demo'), 'vivary-demo');
});

test('parseMemoryMb converts docker-style values to megabytes', () => {
  assert.equal(parseMemoryMb('4g'), 4096);
  assert.equal(parseMemoryMb('2048m'), 2048);
  assert.equal(parseMemoryMb('512'), 512);
  assert.throws(() => parseMemoryMb('lots'), /cannot parse memory/);
});

test('shq single-quotes and escapes embedded quotes', () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq("it's"), "'it'\\''s'");
});

test('envPairsToObject parses docker -e pairs', () => {
  assert.deepEqual(
    envPairsToObject(['-e', 'TERM=xterm', '-e', 'A=b=c']),
    { TERM: 'xterm', A: 'b=c' },
  );
  assert.deepEqual(envPairsToObject([]), {});
});

test('buildTartRunArgv renders headless run with indexed ws tags', () => {
  const argv = buildTartRunArgv({
    name: 'vivary-demo',
    mounts: [{ host: '/w/demo', guest: '/w/demo' }, { host: '/x', guest: '/x', ro: true }],
  });
  assert.deepEqual(argv, [
    'run', 'vivary-demo', '--no-graphics',
    '--dir=/w/demo:tag=ws0',
    '--dir=/x:ro,tag=ws1',
  ]);
});

test('buildGuestExecArgv wraps command in a login shell with env + cwd', () => {
  const argv = buildGuestExecArgv('vivary-demo', ['claude', '--version'], {
    interactive: true,
    env: { TERM: 'xterm', SBX_SANDBOX_NAME: 'demo' },
    cwd: '/w/de mo',
  });
  assert.deepEqual(argv, [
    'exec', '-i', '-t', 'vivary-demo',
    '/usr/bin/env', 'TERM=xterm', 'SBX_SANDBOX_NAME=demo',
    '/bin/zsh', '-lc', "cd '/w/de mo' && exec 'claude' '--version'",
  ]);
});

test('buildGuestExecArgv non-interactive, no cwd', () => {
  assert.deepEqual(
    buildGuestExecArgv('vm', ['true'], {}),
    ['exec', 'vm', '/usr/bin/env', '/bin/zsh', '-lc', "exec 'true'"],
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/tart-runtime.test.mjs`
Expected: FAIL — `Cannot find module '../core/runtimes/tart.mjs'`.

- [ ] **Step 3: Implement the pure part of `cli/core/runtimes/tart.mjs`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && node --test test/tart-runtime.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/core/runtimes/tart.mjs cli/test/tart-runtime.test.mjs
git commit -m "feat(runtime): tart pure helpers (naming, memory, quoting, argv builders)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: tart provider — DI orchestration + factory wiring

**Files:**
- Modify: `cli/core/runtimes/tart.mjs` (append the impure part)
- Modify: `cli/core/runtimes/index.mjs` (wire `tart`, add `runtimeKind`)
- Test: `cli/test/tart-runtime.test.mjs` (extend), `cli/test/runtime-provider.test.mjs` (replace the Phase-2 stub test)

**Interfaces:**
- Consumes: Task-2 helpers; `capture`, `runInherit`, `hasCmd`, `SANDBOXES_DIR` from `../util.mjs`.
- Produces:
  - `makeTartRuntime(deps?) -> Runtime` where `deps = { capture?, runInherit?, spawnDetached?, sleep? }` (all optional; defaults are the real implementations). Provider shape: `{ name:'tart', kind:'vm-tart', instanceName, ensureImage(spec), run(spec,{detached}), exec(vm,argv,{interactive,env,cwd}), stop(vm), rm(vm), purge(vm), isRunning(sandboxName), runningSet(), ip(vm) }`
  - `waitForVm(vm, deps?) -> ip` and `bootVm(vm, { mounts, …deps }) -> ip` (exported; Task 5 reuses them)
  - `tartLogFile(vm) -> ~/.vivary/.tart/<vm>.log`
  - `MACOS_BASE` constant: `process.env.SANDBOX_MACOS_BASE || 'vivary-macos-base'`
  - `resolveRuntime('tart')` returns the provider; `runtimeKind(name) -> 'vm-tart' | 'container-cli'` exported from `index.mjs`
- Error style: THROW `Error` (never `die`) — `vivary.mjs` catches and prints.

- [ ] **Step 1: Write the failing tests**

```js
// append to cli/test/tart-runtime.test.mjs
import { makeTartRuntime, MACOS_BASE } from '../core/runtimes/tart.mjs';

// Scripted capture: returns queued results per (cmd,args-prefix) matcher and
// records every call for order assertions.
function fakeIo({ listResults, results = {} }) {
  const calls = [];
  let listCalls = 0;
  const capture = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listResults[Math.min(listCalls++, listResults.length - 1)]), stderr: '' };
    return results[key] || { status: 0, stdout: '', stderr: '' };
  };
  const spawned = [];
  return {
    calls, spawned,
    deps: {
      capture,
      runInherit: (cmd, args) => { calls.push(['RUN', cmd, ...args]); return 0; },
      spawnDetached: (argv, log) => { spawned.push(argv); calls.push(['SPAWN', ...argv]); },
      sleep: () => {},
    },
  };
}

const stoppedVm = (name) => ({ Name: name, Source: 'local', Running: false, State: 'stopped' });
const runningVm = (name) => ({ Name: name, Source: 'local', Running: true, State: 'running' });

test('ensureImage dies loudly when the base VM is missing', () => {
  const io = fakeIo({ listResults: [[]] });
  const rt = makeTartRuntime(io.deps);
  assert.throws(() => rt.ensureImage({ name: 'vivary-demo', memory: '4g', cpus: '4' }),
    /vivary build --runtime tart/);
});

test('ensureImage clones from base and applies tart set when stopped', () => {
  const io = fakeIo({ listResults: [
    [stoppedVm(MACOS_BASE)],                                 // first list: no sandbox VM
    [stoppedVm(MACOS_BASE), stoppedVm('vivary-demo')],       // after clone
  ] });
  const rt = makeTartRuntime(io.deps);
  assert.equal(rt.ensureImage({ name: 'vivary-demo', memory: '4g', cpus: '4' }), 'vivary-demo');
  assert.ok(io.calls.some((c) => c.join(' ') === `tart clone ${MACOS_BASE} vivary-demo`));
  assert.ok(io.calls.some((c) => c.join(' ') === 'tart set vivary-demo --cpu 4 --memory 4096'));
});

test('run boots, waits for IP + agent, mounts workspace, then execs the command', () => {
  const io = fakeIo({
    listResults: [[stoppedVm('vivary-demo')]],
    results: { 'ip vivary-demo': { status: 0, stdout: '192.168.65.2\n', stderr: '' } },
  });
  const rt = makeTartRuntime(io.deps);
  const spec = {
    name: 'vivary-demo', interactive: true, cwd: '/w/demo',
    mounts: [{ host: '/w/demo', guest: '/w/demo' }],
    env: { SBX_SANDBOX_NAME: 'demo' },
    termEnv: ['-e', 'TERM=xterm'],
    command: ['claude', '--version'],
  };
  const status = rt.run(spec);
  assert.equal(status, 0);
  const flat = io.calls.map((c) => c.join(' '));
  const iSpawn = flat.findIndex((c) => c.startsWith('SPAWN run vivary-demo --no-graphics'));
  const iIp = flat.findIndex((c) => c.startsWith('tart ip vivary-demo'));
  const iAgent = flat.findIndex((c) => c === 'tart exec vivary-demo true');
  const iMount = flat.findIndex((c) => c === 'tart exec vivary-demo sudo /sbin/mount_virtiofs ws0 /w/demo');
  const iExec = flat.findIndex((c) => c.startsWith('RUN tart exec -i -t vivary-demo /usr/bin/env TERM=xterm SBX_SANDBOX_NAME=demo'));
  assert.ok(iSpawn >= 0 && iSpawn < iIp && iIp < iAgent && iAgent < iMount && iMount < iExec,
    `boot order wrong: ${JSON.stringify(flat)}`);
});

test('run detached skips the exec; run on an already-running VM skips the boot', () => {
  const io = fakeIo({ listResults: [[runningVm('vivary-demo')]] });
  const rt = makeTartRuntime(io.deps);
  const r = rt.run({ name: 'vivary-demo', mounts: [], env: {}, command: ['x'] }, { detached: true });
  assert.deepEqual(r, { status: 0 });
  assert.ok(!io.calls.some((c) => c[0] === 'SPAWN'), 'must not boot a running VM');
});

test('isRunning/runningSet/purge/stop map to tart CLI', () => {
  const io = fakeIo({ listResults: [[runningVm('vivary-demo'), stoppedVm('vivary-other')]] });
  const rt = makeTartRuntime(io.deps);
  assert.equal(rt.isRunning('demo'), true);
  assert.ok(rt.runningSet().has('vivary-demo'));
  rt.stop('vivary-demo');
  rt.purge('vivary-demo');
  const flat = io.calls.map((c) => c.join(' '));
  assert.ok(flat.includes('tart stop vivary-demo'));
  assert.ok(flat.includes('tart delete vivary-demo'));
});
```

And in `cli/test/runtime-provider.test.mjs`, REPLACE the Phase-2 stub test

```js
test('resolveRuntime(tart) fails with a phase-2 hint, not unknown-runtime', () => {
  assert.throws(() => resolveRuntime('tart'), /Phase 2|not yet/i);
});
```

with:

```js
test('resolveRuntime(tart) returns the vm-tart provider', () => {
  const rt = resolveRuntime('tart');
  assert.equal(rt.name, 'tart');
  assert.equal(rt.kind, 'vm-tart');
  assert.equal(rt.instanceName('demo'), 'vivary-demo');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/tart-runtime.test.mjs test/runtime-provider.test.mjs`
Expected: FAIL — `makeTartRuntime` not exported; stub test replacement fails (still throws).

- [ ] **Step 3: Append the impure part to `cli/core/runtimes/tart.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  SANDBOXES_DIR, capture as realCapture, hasCmd, runInherit as realRunInherit,
} from '../util.mjs';

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
      if (!hasCmd('tart')) throw new Error("'tart' not found on PATH (brew install cirruslabs/cli/tart)");
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
```

- [ ] **Step 4: Wire the factory — `cli/core/runtimes/index.mjs` becomes:**

```js
import { makeContainerCliRuntime } from './container-cli.mjs';
import { makeTartRuntime } from './tart.mjs';

export function runtimeKind(name) {
  return name === 'tart' ? 'vm-tart' : 'container-cli';
}

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  if (name === 'tart') return makeTartRuntime();
  throw new Error(`unknown runtime '${name}' (docker, container, tart)`);
}
```

- [ ] **Step 5: Run the full suite**

Run: `cd cli && npm test`
Expected: PASS (≥ 49: 44 + 5 new tart tests, stub test replaced not added).

- [ ] **Step 6: Commit**

```bash
git add cli/core/runtimes/tart.mjs cli/core/runtimes/index.mjs cli/test/tart-runtime.test.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): tart provider — clone/set/boot/mount/exec orchestration

DI'd io (capture/runInherit/spawnDetached/sleep) makes the boot pipeline
unit-testable; resolveRuntime('tart') replaces the Phase-2 stub.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: lifecycle vm-tart integration (spec gate, plugin-hook gate, rm/purge semantics, ls)

**Files:**
- Modify: `cli/core/runtimes/spec.mjs` (vm gate)
- Modify: `cli/core/lifecycle.mjs` (cmdUp hook gating, cmdRm purge + kind messages, cmdList tart row)
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Consumes: `runtimeKind` from `./runtimes/index.mjs` (Task 3), provider `purge?()` + `kind` (Task 3).
- Produces: for `runtime === 'tart'`, `buildRunSpec` yields `mounts=[workspace only]`, `extraArgs=[]`, `capsAll=false`, `init=false` — plugins and broker contribute NOTHING (Phase-5 migrates plugins to structured intent; this gate carries a comment saying so).

- [ ] **Step 1: Write the failing tests**

```js
// append to cli/test/runtime-provider.test.mjs
test('buildRunSpec for tart: workspace-only mounts, no plugin/broker args', async () => {
  const trap = [{ runArgs: () => { throw new Error('plugins must not run for tart'); }, needsCaps: () => true }];
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'tart' },
    flags: {}, dir: '/state/demo', cname: 'vivary-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: true, image: 'ignored', command: ['claude'],
    plugins: trap, brokerEnv: async () => { throw new Error('broker must not run for tart'); },
  });
  assert.deepEqual(spec.mounts, [{ host: '/w/demo', guest: '/w/demo' }]);
  assert.deepEqual(spec.extraArgs, []);
  assert.equal(spec.capsAll, false);
  assert.equal(spec.init, false);
  assert.equal(spec.name, 'vivary-demo');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — the trap plugin throws (plugins currently always run).

- [ ] **Step 3: Gate `buildRunSpec` (spec.mjs)**

```js
import path from 'node:path';
import { getPlugins } from '../plugins.mjs';
import { brokerEnvArgs } from '../broker.mjs';
import { runtimeKind } from './index.mjs';

export async function buildRunSpec(ctx, {
  rm, interactive, image, command = [], termEnv = [],
  plugins = getPlugins(), brokerEnv = brokerEnvArgs,
} = {}) {
  const { cfg, flags, dir } = ctx;
  const runtime = cfg.runtime;
  // vm-tart sandboxes take NO plugin/broker contributions in Phase 2 — the
  // extraArgs escape hatch is docker-shaped, and host integration for macOS
  // guests lands in later phases (plugin migration to structured intent).
  const vm = runtimeKind(runtime) === 'vm-tart';
  const extraArgs = [];
  if (!vm) {
    for (const p of plugins) {
      if (p.runArgs) extraArgs.push(...(await p.runArgs(ctx) || []));
    }
    extraArgs.push(...(await brokerEnv(cfg)));
  }
  return {
    name: ctx.cname,
    image,
    cwd: cfg.workspace,
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    rm, interactive,
    mounts: vm
      ? [{ host: cfg.workspace, guest: cfg.workspace }]
      : [
          { host: path.join(dir, 'dot-config'), guest: '/home/agent/.config' },
          { host: cfg.workspace, guest: cfg.workspace },
        ],
    env: { SBX_SANDBOX_NAME: cfg.name },
    init: !vm && runtime === 'docker',
    capsAll: !vm && runtime !== 'docker' && plugins.some((p) => p.needsCaps?.(cfg)),
    extraArgs,
    termEnv,
    command,
  };
}
```

- [ ] **Step 4: Gate plugin hooks + rm/purge/messages in `lifecycle.mjs`**

Import `runtimeKind` alongside `resolveRuntime`. In `cmdUp`, gate all three plugin loops:

```js
  const vm = runtimeKind(cfg.runtime) === 'vm-tart';
  // vm-tart: no plugin hooks in Phase 2 (hooks assume a Linux container).
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.preUp) await p.preUp(ctx);
    }
  }
```

…the `upArgs` loop and the `postUp` loop get the same `if (!vm)` guard (the existing cap-add reorder comment stays with the upArgs loop). In `cmdRm`, make removal kind-aware and honor purge:

```js
  if (rt.kind === 'vm-tart') {
    console.log(`==> macOS VM '${cname}' kept — its disk holds the sandbox state (logins, chats).`);
  } else {
    rt.rm(cname);
    console.log(`==> Container removed. Chat history remains in ${path.join(HOME, '.claude/projects')}.`);
  }
```

…and inside the purge-confirmed branch, BEFORE the plugin `onPurge` loop:

```js
      if (rt.purge) {
        rt.purge(cname);
        console.log(`==> macOS VM '${cname}' deleted.`);
      }
```

In `cmdList`, add tart to the running map (guard: constructing the provider is safe, `runningSet()` returns an empty set when the CLI is missing):

```js
  const running = {
    docker: resolveRuntime('docker').runningSet(),
    container: resolveRuntime('container').runningSet(),
    tart: resolveRuntime('tart').runningSet(),
  };
```

- [ ] **Step 5: Run the full suite**

Run: `cd cli && npm test`
Expected: PASS (all prior container/docker regression tests untouched and green — the vm gate must not change non-tart output; ≥ 50 tests).

- [ ] **Step 6: Commit**

```bash
git add cli/core/runtimes/spec.mjs cli/core/lifecycle.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): vm-tart lifecycle — spec gate, hook gate, VM-keeping rm

tart sandboxes get workspace-only specs (no plugin/broker args), skip
container-shaped plugin hooks, keep the VM on rm (its disk is the state)
and delete it on --purge. vivary ls now shows tart sandboxes' state.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `vivary build --runtime tart` — provision `vivary-macos-base`

**Files:**
- Modify: `cli/core/build.mjs` (arg parsing + `buildMacosBase` + `collectMacosProvision`)
- Modify: `cli/plugins/agent-claude/plugin.mjs`, `cli/plugins/agent-codex/plugin.mjs`, `cli/plugins/agent-cursor/plugin.mjs` (add `macosProvision`)
- Modify: `cli/vivary.mjs` (help text for build)
- Test: `cli/test/tart-runtime.test.mjs` (extend)

**Interfaces:**
- Consumes: `bootVm`, `waitForVm`, `tartLogFile`, `MACOS_BASE` from `./runtimes/tart.mjs` (Task 3); `getPlugins`, `parseArgs`, `hasCmd`, `capture`, `runInherit`, `die`.
- Produces: `collectMacosProvision(plugins) -> [{ plugin, line }]` (pure, exported); plugin field `macosProvision: string[]` (shell lines run in the base VM via a login zsh during build).

- [ ] **Step 1: Write the failing test**

```js
// append to cli/test/tart-runtime.test.mjs
import { collectMacosProvision } from '../core/build.mjs';

test('collectMacosProvision flattens plugin steps in plugin order', () => {
  const plugins = [
    { name: 'a', macosProvision: ['echo one', 'echo two'] },
    { name: 'b' },
    { name: 'c', macosProvision: ['echo three'] },
  ];
  assert.deepEqual(collectMacosProvision(plugins), [
    { plugin: 'a', line: 'echo one' },
    { plugin: 'a', line: 'echo two' },
    { plugin: 'c', line: 'echo three' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/tart-runtime.test.mjs`
Expected: FAIL — `collectMacosProvision` not exported.

- [ ] **Step 3: Implement in `build.mjs`**

Extend imports (`parseArgs`, `capture` from `./util.mjs`; `bootVm`, `tartLogFile`, `MACOS_BASE` from `./runtimes/tart.mjs`) and add:

```js
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
```

Change `cmdBuild` to branch (existing Docker path stays untouched below the branch):

```js
export function cmdBuild(argv = []) {
  const { flags } = parseArgs(argv, { runtime: 'string', force: 'boolean' });
  if (flags.runtime === 'tart') return buildMacosBase({ force: flags.force });
  const runtime = detectRuntime();
  // ... (existing body unchanged)
```

- [ ] **Step 4: Add `macosProvision` to the three agent plugins**

In each plugin's exported object (next to `agents`/`launchers`; mirror the Linux `image.dockerfile` installers — claude's npm form is spike-verified in a macOS guest):

```js
// agent-claude/plugin.mjs
  macosProvision: ['npm install -g @anthropic-ai/claude-code'],
// agent-codex/plugin.mjs
  macosProvision: ['npm install -g @openai/codex'],
// agent-cursor/plugin.mjs
  macosProvision: ['curl -fsSL https://cursor.com/install | bash'],
```

- [ ] **Step 5: Update the build help line in `cli/vivary.mjs`**

Replace the `build` help line with:

```
  build                Build the container image (core + all plugins).
                       --runtime tart [--force]: build the macOS base VM
                       (vivary-macos-base) that tart sandboxes clone.
```

- [ ] **Step 6: Run the full suite**

Run: `cd cli && npm test`
Expected: PASS (≥ 51). `node -e "import('./cli/core/build.mjs').then(()=>console.log('ok'))"` from the repo root must print `ok`.

- [ ] **Step 7: Commit**

```bash
git add cli/core/build.mjs cli/plugins/agent-claude/plugin.mjs cli/plugins/agent-codex/plugin.mjs cli/plugins/agent-cursor/plugin.mjs cli/vivary.mjs cli/test/tart-runtime.test.mjs
git commit -m "feat(build): vivary build --runtime tart provisions the macOS base VM

Clones the cirruslabs tahoe base, boots it open-network, runs each agent
plugin's macosProvision step (claude npm install spike-verified), stops.
Sandboxes clone the result copy-on-write on first start.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (controller/human — NOT a subagent task)

Live smoke on this host (tart installed, cirruslabs OCI image cached). Mind the ~2 concurrent macOS VM cap — check `tart list` for other running VMs first and coordinate with the user.

```bash
node cli/vivary.mjs build --runtime tart          # clone + boot + 3 provision steps + stop (~3-5 min)
WS=$(mktemp -d); echo hi > "$WS/hello.txt"
node cli/vivary.mjs start --name tartsmoke --workspace "$WS" --runtime tart -- --version
                                                  # clone vivary-tartsmoke, set, boot, mount, claude --version, exit 0
node cli/vivary.mjs ls                            # tartsmoke ... tart running
tart exec vivary-tartsmoke ls "$WS"               # hello.txt  (same-path mount)
node cli/vivary.mjs start --name tartsmoke -- --version   # attach path (VM already running)
node cli/vivary.mjs down tartsmoke                # tart stop
node cli/vivary.mjs rm tartsmoke                  # VM kept message; tart list still shows vivary-tartsmoke
node cli/vivary.mjs rm tartsmoke --purge          # VM deleted + state purged
```

Expected: every step exits 0; `claude --version` prints from the macOS guest; direct `tart list` confirms VM lifecycle. Also re-run a docker/container boot smoke (`node cli/vivary.mjs start --name dockersmoke --workspace "$WS" -- --version` with the default runtime) to confirm zero regression.

## Self-Review

**Spec coverage (design §4.1–§4.3, §9 phase 2):** provider interface + tart translation ✓ (Tasks 1–3); `vivary build` → `vivary-macos-base` with per-agent-plugin steps ✓ (Task 5); lifecycle mapping (up=detached boot, start=boot+exec, down=stop, same-path workspace, `tart set` mem/cpu, APFS clone) ✓ (Tasks 3–4); ≥2-VM warning ✓ (Task 3 `bootVm`). Egress (§4.4), host integration (§4.5), plugin migration (§4.6) are Phases 3–5 — explicitly gated with comments, not gaps. Chat-history mount (§4.3) is listed under host integration in §9 phase 4 — deferred with it.

**Placeholder scan:** none — every step carries complete code and exact commands.

**Type consistency:** `makeTartRuntime(deps)`, `buildTartRunArgv(spec)`, `buildGuestExecArgv(vm, argv, {interactive, env, cwd})`, `envPairsToObject(pairs)`, `parseMemoryMb(s)`, `tartVmName(name)`, `waitForVm(vm, deps)`, `bootVm(vm, opts)`, `collectMacosProvision(plugins)`, `renderExecArgs(cname, argv, {interactive, env})`, `runtimeKind(name)` — signatures match across Tasks 1–5. Provider method set matches the Phase-1 interface plus `instanceName`/`purge`; `exec` env-object change lands in Task 1 before tart consumes it in Task 3.

**Known intentional deviations from the design doc:** (a) spec §4.1 said plugins default to `runtimes: [all]` — this phase instead gates ALL plugin contributions off for vm-tart (the extraArgs escape hatch is docker-shaped; per-plugin opt-in arrives with the Phase-5 intent migration); (b) `tart set` uses `--cpu` (tart's actual flag), not `--cpus` as sketched in the design.
