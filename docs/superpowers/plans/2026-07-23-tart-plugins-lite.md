# Tart Plugins (lite): clipboard + ssh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the two "almost free" host-integration plugins for tart macOS sandboxes — native clipboard sharing (opt-in via `--clipboard`) and SSH (`vivary up` registers a host `~/.ssh/config` alias to the guest → `ssh`/`vivary ide`/Claude Desktop work).

**Architecture:** Add a minimal vm-tart plugin seam — `vmRunArgs(ctx)` (extra `tart run` flags, gathered before boot) and `vmPostUp(ctx)` (host-side registration after the VM is booted) — instead of the full Phase-5 plugin→intent migration. Clipboard is `vmRunArgs` (pass `--no-clipboard` when the flag is absent, since native tart clipboard sharing defaults ON). SSH is `vmPostUp` (inject the per-sandbox pubkey into the guest via `tart exec`, then register known_hosts + a `~/.ssh/config` block pointing at the guest IP). The Linux container paths of both plugins are untouched.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` + `node:assert/strict`, `tart` 2.34.0, macOS guest `cirruslabs/macos-tahoe-base` (user `admin`, passwordless sudo, sshd ON by default, brew/node preinstalled).

## Global Constraints

- No behaviour change for `docker`/`container`: the Linux clipboard (broker + Xvfb) and ssh (sshd-in-container, mounted keys) paths stay byte-identical. Regression suite is the gate: `cd cli && npm test` is 59 passing at branch point and must stay green, growing with new tests.
- Opt-in convention: no flag → no host integration. `--clipboard` (sticky) turns clipboard ON; without it, tart clipboard sharing is disabled (`--no-clipboard`).
- vm-tart plugin hooks run ONLY for `runtimeKind(cfg.runtime) === 'vm-tart'`; container/docker hooks (`runArgs`/`upArgs`/`preUp`/`postUp`) remain gated OFF for tart (Phase 2 decision). The new `vmRunArgs`/`vmPostUp` hooks run ONLY for vm-tart.
- Error style: `tart.mjs` throws `Error` (never `die`); plugin host-side code may warn/`die` as the existing plugins do. Never leave a partially-registered host artifact silently — warn.
- tart facts (verified, tart 2.34.0): guest user `admin`, home `/Users/admin`, sshd listens on the guest's DHCP IP:22, `tart ip <vm> --wait <s>` returns the IP; `tart exec <vm> <cmd>` runs via the guest agent as `admin` with passwordless sudo; the guest IP is DHCP-assigned per boot (re-register on every `up`). The tart provider exposes `ip(vm)`, `instanceName(sandboxName) -> 'vivary-<name>'`, `isRunning(sandboxName)`, `kind: 'vm-tart'`.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. The working tree holds UNRELATED uncommitted user egress WIP — including in `cli/plugins/clipboard/plugin.mjs` (3-line delta) and `cli/core/broker.mjs`. Stage ONLY the files each task names; for WIP-carrying files use the surgical-staging procedure spelled out in the task. NEVER `git add -A`/`.`/`-a`.

---

### Task 1: vm-tart run-args seam + native clipboard toggle

**Files:**
- Modify: `cli/core/runtimes/tart.mjs` (`buildTartRunArgv` reads `spec.tartRunArgs`; thread through `bootVm`/`ensureBooted`)
- Modify: `cli/core/lifecycle.mjs` (gather `vmRunArgs` into `spec.tartRunArgs` for vm runtimes, in `cmdStart`/`cmdShell`/`cmdUp`)
- Modify: `cli/plugins/clipboard/plugin.mjs` (add `vmRunArgs`) — **WIP-carrying, surgical staging**
- Test: `cli/test/tart-runtime.test.mjs`, `cli/test/runtime-provider.test.mjs`

**Interfaces:**
- Consumes: `buildTartRunArgv(spec)`, `bootVm(vm, opts)`, `makeTartRuntime`, `runtimeKind` (Phase 2).
- Produces:
  - `buildTartRunArgv(spec)` now appends `spec.tartRunArgs` (array, default `[]`) after the `--dir` args.
  - `bootVm(vm, { mounts, runArgs, capture, sleep, spawnDetached })` — new `runArgs` (default `[]`) forwarded into `buildTartRunArgv`.
  - Plugin hook `vmRunArgs(ctx) -> string[]` — extra `tart run` flags for a vm-tart sandbox. clipboard returns `['--no-clipboard']` when `!ctx.cfg.clipboard`, else `[]`.
  - lifecycle helper: for vm runtimes, `spec.tartRunArgs = (await Promise.all(getPlugins().map(p => p.vmRunArgs?.(ctx) || []))).flat()` set before `rt.run(spec)`.

- [ ] **Step 1: Write the failing tests**

```js
// append to cli/test/tart-runtime.test.mjs
test('buildTartRunArgv appends spec.tartRunArgs after --dir', () => {
  const argv = buildTartRunArgv({
    name: 'vivary-demo',
    mounts: [{ host: '/w', guest: '/w' }],
    tartRunArgs: ['--no-clipboard'],
  });
  assert.deepEqual(argv, [
    'run', 'vivary-demo', '--no-graphics', '--dir=/w:tag=ws0', '--no-clipboard',
  ]);
});

test('buildTartRunArgv without tartRunArgs is unchanged', () => {
  assert.deepEqual(
    buildTartRunArgv({ name: 'v', mounts: [] }),
    ['run', 'v', '--no-graphics'],
  );
});
```

```js
// append to cli/test/runtime-provider.test.mjs
import clipboardPlugin from '../plugins/clipboard/plugin.mjs';

test('clipboard vmRunArgs disables native sharing unless --clipboard', () => {
  assert.deepEqual(clipboardPlugin.vmRunArgs({ cfg: { clipboard: false } }), ['--no-clipboard']);
  assert.deepEqual(clipboardPlugin.vmRunArgs({ cfg: { clipboard: true } }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/tart-runtime.test.mjs test/runtime-provider.test.mjs`
Expected: FAIL — `tartRunArgs` not appended; `clipboardPlugin.vmRunArgs` is not a function.

- [ ] **Step 3: Thread `tartRunArgs` through `tart.mjs`**

In `buildTartRunArgv` (currently ends after the mounts loop), append before `return argv;`:

```js
  argv.push(...(spec.tartRunArgs || []));
```

Change `bootVm`'s signature and the `buildTartRunArgv` call inside it:

```js
export function bootVm(vm, {
  mounts = [], runArgs = [], capture = realCapture, sleep = defaultSleep, spawnDetached = defaultSpawnDetached,
} = {}) {
  const running = [...listLocalVms(capture).values()].filter((v) => v.running).length;
  if (running >= 2) {
    console.error(`WARNING: ${running} macOS VMs already running — Apple caps concurrent guests at 2; this boot may fail.`);
  }
  spawnDetached(buildTartRunArgv({ name: vm, mounts, tartRunArgs: runArgs }), tartLogFile(vm));
  try {
    return waitForVm(vm, { capture, sleep });
  } catch (e) {
    capture('tart', ['stop', vm]);
    throw e;
  }
}
```

And in `makeTartRuntime`'s `ensureBooted`, forward the spec's run args:

```js
  const ensureBooted = (spec) => {
    if (listLocalVms(capture).get(spec.name)?.running) return;
    bootVm(spec.name, { mounts: spec.mounts || [], runArgs: spec.tartRunArgs || [], capture, sleep, spawnDetached });
    mountShares(spec.name, spec.mounts || [], capture);
  };
```

- [ ] **Step 4: Gather `vmRunArgs` in lifecycle**

In `cli/core/lifecycle.mjs`, add a helper near `makeCtx`:

```js
// vm-tart plugins contribute extra `tart run` flags (e.g. clipboard's
// --no-clipboard). No-op for container runtimes.
async function vmRunArgs(ctx) {
  if (runtimeKind(ctx.cfg.runtime) !== 'vm-tart') return [];
  const parts = await Promise.all(getPlugins().map((p) => p.vmRunArgs?.(ctx) || []));
  return parts.flat();
}
```

In `cmdStart`, `cmdShell`, and `cmdUp`, immediately AFTER `spec.image = rt.ensureImage(spec);` and BEFORE `rt.run(spec)` (or the detached run), insert:

```js
  spec.tartRunArgs = await vmRunArgs(ctx);
```

(`runtimeKind` is already imported in lifecycle.mjs — verify; add to the import if missing.)

- [ ] **Step 5: Add `vmRunArgs` to the clipboard plugin (SURGICAL staging — file carries user WIP)**

Edit `cli/plugins/clipboard/plugin.mjs`: add this method to the default-export object, right after the existing `runArgs({ cfg }) { … }` method:

```js
  // tart: native host<->guest clipboard sharing is ON by default (tart-guest-agent).
  // Honour the opt-in convention — disable it unless --clipboard was given.
  vmRunArgs({ cfg }) {
    return cfg.clipboard ? [] : ['--no-clipboard'];
  },
```

Then stage ONLY this addition (the file also holds the user's unrelated 3-line WIP delta):

```bash
cp cli/plugins/clipboard/plugin.mjs /tmp/clip-wip.mjs
git show HEAD:cli/plugins/clipboard/plugin.mjs > cli/plugins/clipboard/plugin.mjs
# re-apply ONLY the vmRunArgs method to this clean copy (same spot, after runArgs)
git add cli/plugins/clipboard/plugin.mjs
cp /tmp/clip-wip.mjs cli/plugins/clipboard/plugin.mjs   # restore WIP+mine to working tree
```

VERIFY before committing: `git diff --cached HEAD -- cli/plugins/clipboard/plugin.mjs` shows ONLY the `vmRunArgs` method addition (a few lines), nothing else. After the eventual commit, `git status` must still show `cli/plugins/clipboard/plugin.mjs` as modified (the user's WIP back as the uncommitted delta).

- [ ] **Step 6: Run the suites**

Run: `cd cli && node --test test/tart-runtime.test.mjs test/runtime-provider.test.mjs` then `cd cli && npm test`
Expected: PASS, full suite ≥ 62 (59 + 3). Module-load check from repo root: `node -e "import('./cli/core/lifecycle.mjs').then(()=>console.log('ok'))"`.

- [ ] **Step 7: Commit**

```bash
git add cli/core/runtimes/tart.mjs cli/core/lifecycle.mjs cli/test/tart-runtime.test.mjs cli/test/runtime-provider.test.mjs
# clipboard/plugin.mjs already surgically staged in Step 5
git commit -m "feat(tart): vmRunArgs seam + native clipboard opt-in toggle

Adds spec.tartRunArgs (threaded through bootVm) and a vm-tart-only
vmRunArgs plugin hook gathered in lifecycle. clipboard passes
--no-clipboard unless --clipboard, honouring the opt-in convention
(tart's native host<->guest clipboard defaults on).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SSH for tart — key injection, host config, `vivary ide` fix

**Files:**
- Modify: `cli/plugins/ssh/plugin.mjs` (extract pure `sshConfigBlock`; add `vmPostUp`; parametrize user; fix `cmdIde`)
- Modify: `cli/core/lifecycle.mjs` (run `vmPostUp` for vm runtimes in `cmdUp`)
- Test: `cli/test/ssh-config.test.mjs` (new)

**Interfaces:**
- Consumes: tart provider `ip(vm)`, `instanceName(name)`, `isRunning(name)`; `resolveRuntime`, `runtimeKind`; `buildGuestExecArgv` is NOT needed here (ssh uses `tart exec` directly via `capture`).
- Produces:
  - Pure `sshConfigBlock({ name, host, user, port, identityFile, knownHosts }) -> string` (the marker-delimited block), used by both the existing container path and the new tart path.
  - Plugin hook `vmPostUp(ctx) -> Promise<void>` — for a booted vm-tart sandbox: ensure the keypair, inject the pubkey into the guest, register known_hosts + `~/.ssh/config`.
  - lifecycle: `cmdUp`, when `vm`, runs `for (const p of getPlugins()) if (p.vmPostUp) await p.vmPostUp(ctx);` after `rt.run(spec, { detached: true })` succeeds.

- [ ] **Step 1: Write the failing test (pure block builder)**

```js
// cli/test/ssh-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshConfigBlock } from '../plugins/ssh/plugin.mjs';

test('sshConfigBlock renders a marker-delimited Host block with the given user', () => {
  const block = sshConfigBlock({
    name: 'demo', host: '192.168.65.2', user: 'admin', port: '22',
    identityFile: '/s/demo/ssh/id_ed25519', knownHosts: '/h/.ssh/known_hosts',
  });
  assert.match(block, /^# >>> claude-sandbox:demo \(managed by vivary\) >>>$/m);
  assert.match(block, /^Host claude-sandbox-demo$/m);
  assert.match(block, /^ {4}HostName 192\.168\.65\.2$/m);
  assert.match(block, /^ {4}User admin$/m);
  assert.match(block, /^ {4}Port 22$/m);
  assert.match(block, /^ {4}IdentityFile \/s\/demo\/ssh\/id_ed25519$/m);
  assert.match(block, /^ {4}IdentitiesOnly yes$/m);
  assert.match(block, /^# <<< claude-sandbox:demo <<<$/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/ssh-config.test.mjs`
Expected: FAIL — `sshConfigBlock` is not exported.

- [ ] **Step 3: Extract `sshConfigBlock` (pure) in `ssh/plugin.mjs`**

Add the exported pure builder (lift the block array out of `ensureSshConfigEntry`, add a `user` param):

```js
export function sshConfigBlock({ name, host, user, port, identityFile, knownHosts }) {
  return [
    `# >>> claude-sandbox:${name} (managed by vivary) >>>`,
    `Host claude-sandbox-${name}`,
    `    HostName ${host}`,
    `    User ${user}`,
    `    Port ${port}`,
    `    IdentityFile ${identityFile}`,
    // Without IdentitiesOnly, ssh offers every agent-loaded key first and a
    // well-stocked agent exhausts MaxAuthTries before our key is tried.
    '    IdentitiesOnly yes',
    `    UserKnownHostsFile ${knownHosts}`,
    '    StrictHostKeyChecking accept-new',
    `# <<< claude-sandbox:${name} <<<`,
    '',
  ].join('\n');
}
```

Rewrite `ensureSshConfigEntry` to take a `user` argument and delegate to it:

```js
function ensureSshConfigEntry(name, host, port, dir, user = 'agent') {
  const cfgFile = path.join(HOME, '.ssh/config');
  const begin = `# >>> claude-sandbox:${name} (managed by vivary) >>>`;
  const end = `# <<< claude-sandbox:${name} <<<`;
  const legacy = ['sbx', 'sandbox.sh'].map(
    (t) => `# >>> claude-sandbox:${name} (managed by ${t}) >>>`);
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  let content = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  for (const marker of [begin, ...legacy]) {
    const b = content.indexOf(marker);
    if (b === -1) continue;
    const e = content.indexOf(end, b);
    content = content.slice(0, b) + content.slice(e === -1 ? b : e + end.length + 1);
  }
  const block = sshConfigBlock({
    name, host, user, port,
    identityFile: path.join(dir, 'ssh/id_ed25519'),
    knownHosts: path.join(HOME, '.ssh/known_hosts'),
  });
  fs.writeFileSync(cfgFile, block + content);
}
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `cd cli && node --test test/ssh-config.test.mjs`
Expected: PASS. Then `cd cli && npm test` — the existing container ssh path still uses `ensureSshConfigEntry(name, host, port, dir)` with the `user='agent'` default, so no behaviour change; ≥ 63 tests, green.

- [ ] **Step 5: Add the keypair helper + `vmPostUp` to `ssh/plugin.mjs`**

Extract the keypair generation from `upArgs` into a reusable helper (leave `upArgs` calling it so the container path is unchanged):

```js
function ensureKeypair(dir, cname, log) {
  const keyFile = path.join(dir, 'ssh/id_ed25519');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
    const r = capture('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', cname, '-f', keyFile]);
    if (r.status !== 0) die(`ssh-keygen failed: ${r.stderr}`);
    fs.copyFileSync(`${keyFile}.pub`, path.join(dir, 'ssh/authorized_keys'));
    log(`==> Generated SSH keypair in ${path.join(dir, 'ssh')}`);
  }
  return keyFile;
}
```

In `upArgs`, replace the inline keygen block (the `if (!fs.existsSync(keyFile)) { … }`) with `const keyFile = ensureKeypair(dir, cname, ctx.log);` (keeps the subsequent `-v .../ssh:/home/agent/host-ssh` mount + `SANDBOX_SSH=1` env exactly as-is).

Add `import { resolveRuntime } from '../../core/runtimes/index.mjs';` at the top, then add the vm hook to the default export:

```js
  // tart: the guest already runs sshd (cirruslabs base, user `admin`). After
  // the VM is booted, inject our per-sandbox pubkey, then register the host
  // known_hosts + ~/.ssh/config alias pointing at the guest's (DHCP) IP.
  async vmPostUp(ctx) {
    const { cfg, dir } = ctx;
    const rt = resolveRuntime(cfg.runtime);
    const vm = rt.instanceName(cfg.name);
    const keyFile = ensureKeypair(dir, vm, ctx.log);
    const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();

    // Append the pubkey to the guest's authorized_keys (idempotent).
    const inject = [
      'exec', vm, '/bin/zsh', '-lc',
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `grep -qxF ${JSON.stringify(pub)} ~/.ssh/authorized_keys || echo ${JSON.stringify(pub)} >> ~/.ssh/authorized_keys`,
    ];
    if (capture('tart', inject).status !== 0) {
      console.error('WARNING: could not inject SSH key into the guest; ssh alias may not authenticate');
    }

    const ip = rt.ip(vm);
    if (!ip) {
      console.error('WARNING: no guest IP yet; skipping SSH host registration'); return;
    }
    // Trust the guest host key (ssh-keyscan; the guest generated it at first boot).
    const kh = path.join(HOME, '.ssh/known_hosts');
    const scan = capture('ssh-keyscan', ['-T', '5', ip]);
    if (scan.status === 0 && scan.stdout) {
      fs.mkdirSync(path.dirname(kh), { recursive: true });
      const existing = fs.existsSync(kh) ? fs.readFileSync(kh, 'utf8').split('\n') : [];
      const kept = existing.filter((l) => (l.split(/\s+/)[0] || '') !== ip);
      fs.writeFileSync(kh, [...kept, scan.stdout.trim()].join('\n').replace(/\n+$/, '') + '\n');
    } else {
      console.error('WARNING: ssh-keyscan of the guest failed; first connect may prompt to trust the host key');
    }
    ensureSshConfigEntry(cfg.name, ip, '22', dir, 'admin');
    ctx.log(`    SSH config entry added/updated in ~/.ssh/config.

    Connect:  ssh claude-sandbox-${cfg.name}
    IDE:      vivary ide ${cfg.name}`);
  },
```

- [ ] **Step 6: Run `vmPostUp` in `cmdUp` for vm runtimes + fix `cmdIde`**

In `cli/core/lifecycle.mjs` `cmdUp`, the existing `postUp` loop is gated `if (!vm)`. Right after that block (still inside `cmdUp`, after the "is up" log), add:

```js
  if (vm) {
    for (const p of getPlugins()) {
      if (p.vmPostUp) await p.vmPostUp(ctx);
    }
  }
```

In `ssh/plugin.mjs` `cmdIde`, replace the legacy running-check and alias with provider-driven ones:

```js
  const rt = resolveRuntime(cfg.runtime);
  if (!rt.isRunning(cfg.name)) await cmdUp([cfg.name]);
  const alias = rt.instanceName(cfg.name); // == the managed ssh_config Host label
```

Remove the now-unused `isRunning` (and `containerName` if `cmdIde` was its only remaining use — check: `removeSshArtifacts` still uses `containerName`, so keep that import) from the `runtime.mjs` import line. Keep `containerDnsDomain` (still used by the container `upArgs` path).

Note on the ssh_config alias: for tart, `rt.instanceName` returns `vivary-<name>`, so the managed Host label and `cmdIde` alias are both `vivary-<name>` — but `sshConfigBlock`/`ensureSshConfigEntry` hardcode `Host claude-sandbox-${name}`. To keep the alias consistent for tart, pass the instance label through: change `ensureSshConfigEntry` and `sshConfigBlock` to take the full `hostAlias` (default `claude-sandbox-${name}` for containers, `rt.instanceName(cfg.name)` for tart). Concretely — `sshConfigBlock({ hostAlias, host, user, port, identityFile, knownHosts })` uses `Host ${hostAlias}` and the begin/end markers keyed by `name` (unchanged); `ensureSshConfigEntry(name, host, port, dir, { user = 'agent', hostAlias = \`claude-sandbox-${name}\` } = {})`; the container path calls it as today (defaults), and `vmPostUp` calls `ensureSshConfigEntry(cfg.name, ip, '22', dir, { user: 'admin', hostAlias: vm })`. Update the Step-1 test's expectations accordingly (assert `Host <hostAlias>` for a `hostAlias: 'vivary-demo'` case AND the default `claude-sandbox-demo` case).

- [ ] **Step 7: Run the suites + module-load**

Run: `cd cli && npm test` (≥ 64, green — the added `hostAlias`/`user` params default to the container behaviour, so the container ssh path is unchanged). Module-load: `node -e "import('./cli/plugins/ssh/plugin.mjs').then(()=>console.log('ok'))"` and `node -e "import('./cli/core/lifecycle.mjs').then(()=>console.log('ok'))"` from repo root. `node cli/vivary.mjs help` prints without error.

- [ ] **Step 8: Commit**

```bash
git add cli/plugins/ssh/plugin.mjs cli/core/lifecycle.mjs cli/test/ssh-config.test.mjs
git commit -m "feat(tart): ssh for macOS sandboxes (key injection + host config) + ide fix

vmPostUp injects the per-sandbox pubkey into the guest via tart exec and
registers a ~/.ssh/config alias to the guest IP (user admin, host key via
ssh-keyscan); vivary ide now resolves running-state/alias through the
provider so it works for tart too. Container ssh path unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (controller/human — NOT a subagent task)

Live smoke on this host (`vivary-macos-base` already built; mind the ~2 macOS VM cap — `tart list` first). Run via `node cli/vivary.mjs` (no global install).

```bash
WS=$(mktemp -d); echo hi > "$WS/hello.txt"

# clipboard: enabled sandbox boots with native sharing; disabled passes --no-clipboard
node cli/vivary.mjs up --name tclip --workspace "$WS" --runtime tart --clipboard
tart exec vivary-tclip sh -lc 'pbpaste | head -c 40; echo'   # host clipboard visible in guest?
node cli/vivary.mjs down tclip && node cli/vivary.mjs rm tclip --purge

# ssh: up registers the alias; ssh + ide work
node cli/vivary.mjs up --name tssh --workspace "$WS" --runtime tart
grep -A6 "claude-sandbox:tssh" ~/.ssh/config          # block with HostName <guest-ip>, User admin
ssh claude-sandbox-tssh 'sw_vers -productName; whoami; ls '"$WS"   # macOS / admin / hello.txt via key auth
node cli/vivary.mjs down tssh && node cli/vivary.mjs rm tssh --purge   # onPurge removes the ~/.ssh/config block
grep -c "claude-sandbox:tssh" ~/.ssh/config || echo "block removed ✓"

# regression: a container sandbox still gets its ssh alias + clipboard behaviour
node cli/vivary.mjs up --name creg --workspace "$WS" && node cli/vivary.mjs rm creg --purge
```

Expected: clipboard readable in the guest only with `--clipboard`; `ssh claude-sandbox-tssh` authenticates by key (no password) and reports macOS/admin/hello.txt; purge removes the ssh_config block; the container path is unaffected. Watch: guest IP is DHCP per boot — re-running `up` after a `down`/reboot must refresh the `HostName`. If native clipboard does NOT sync under `--no-graphics` (guest-agent limitation), record it — clipboard for tart then needs the broker-relay path (deferred to a later phase); the `--no-clipboard`-when-disabled behaviour is still correct regardless.

## Self-Review

**Spec coverage (design §4.5 host integration — clipboard, ssh/ide):** clipboard native toggle ✓ (Task 1); ssh key-injection + host config + `vivary ide` fix ✓ (Task 2). Broker-backed host-open is a separate later item (design §4.5) — not in this "lite" plan. sudo stays on (decision, no code). The vm-tart hook seam (`vmRunArgs`/`vmPostUp`) is introduced narrowly here rather than the full Phase-5 intent migration — a documented scoping choice consistent with Phase 2's gating approach.

**Placeholder scan:** none — every step has concrete code/commands. (`node --test` module-load and `git` commands are exact.)

**Type consistency:** `vmRunArgs(ctx) -> string[]`, `vmPostUp(ctx) -> Promise<void>`, `spec.tartRunArgs`, `bootVm(vm, {mounts, runArgs, …})`, `sshConfigBlock({name, hostAlias, host, user, port, identityFile, knownHosts})`, `ensureSshConfigEntry(name, host, port, dir, {user, hostAlias})`, `ensureKeypair(dir, cname, log)`, `rt.ip/instanceName/isRunning` — consistent across tasks. Task 2 Step 6 finalizes `sshConfigBlock`/`ensureSshConfigEntry` to the `hostAlias`-carrying shape; the implementer must update the Step-1 test to match (noted inline).

**Known intentional deviations:** (a) container clipboard/ssh paths keep their exact current mechanisms — only NEW vm hooks are added; (b) tart guest ssh user is `admin` (cirruslabs base), not `agent`; (c) password auth in the guest is left enabled (admin/admin) — hardening (disable password auth post key-injection) is deliberately OUT of this lite plan to keep it low-risk; it belongs with the egress phase where guest reachability is tightened. Note this in the ledger so the final review can weigh it.
