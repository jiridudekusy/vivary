# Tart Plugins Lite (clipboard + ssh + ide) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "near-free" plugins work on tart macOS sandboxes: clipboard (native tart guest-agent sync, flag-controlled), ssh (host-side registration → `ssh claude-sandbox-<name>` and `vivary ide` against the guest), plus the `vivary ide` tart fix and docs for the sudo decision.

**Architecture:** Two narrow vm-only plugin hooks are added to the Phase-2 seam — `vmSpec(ctx, spec)` (contribute RunSpec fields for VM runtimes, called in `buildRunSpec`'s vm branch) and `vmPostUp(ctx)` (host-side registration after a VM `up`) — leaving the blanket gate for Linux-shaped hooks (`runArgs`/`upArgs`/`preUp`/`postUp`) untouched. The clipboard plugin maps its sticky flag to tart's native pasteboard sync (omit `--no-clipboard`); the ssh plugin reuses its keypair/config-block machinery with a tart branch (pubkey injection + `ssh-keyscan` + `User admin` + sshd hardening). The full `runtimes`/intent migration stays Phase 5.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, tart 2.34.0 (`--no-clipboard`, `tart ip`, `tart exec`), macOS guest (user `admin`, passwordless sudo, sshd enabled, `/etc/ssh/sshd_config.d/*` include).

## Global Constraints

- No behaviour change for docker/container: Linux plugin hooks and argv stay byte-identical; the full suite (59 passing at branch point `e91455f`) is the gate and must stay green.
- "No flag → no feature": without `--clipboard`, the tart guest gets `--no-clipboard` (native sync OFF).
- ssh has NO flag on Linux (active on every `vivary up`) — tart keeps that parity: `vmPostUp` registration runs on every tart `up`.
- The ssh config Host alias stays `claude-sandbox-<name>` for BOTH runtimes (host-side UX; sandbox names are unique across runtimes, no collision).
- `~/.ssh/config` managed blocks are PREPENDED (user's global `UserKnownHostsFile /dev/null` — first match wins) — reuse `ensureSshConfigEntry`, never reimplement.
- tart guest IP is DHCP-per-boot → the config block is rewritten on every `vivary up` (postUp semantics already do this).
- Plugin hook failures in `vmPostUp` WARN (console.error) and return — they never `die` (matches Linux `postUp` behaviour).
- ESM `.mjs`; tests in `cli/test/`, `node --test`; hermetic (no real tart/ssh invocation in unit tests).
- WIP hygiene: `cli/plugins/clipboard/plugin.mjs` carries the user's UNCOMMITTED egress WIP (3+/3− lines) — commits touching it MUST use the surgical staging procedure (stage `git show HEAD:<file>` + only the new hunk; restore the working tree after). `cli/plugins/ssh/plugin.mjs` is clean.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Stage ONLY the files each task names; never `git add -A`/`.`/`-a`.
- Decision record (2026-07-22): tart guests keep passwordless sudo (host-side protections — softnet, virtiofs-as-host-user — are unaffected by guest root); `--sudo` stays Linux-only. Documented in Task 4, not implemented.

---

### Task 1: vm plugin hooks — `vmSpec` + `vmPostUp` seams

**Files:**
- Modify: `cli/core/runtimes/spec.mjs` (call `vmSpec` hooks in the vm branch)
- Modify: `cli/core/lifecycle.mjs` (makeCtx exposes `rt`; cmdUp vm branch calls `vmPostUp`)
- Test: `cli/test/runtime-provider.test.mjs` (extend)

**Interfaces:**
- Consumes: `buildRunSpec(ctx, {…, plugins, brokerEnv})` (hermetic seam), `runtimeKind` from `./index.mjs`, `makeCtx(cfg, flags, mode, rt)`.
- Produces (Tasks 2–3 rely on these exact shapes):
  - plugin hook `vmSpec(ctx, spec)` — may be async; called ONLY when `runtimeKind(runtime) === 'vm-tart'`, in plugin order, AFTER the spec object is fully built (hooks mutate it); never called for docker/container.
  - plugin hook `vmPostUp(ctx)` — may be async; called by `cmdUp` ONLY for vm-tart sandboxes, after the VM is up (where the Linux `postUp` loop runs for containers).
  - `ctx.rt` — the resolved runtime provider, available to all hooks.

- [ ] **Step 1: Write the failing tests**

```js
// append to cli/test/runtime-provider.test.mjs
test('buildRunSpec calls vmSpec hooks in plugin order for tart (after spec is built)', async () => {
  const calls = [];
  const plugins = [
    { vmSpec: (c, spec) => { calls.push('a'); spec.clipboard = true; } },
    { vmSpec: (c, spec) => { calls.push('b'); assert.equal(spec.name, 'vivary-demo'); } },
    {},
  ];
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'tart' },
    flags: {}, dir: '/state/demo', cname: 'vivary-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'ignored', command: ['x'],
    plugins, brokerEnv: async () => [],
  });
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(spec.clipboard, true);
});

test('vmSpec hooks are NOT called for container runtimes', async () => {
  const plugins = [{ vmSpec: () => { throw new Error('vmSpec must not run for docker'); } }];
  const ctx = {
    cfg: { name: 'demo', workspace: '/w/demo', runtime: 'docker' },
    flags: {}, dir: '/state/demo', cname: 'claude-sandbox-demo',
  };
  const spec = await buildRunSpec(ctx, {
    rm: true, interactive: false, image: 'img', command: ['x'],
    plugins, brokerEnv: async () => [],
  });
  assert.equal(spec.clipboard, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/runtime-provider.test.mjs`
Expected: FAIL — first test: `calls` stays `[]` / `spec.clipboard` undefined (no vmSpec support yet).

- [ ] **Step 3: Implement the `vmSpec` loop in `spec.mjs`**

Restructure the tail of `buildRunSpec` so the spec is a `const` and vm hooks run before return (everything above the `return` statement stays as-is):

```js
  const spec = {
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
  // vm-tart: plugins contribute VM-shaped fields via vmSpec (the Linux-shaped
  // runArgs stay gated off above; full intent migration is Phase 5).
  if (vm) {
    for (const p of plugins) {
      if (p.vmSpec) await p.vmSpec(ctx, spec);
    }
  }
  return spec;
```

- [ ] **Step 4: Expose `rt` in ctx and call `vmPostUp` in `cmdUp` (`lifecycle.mjs`)**

`makeCtx` gains `rt` in its returned object (one line, after `cname`):

```js
      cname: rt.instanceName(cfg.name),
      rt,
```

In `cmdUp`, the gated `postUp` block becomes an if/else (the Linux branch is unchanged):

```js
  if (!vm) {
    for (const p of getPlugins()) {
      if (p.postUp) await p.postUp(ctx);
    }
  } else {
    // vm-tart: host-side registration hooks (ssh config, …) — the VM is up.
    for (const p of getPlugins()) {
      if (p.vmPostUp) await p.vmPostUp(ctx);
    }
  }
```

- [ ] **Step 5: Run the full suite**

Run: `cd cli && npm test`
Expected: PASS, ≥ 61 (59 + 2 new). No pre-existing test modified.

- [ ] **Step 6: Commit**

```bash
git add cli/core/runtimes/spec.mjs cli/core/lifecycle.mjs cli/test/runtime-provider.test.mjs
git commit -m "feat(runtime): vmSpec/vmPostUp plugin hooks for vm-tart sandboxes

Narrow vm-only seams: vmSpec contributes RunSpec fields (called in
buildRunSpec's vm branch, plugin order), vmPostUp does host-side
registration after a VM up. Linux-shaped hooks stay gated; the full
runtimes/intent migration remains Phase 5. ctx now carries rt.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: clipboard → tart native pasteboard sync

**Files:**
- Modify: `cli/core/runtimes/tart.mjs` (`buildTartRunArgv` honours `spec.clipboard`)
- Modify: `cli/plugins/clipboard/plugin.mjs` (add `vmSpec`) — ⚠️ WIP-CARRYING FILE, surgical staging
- Test: `cli/test/tart-runtime.test.mjs` (extend + update 1 existing expectation)

**Interfaces:**
- Consumes: `vmSpec(ctx, spec)` hook (Task 1); `buildTartRunArgv(spec)` (Phase 2).
- Produces: `spec.clipboard: bool` — when falsy, `buildTartRunArgv` appends `--no-clipboard` right after `--no-graphics`; when true it omits it (tart guest-agent then syncs the pasteboard natively).

- [ ] **Step 1: Write the failing tests + update the existing expectation**

The existing test `buildTartRunArgv renders headless run with indexed ws tags` asserts an exact array — insert `'--no-clipboard'` after `'--no-graphics'` in its expected array (defaults now disable sync). Then append:

```js
// append to cli/test/tart-runtime.test.mjs
test('buildTartRunArgv omits --no-clipboard when spec.clipboard is set', () => {
  const argv = buildTartRunArgv({ name: 'vivary-demo', clipboard: true, mounts: [] });
  assert.deepEqual(argv, ['run', 'vivary-demo', '--no-graphics']);
});

test('clipboard plugin vmSpec maps the sticky flag onto the spec', async () => {
  const { default: clipboard } = await import('../plugins/clipboard/plugin.mjs');
  const spec = {};
  clipboard.vmSpec({ cfg: { clipboard: true } }, spec);
  assert.equal(spec.clipboard, true);
  const spec2 = {};
  clipboard.vmSpec({ cfg: {} }, spec2);
  assert.equal(spec2.clipboard, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/tart-runtime.test.mjs`
Expected: FAIL — updated array expectation (no `--no-clipboard` emitted yet) + missing `vmSpec` on the plugin.

- [ ] **Step 3: Implement `buildTartRunArgv` change (`tart.mjs`)**

```js
export function buildTartRunArgv(spec) {
  const argv = ['run', spec.name, '--no-graphics'];
  // No flag -> no feature: tart's guest-agent pasteboard sync stays off
  // unless the sandbox opted in via --clipboard (vmSpec sets spec.clipboard).
  if (!spec.clipboard) argv.push('--no-clipboard');
  (spec.mounts || []).forEach((m, i) => {
    argv.push(`--dir=${m.host}:${m.ro ? 'ro,' : ''}tag=