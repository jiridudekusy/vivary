# Design: tart as a runtime provider for vivary

Date: 2026-07-22
Status: proposed (design)
Owner: Jiří Dudek

## 1. Context & motivation

vivary today runs sandboxed AI coding agents in **Linux** containers (Docker or
Apple `container`). This spec adds a third runtime: **macOS guests via `tart`**
(Cirrus Labs), so agents that need genuine macOS (Xcode, native macOS/iOS work,
computer-use, Safari) can run isolated on an Apple-Silicon host, with the same
egress control and host integration vivary already provides for Linux.

The runtime abstraction today is thin: `cfg.runtime` is used as a
**docker-CLI-compatible command string** (`capture(cfg.runtime, ['run', …])`,
`['exec']`, `['stop']`, `['rm']`) and plugins return **arrays of docker-style
args** (`-v`, `-e`, `--network`, `--cap-add`). `tart` does not fit this shape
(`tart clone/run/exec/ip/stop`, mounts via `--dir`, networking via
`--net-softnet`, mem/cpu via `tart set`, no `-e`). Making tart a first-class
provider therefore requires reshaping the runtime abstraction — this is the core
of the change.

Every building block below was validated empirically before this spec (see §3).

## 2. Goals / Non-goals

**Goals**
- `tart` as a first-class vivary runtime alongside `docker`/`container`, with
  **no behaviour change** for the existing two.
- `.vivary.json runtime: "tart"` (or `--runtime tart`) → boot a macOS guest,
  mount the workspace at the same absolute path, run the agent (Claude Code).
- Egress control (softnet floor + ASHP proxy) and host integration (broker,
  host-open, clipboard, ssh/ide) at parity with the Linux experience.
- One comprehensive spec; the *implementation plan* may be phased.

**Non-goals**
- Beating Apple's ~2-concurrent-macOS-guest cap (licensing + framework).
- cursor agent round-trip through ASHP (h2/wss incompatible — login/dashboard
  only, same limitation as Linux).
- Intel host support (Apple Silicon only).

## 3. Empirical grounding (verified 2026-07-22)

Host: M3 Max / 64 GB / macOS 26.5.2. tart 2.34.0, softnet 0.21.1, guest
`cirruslabs/macos-tahoe-base` (macOS 26.5 arm64, user `admin`, passwordless sudo).

| Building block | Result |
|---|---|
| Boot → guest IP (headless) | 10 s |
| `tart exec` latency | ~1.2 s cold, then 70–95 ms |
| Workspace same-path mount (`--dir` unnamed + `mount_virtiofs`) | works; RO honored |
| Softnet policy | `block 0.0.0.0/0` + `allow 1.1.1.1/32` → 1.1.1.1 reachable, 8.8.8.8 blocked |
| Softnet blocks the gateway too under block-all | yes → must explicitly allow the gateway |
| guest → host published port (Apple `container` `-p`, binds 0.0.0.0) | reachable at vmnet gateway |
| ASHP explicit proxy | real forward proxy; proxy-auth required (407); per-agent policy enforced (403/405) |
| **Full spike**: Claude Code in guest, softnet floor + ASHP proxy + CA | OAuth login + `POST /v1/messages` ×5 → **200**; direct egress (no proxy) → blocked |

Conclusion: the entire design is de-risked. Anthropic preset
(`api.anthropic.com/*` + `platform.claude.com/*`) is sufficient for macOS-guest
login + round-trip (same as Linux).

## 4. Architecture

### 4.1 Runtime provider interface + RunSpec intent

New `cli/core/runtimes/{docker,container,tart}.mjs`; each implements:

```
Runtime {
  name, kind: 'container-cli' | 'vm-tart'
  ensureImage(spec)                    // tart: clone base → per-sandbox VM; container-cli: no-op
  run(spec, {interactive, detached})   // foreground+attach / -d
  exec(name, argv, {interactive, env})
  stop(name)  rm(name)  isRunning(name)  runningSet()  ip(name)  list()
}
```

`lifecycle.mjs` calls the provider, never a raw command string. Plugins stop
returning docker-arg arrays and instead **contribute to a RunSpec (intent)**:

```
RunSpec {
  name, image, workspace, cwd, memory, cpus,
  mounts: [{host, guest, ro}],
  env:    {KEY: VALUE},
  ports:  [{host, container, ip?}],
  caps:   ['NET_ADMIN', …] | 'ALL',
  networks: ['default', 'vivary-egress', …],
  net:    { softnet?: { blockAll: bool, allow: [cidr], controlFd?: fd } },
  tmpfs:  [...], init: bool,
}
```

Providers translate the intent:
- **docker / container** → today's docker-style args (`-v/-e/-p/--cap-add/
  --network/--tmpfs/--init`). Behaviour identical to now; the two differ only in
  the divergences already in code (`--init` docker-only; `--cap-add ALL` on
  container when a plugin sets `needsCaps`).
- **tart** → `mounts`→`--dir "host:guest[:ro]"` + post-boot `mount_virtiofs` at
  the same absolute path; `env`→ injected into the agent's exec environment
  (tart has no `-e`); `net.softnet`→`--net-softnet…`; `caps`/`networks`→ ignored;
  `ports`→ N/A for the guest (publishing is a host-service concern, see §4.4).

Plugins gain `runtimes: ['docker','container','tart']` (default all). Linux/
container-only plugins are skipped for tart. Migrating every plugin's `runArgs`
to `contribute(ctx, spec)` is the largest mechanical change; most plugins emit
only a few mounts/env.

### 4.2 Provisioning — `vivary build` → `vivary-macos-base`

`vivary build` (macOS branch): `tart clone cirruslabs/macos-tahoe-base
vivary-macos-base` → boot with open network → provisioning over `tart exec`
(`npm i -g` the agent CLIs; git config; node/brew/Xcode-CLT are already in the
cirruslabs base) → `tart stop`. Each **agent plugin** contributes its install
step (mirrors today's `image.dockerfile` fragments). Per-sandbox VM =
`tart clone vivary-macos-base vivary-<name>` (APFS copy-on-write, near-instant).
Building with an open network resolves the chicken-and-egg (install happens at
build time, not under a locked egress).

### 4.3 Sandbox lifecycle (tart)

- `create`/`start`: `ensureImage` clones the base → `vivary-<name>`; `mem/cpus`
  via `tart set` (`4g` → 4096 MB).
- `up` = boot VM detached (`tart run --no-graphics`, lazy-started like the
  broker/ASHP); `start` = boot if needed + `tart exec` the agent interactively;
  `down` = `tart stop`; `shell` = `tart exec -it zsh`.
- **Workspace same-path invariant preserved**: `--dir "<ws>:<ws>"` (unnamed) +
  post-boot `mount_virtiofs` at `<ws>`.
- **Chat-history parity**: scoped mount of host `~/.claude/projects/<ws-slug>*`
  into the guest via `--dir`, so host `claude --resume` sees guest sessions
  (otherwise history would live only in the guest's `admin` home). Same scoping
  rule as Linux (only the workspace slug, never the whole projects dir).

### 4.4 Egress

- **One shared ASHP, two modes at once.** Today's `vivary-ashp` runs transparent
  (Linux sandboxes on `vivary-egress`) **and** an explicit forward-proxy
  listener. Change: move that listener to **`0.0.0.0:3128`** (conventional proxy
  port) and **publish it to the host** (`-p 3128:3128` in `ashpRunArgs`). tart
  guests use `HTTPS_PROXY=http://<sandbox>:<token>@<gateway>:3128`. The spike
  proved the explicit proxy + proxy-auth **enforces per-agent policy**
  (anthropic 405 / example.com 403), so no per-guest ASHP is needed and the
  transparent-mode `agent_id`-global limitation does not apply here. The
  transparent path (:443/:80) is untouched, so existing Linux sandboxes are
  unaffected.
- **Softnet floor**: `--net-softnet --net-softnet-block=0.0.0.0/0` + allow the
  gateway. The gateway IP is DHCP-assigned per boot, so allow it **after boot**
  via `--net-softnet-control-fd` (vivary owns the socket, discovers the gateway
  from the guest with `netstat -rn`, pushes `allow <gateway>/32`). Pragmatic
  fallback: `--net-softnet-allow=192.168.0.0/16` (the guest can physically reach
  only the host on its vmnet anyway).
- **CA + policy + env**: push ASHP's MITM CA (`data/ca/root.crt`) into the guest
  and set `NODE_EXTRA_CA_CERTS`; sync policy from `.vivary.json egress:
  {presets, allow}` via the existing `syncAgentRules` against the sandbox's ASHP
  agent token. Presets reused; the newly-observed denied hosts
  (`http-intake.logs.us5.datadoghq.com`, `registry.npmjs.org`,
  `downloads.claude.ai`, `raw.githubusercontent.com`) are all non-fatal —
  candidates to note in `presets.mjs`.

### 4.5 Host integration (via the gateway)

The guest reaches the host at its vmnet gateway (`192.168.x.1`), verified. All
host services ride that channel:
- **broker** binds the gateway/`0.0.0.0`; `brokerEnvArgs` point the guest at the
  gateway → host-open, clipboard-relay, OAuth-redirect relay as today.
- **clipboard**: native macOS pasteboard + tart-guest-agent sync — no Xvfb. The
  Linux Xvfb clipboard path is skipped for tart.
- **ssh/ide**: guest ships sshd (cirruslabs); the host reaches the guest directly
  (incoming is allowed even under softnet); `vivary ide` → Remote-SSH to the
  guest IP.

### 4.6 Plugin reconciliation

Add `runtimes` to plugins; the provider filters. Linux/container-only plugins
(`own-modules`, `docker` dind, `sudo`, `headed`/Xvfb) → `['docker','container']`.
Agent plugins gain a macOS provisioning step (§4.2) + intent (proxy/CA/broker
env). The egress plugin gains: publish `:3128`, softnet intent, CA injection,
control-fd gateway-allow.

## 5. Key decisions (settled)

1. **One comprehensive spec** for the whole provider; implementation plan phased.
2. **Base image** via `vivary build` → snapshot `vivary-macos-base` (not
   build-on-first-boot, not manual).
3. **Agent auth**: per-guest login, persisted on the VM disk (self-contained;
   not host-credential bridging in v1). Login per sandbox is acceptable at ≤2
   guests; OAuth works headless (spike).
4. **Runtime abstraction**: provider interface + structured intent (§4.1); the
   honest abstraction, docker/container behaviour unchanged.
5. **Proxy port 3128** (conventional), published to the host.

## 6. Constraints & non-goals

- **≤2 concurrent macOS guests** (Apple EULA/framework). `start`/`ls` should warn
  at the cap.
- cursor egress through ASHP unsupported (h2/wss).
- Apple Silicon only. Same vmnet substrate as Apple `container` → the 4-NIC cap
  and `InternetSharing` wedging gotchas apply; the softnet single-NIC design
  sidesteps multi-net topologies.

## 7. Testing

- **Unit** (`node --test`, like the existing config/host-open predicate tests):
  the RunSpec→invocation renderers for each provider are pure functions and get
  table-driven tests; docker/container renderers must reproduce today's exact
  args (regression guard).
- **Smoke**: `vivary build` (macOS base) → `vivary start` (runtime tart) →
  Claude Code round-trip through ASHP → softnet floor (direct egress blocked) →
  teardown. This is the productized form of the validated spike.

## 8. Open items / risks

- `--net-softnet-control-fd` wiring from Node (pass a connected socketpair fd to
  the `tart run` child; write allow/block updates). Fallback: `/16` superset.
- Chat-history scoped mount into the guest: confirm virtiofs perf + that
  Claude's history dir can be redirected/mounted at the guest's expected path.
- Provider-interface refactor touches every plugin's `runArgs` — mechanical but
  broad; docker/container regression tests are the safety net.
- ASHP mgmt TLS did not load in the spike (host-uid key unreadable by the
  container's `ashp` user); the real egress plugin already handles mgmt over its
  pinned-cert path, so this is spike-only.

## 9. Suggested implementation phasing

1. Provider interface + RunSpec; migrate docker/container with regression tests
   (no behaviour change).
2. tart provider: `ensureImage`/run/exec/stop/rm/ip + same-path workspace;
   `vivary build` macOS base. → boot + run agent, no egress.
3. Egress: publish ASHP :3128, softnet floor + control-fd, CA injection, policy
   sync. → the validated spike, productized.
4. Host integration: broker via gateway, clipboard, ssh/ide, chat-history mount.
5. Plugin reconciliation sweep + `runtimes` filtering; cap warnings.
