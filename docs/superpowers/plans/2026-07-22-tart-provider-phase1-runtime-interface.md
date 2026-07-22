# Tart Provider — Phase 1: Runtime provider interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract vivary's runtime invocation into a provider interface driven by a structured `RunSpec`, with `docker` and `container` reproducing today's exact commands (no behaviour change), creating the seam the tart provider plugs into in Phase 2.

**Architecture:** Introduce `cli/core/runtimes/`: a pure `RunSpec` → argv renderer (`container-cli.mjs`), a provider object wrapping `capture`/`runInherit`, and a `resolveRuntime(name)` factory. `lifecycle.mjs` builds a `RunSpec` (instead of an inline argv array) and calls the provider. Plugins are NOT migrated in this phase — their existing `runArgs`/`upArgs` arrays are collected into `spec.extraArgs`/`spec.extraUpArgs` and appended verbatim by the container-cli renderer, so behaviour is byte-identical. The full plugin→intent migration is deferred to later phases (per-plugin, as tart needs each).

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` + `node:assert`, `node:child_process` (`spawnSync`, already wrapped in `util.mjs`).

## Global Constraints

- Language: code + docs in English (converse with user in Czech). — from repo CLAUDE.md.
- No behaviour change for `docker`/`container` in this phase: the argv the provider emits MUST equal today's argv (regression tests are the gate).
- ESM only (`.mjs`), Node ≥ 18 (uses `node:test`). Match surrounding code style (2-space indent, no semicolons omitted — follow existing files).
- Loud failures, never silent (`die()` on unresolved runtime).
- Tests live in `cli/test/`, run via `cd cli && npm test` (`node --test`).
- Runtime names in play: `docker`, `container` (this phase), `tart` (Phase 2, stubbed here).

---

### Task 1: `RunSpec` shape + container-cli argv renderer (pure)

**Files:**
- Create: `cli/core/runtimes/container-cli.mjs`
- Test: `cli/test/runtime-provider.test.mjs`

**Interfaces:**
- Produces: `renderRunArgs(spec, { runtime }) -> string[]` where `spec` is a
  `RunSpec` object with fields:
  `{ name, image, cwd, memory, cpus, rm:bool, interactive:bool, mounts:[{host,guest,ro?}], env:{[k]:string}, capsAll:bool, init:bool, extraArgs:string[], termEnv:string[], command:string[] }`.
  Returns the full argv AFTER the runtime binary (i.e. starting at `run`).

- [ ] **Step 1: Write the failing test** (docker case, mirrors today's `cmdStart` run argv)

```js
// cli/test/runtime-provider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunArgs } from '../core/runtimes/container-cli.mjs';

const baseSpec = {
  name: 'claude-sandbox-demo',
  image: 'agent-sandbox-agents',
  cwd: '/Users/jdk/work/demo',
  memory: '4g',
  cpus: '4',
  rm: true,
  interactive: true,
  mounts: [
    { host: '/Users/jdk/.vivary/demo/dot-config', guest: '/home/agent/.config' },
    { host: '/Users/jdk/work/demo', guest: '/Users/jdk/work/demo' },
  ],
  env: { SBX_SANDBOX_NAME: 'demo' },
  capsAll: false,
  init: true,
  extraArgs: ['-e', 'SBX_OPEN_URL=http://host.docker.internal:7377/'],
  termEnv: ['-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor'],
  command: ['claude'],
};

test('docker run argv matches the legacy layout', () => {
  const argv = renderRunArgs(baseSpec, { runtime: 'docker' });
  assert.deepEqual(argv, [
    'run', '--rm', '-it',
    '--name', 'claude-sandbox-demo',
    '--memory', '4g',
    '--cpus', '4',
    '-v', '/Users/jdk/.vivary/demo/dot-config:/home/agent/.config',
    '-v', '/Users/jdk/work/demo:/Users/jdk/work/demo',
    '-e', 'SBX_SANDBOX_NAME=demo',
    '-w', '/Users/jdk/work/demo',
    '--init',
    '-e', 'SBX_OPEN_URL=http://host.docker.internal:7377/',
    '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
    'agent-sandbox-agents', 'claude',
  ]);
});

test('container run argv omits --init and adds --cap-add ALL when capsAll', () => {
  const argv = renderRunArgs({ ...baseSpec, init: false, capsAll: true }, { runtime: 'container' });
  assert.ok(!argv.includes('--init'), 'no --init for container');
  const i = argv.indexOf('--cap-add');
  assert.equal(argv[i + 1], 'ALL');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — `Cannot find module '../core/runtimes/container-cli.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// cli/core/runtimes/container-cli.mjs
// Renders a RunSpec into the docker/Apple-`container` `run` argv. Kept a pure
// function so it can be regression-tested against the legacy layout.

export function renderRunArgs(spec, { runtime }) {
  const argv = ['run'];
  if (spec.rm) argv.push('--rm');
  if (spec.interactive) argv.push('-it');
  argv.push('--name', spec.name);
  if (spec.memory) argv.push('--memory', spec.memory);
  if (spec.cpus) argv.push('--cpus', spec.cpus);
  for (const m of spec.mounts || []) {
    argv.push('-v', `${m.host}:${m.guest}${m.ro ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(spec.env || {})) {
    argv.push('-e', `${k}=${v}`);
  }
  if (spec.cwd) argv.push('-w', spec.cwd);
  // Docker needs --init for signal reaping; Apple `container` does not.
  if (spec.init && runtime === 'docker') argv.push('--init');
  argv.push(...(spec.extraArgs || []));
  // Apple `container` strips caps by default; add ALL when a plugin needs it.
  if (spec.capsAll && runtime !== 'docker') argv.push('--cap-add', 'ALL');
  argv.push(...(spec.termEnv || []));
  argv.push(spec.image, ...(spec.command || []));
  return argv;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/core/runtimes/container-cli.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): pure container-cli RunSpec renderer + regression tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Provider object + `resolveRuntime` factory

**Files:**
- Create: `cli/core/runtimes/index.mjs`
- Modify: `cli/core/runtimes/container-cli.mjs` (add the provider factory)
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Consumes: `renderRunArgs` (Task 1); `capture`, `runInherit` from `../../core/util.mjs`; `containerName`, `runningSet` from `../../core/runtime.mjs`.
- Produces:
  - `makeContainerCliRuntime(name) -> Runtime`
  - `resolveRuntime(name) -> Runtime` — throws via `die` on unknown name.
  - `Runtime` object: `{ name, kind:'container-cli', runArgv(spec), run(spec,{detached}), exec(cname,argv,{interactive,env}), stop(cname), rm(cname), isRunning(name), runningSet(), ip(cname), ensureImage(spec) }`.
  - For container-cli: `runArgv(spec)` returns `renderRunArgs(spec,{runtime:name})`; `run` calls `capture`/`runInherit` with it; `ensureImage` is a no-op returning the configured `spec.image`; `ip` returns `null` (containers are addressed by name).

- [ ] **Step 1: Write the failing test** (factory resolves the two names; runArgv delegates)

```js
// append to cli/test/runtime-provider.test.mjs
import { resolveRuntime } from '../core/runtimes/index.mjs';

test('resolveRuntime returns a container-cli provider for docker and container', () => {
  for (const n of ['docker', 'container']) {
    const rt = resolveRuntime(n);
    assert.equal(rt.name, n);
    assert.equal(rt.kind, 'container-cli');
    assert.equal(typeof rt.run, 'function');
  }
});

test('provider.runArgv delegates to the renderer', () => {
  const rt = resolveRuntime('docker');
  const argv = rt.runArgv(baseSpec);
  assert.equal(argv[0], 'run');
  assert.ok(argv.includes('--init'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — `Cannot find module '../core/runtimes/index.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to cli/core/runtimes/container-cli.mjs
import { capture, runInherit } from '../util.mjs';
import { containerName, runningSet } from '../runtime.mjs';

export function makeContainerCliRuntime(name) {
  return {
    name,
    kind: 'container-cli',
    runArgv(spec) { return renderRunArgs(spec, { runtime: name }); },
    ensureImage(spec) { return spec.image; },
    run(spec, { detached = false } = {}) {
      const argv = renderRunArgs(spec, { runtime: name });
      if (detached) {
        const i = argv.indexOf('--rm');
        argv.splice(i === -1 ? 1 : i + 1, 0, '-d');
        return capture(name, argv);
      }
      return runInherit(name, argv);
    },
    exec(cname, argv, { interactive = false, env = [] } = {}) {
      const a = ['exec', ...(interactive ? ['-it'] : []), ...env, cname, ...argv];
      return runInherit(name, a);
    },
    stop(cname) { return capture(name, ['stop', cname]); },
    rm(cname) { return capture(name, ['rm', cname]); },
    isRunning(sandboxName) { return runningSet(name).has(containerName(sandboxName)); },
    runningSet() { return runningSet(name); },
    ip() { return null; },
  };
}
```

```js
// cli/core/runtimes/index.mjs
import { die } from '../util.mjs';
import { makeContainerCliRuntime } from './container-cli.mjs';

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  return die(`unknown runtime '${name}' (docker, container)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/core/runtimes/index.mjs cli/core/runtimes/container-cli.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): container-cli provider object + resolveRuntime factory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `buildRunSpec(ctx)` — assemble the spec from cfg + plugins

**Files:**
- Create: `cli/core/runtimes/spec.mjs`
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Consumes: `getPlugins` from `../plugins.mjs`; `brokerEnvArgs` from `../broker.mjs`; a `ctx` shaped like `makeCtx()` in `lifecycle.mjs` (`{ cfg, flags, dir, cname, ... }`).
- Produces: `async buildRunSpec(ctx, { rm, interactive, image, command, termEnv }) -> RunSpec`.
  It reproduces today's `runArgs(ctx)` (lifecycle.mjs:40-63) as structured fields:
  core mounts (`dot-config`, workspace), env `SBX_SANDBOX_NAME`, cwd = workspace,
  `init` = (runtime==='docker'), `capsAll` = (runtime!=='docker' && any plugin `needsCaps`),
  `extraArgs` = concat of every plugin `runArgs(ctx)` **followed by** `await brokerEnvArgs(cfg)`
  (same order as today: plugin args, then broker env, then — rendered later — caps).

- [ ] **Step 1: Write the failing test**

```js
// append to cli/test/runtime-provider.test.mjs
import { buildRunSpec } from '../core/runtimes/spec.mjs';

test('buildRunSpec reproduces core mounts, env and cwd', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: { memory: '4g', cpus: '4' },
    dir: '/state/demo',
    cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, { rm: true, interactive: false, image: 'img', command: ['bash'] });
  assert.equal(spec.name, 'claude-sandbox-demo');
  assert.equal(spec.cwd, '/w/demo');
  assert.deepEqual(spec.env.SBX_SANDBOX_NAME, 'demo');
  assert.ok(spec.mounts.some((m) => m.guest === '/w/demo' && m.host === '/w/demo'));
  assert.ok(spec.mounts.some((m) => m.guest === '/home/agent/.config'));
  assert.equal(spec.init, true);        // docker
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — `Cannot find module '../core/runtimes/spec.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// cli/core/runtimes/spec.mjs
import path from 'node:path';
import { getPlugins } from '../plugins.mjs';
import { brokerEnvArgs } from '../broker.mjs';

export async function buildRunSpec(ctx, { rm, interactive, image, command = [], termEnv = [] }) {
  const { cfg, flags, dir } = ctx;
  const runtime = cfg.runtime;
  const extraArgs = [];
  for (const p of getPlugins()) {
    if (p.runArgs) extraArgs.push(...(await p.runArgs(ctx) || []));
  }
  extraArgs.push(...(await brokerEnvArgs(cfg)));
  return {
    name: ctx.cname,
    image,
    cwd: cfg.workspace,
    memory: flags.memory || process.env.SANDBOX_MEMORY || '4g',
    cpus: flags.cpus || process.env.SANDBOX_CPUS || '4',
    rm, interactive,
    mounts: [
      { host: path.join(dir, 'dot-config'), guest: '/home/agent/.config' },
      { host: cfg.workspace, guest: cfg.workspace },
    ],
    env: { SBX_SANDBOX_NAME: cfg.name },
    init: runtime === 'docker',
    capsAll: runtime !== 'docker' && getPlugins().some((p) => p.needsCaps?.(cfg)),
    extraArgs,
    termEnv,
    command,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/core/runtimes/spec.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): buildRunSpec assembles the run intent from cfg + plugins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Route `lifecycle.mjs` through the provider (docker/container unchanged)

**Files:**
- Modify: `cli/core/lifecycle.mjs` (replace inline `runArgs`/`capture(cfg.runtime,…)` in `cmdStart`, `cmdShell`, `cmdUp`, `cmdDown`, `cmdRm`, `cmdList`)
- Test: manual smoke (below) + existing `cli/test/*` must stay green.

**Interfaces:**
- Consumes: `resolveRuntime` (Task 2), `buildRunSpec` (Task 3).
- Removes: the local `runArgs(ctx)` function (lifecycle.mjs:40-63) — its logic now lives in `buildRunSpec` + the renderer.

- [ ] **Step 1: Write the failing test** — a spec-equivalence assertion guarding the migration

```js
// append to cli/test/runtime-provider.test.mjs
import { renderRunArgs } from '../core/runtimes/container-cli.mjs';
import { buildRunSpec } from '../core/runtimes/spec.mjs';

test('start-shaped spec renders a run argv ending in image + command', async () => {
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'container' },
    flags: {}, dir: '/state/demo', cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, { rm: true, interactive: false, image: 'agent-sandbox-agents', command: ['claude'] });
  const argv = renderRunArgs(spec, { runtime: 'container' });
  assert.equal(argv[0], 'run');
  assert.equal(argv[argv.length - 2], 'agent-sandbox-agents');
  assert.equal(argv[argv.length - 1], 'claude');
  assert.ok(!argv.includes('--init'));   // container
});
```

- [ ] **Step 2: Run test to verify it fails, then passes after wiring**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: PASS already (Tasks 1–3 provide the pieces). This test locks the integration contract before editing lifecycle.

- [ ] **Step 3: Edit `cmdStart`** (lifecycle.mjs:118-139) to use the provider

Replace the body after agent resolution with:

```js
  const ctx = makeCtx(cfg, flags, 'start');
  const rt = resolveRuntime(cfg.runtime);
  if (rt.isRunning(cfg.name)) {
    console.log(`==> Container already running, attaching (${agent.cmd})...`);
    process.exit(rt.exec(ctx.cname, [agent.cmd, ...rest], {
      interactive: IS_TTY,
      env: [...termEnvArgs(), ...(await brokerEnvArgs(cfg))],
    }));
  }
  console.log(`==> Runtime: ${cfg.runtime} | agent: ${agentName} | workspace: ${cfg.workspace}`);
  const image = rt.ensureImage({ image: IMAGE });
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: IS_TTY, image, command: [agent.cmd, ...rest], termEnv: termEnvArgs(),
  });
  process.exit(rt.run(spec));
```

- [ ] **Step 4: Edit `cmdShell`, `cmdUp`, `cmdDown`, `cmdRm`, `cmdList`** to call the provider

- `cmdShell`: same shape as `cmdStart` but `command: ['bash']`, agent-less.
- `cmdUp`: `const spec = await buildRunSpec(ctx, { rm: true, interactive: false, image, command: ['sleep','infinity'] }); ` then append plugin `upArgs` into `spec.extraArgs` (`for (const p of getPlugins()) if (p.upArgs) spec.extraArgs.push(...(await p.upArgs(ctx)||[]))`), run detached: `const r = rt.run(spec, { detached: true }); if (r.status !== 0) die(...)`. Keep the `preUp`/`postUp` loops unchanged.
- `cmdDown`: `resolveRuntime(cfg.runtime).stop(containerName(name))`.
- `cmdRm`: `const rt = resolveRuntime(cfg.runtime); if (rt.isRunning(name)) rt.stop(cname); rt.rm(cname);`.
- `cmdList`: build `running` map via `resolveRuntime('docker').runningSet()` / `resolveRuntime('container').runningSet()` (same as today’s `runningSet('docker')`/`runningSet('container')`).

Delete the now-unused local `runArgs(ctx)` (lines 40-63).

- [ ] **Step 5: Run existing tests + manual smoke**

Run: `cd cli && npm test`
Expected: PASS (no regressions).

Manual (Docker or Apple container present):
```bash
npm install -g ./cli
vivary start -- --version    # non-TTY path: boots, runs `claude --version`, exits
vivary up demo && vivary ls && vivary down demo
```
Expected: identical behaviour to before the refactor.

- [ ] **Step 6: Commit**

```bash
git add cli/core/lifecycle.mjs cli/test/runtime-provider.test.mjs
git commit -m "refactor(runtime): route lifecycle through the runtime provider

No behaviour change for docker/container; creates the seam for the tart
provider (Phase 2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Reserve the `tart` name in the factory (stub) + runtime validation

**Files:**
- Modify: `cli/core/runtimes/index.mjs`
- Modify: `cli/core/runtime.mjs` (`detectRuntime` accepts `tart` via `SANDBOX_RUNTIME`)
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Produces: `resolveRuntime('tart')` throws a clear "not yet implemented (Phase 2)" `die`, NOT "unknown runtime" — so `.vivary.json runtime:"tart"` fails with a helpful message until Phase 2 lands.

- [ ] **Step 1: Write the failing test**

```js
// append to cli/test/runtime-provider.test.mjs
test('resolveRuntime(tart) fails with a phase-2 hint, not unknown-runtime', () => {
  assert.throws(() => resolveRuntime('tart'), /Phase 2|not yet/i);
});
```

Note: `resolveRuntime` calls `die` which does `process.exit(1)`. For testability, change `die` usage here to `throw new Error(...)` inside `resolveRuntime` (the caller in `vivary.mjs` already surfaces thrown errors; keep `die` for the truly-unknown case if preferred, but the test asserts a throw — so make `resolveRuntime` throw and let the top-level catch print it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL (no throw / wrong message).

- [ ] **Step 3: Write minimal implementation**

```js
// cli/core/runtimes/index.mjs
import { makeContainerCliRuntime } from './container-cli.mjs';

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  if (name === 'tart') throw new Error("runtime 'tart' is not yet implemented (Phase 2)");
  throw new Error(`unknown runtime '${name}' (docker, container, tart)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/core/runtimes/index.mjs cli/core/runtime.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): reserve 'tart' in the factory with a Phase-2 stub

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§4.1 of the design):** provider interface ✓ (Task 2), RunSpec intent ✓ (Task 3), docker/container unchanged ✓ (Tasks 1+4 regression tests), `tart` seam reserved ✓ (Task 5). Plugin `runtimes` filtering and the plugin→intent migration are explicitly deferred to later phases (documented in the plan header) — not a gap, a phasing decision.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `RunSpec` field names (`name/image/cwd/memory/cpus/rm/interactive/mounts/env/capsAll/init/extraArgs/termEnv/command`) are identical across Tasks 1, 3, 4. `renderRunArgs(spec,{runtime})`, `makeContainerCliRuntime(name)`, `resolveRuntime(name)`, `buildRunSpec(ctx,opts)` signatures match across tasks.

**Note for the executor:** the container/docker argv order in Task 1's expected array is the contract. If `npm test` regressions show a different legacy order, fix the RENDERER to match the legacy output (the legacy `runArgs` in `lifecycle.mjs:40-63` is the source of truth), not the other way round.
