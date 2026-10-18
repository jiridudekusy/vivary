# vivary — notes for Claude

Sandboxed AI coding agents (Claude Code, Codex, Cursor) in Docker / Apple `container`
with deep host integration. Owner: Jiří Dudek (jiridudekusy). Repo:
https://github.com/jiridudekusy/vivary (private). Language: code/docs in
English, converse with the user in Czech.

## Architecture (post core+plugins refactor)

- `cli/vivary.mjs` — thin entry; dispatches commands and agent launchers
  (`slaude`=claude, `sodex`=codex, `sursor`=cursor) by argv0.
- `cli/core/` — util, runtime (docker/apple abstraction), sandbox registry
  (sandbox.json, **sticky flags** as a generic service), lifecycle
  (start/up/down/shell/ls/rm/create/init), config (`.vivary.json` loader +
  approval gate, see below), broker kernel (HTTP, token, audit log —
  routes come from plugins), build (fat-image composer), plugin loader,
  host (host/VM resource probes + the memory budget gate), stats
  (`vivary stats`).
- Settings come in LAYERS (`core/layers.mjs`, pure, unit-tested; IO side in
  `core/effective.mjs`), highest first: CLI > project `.vivary.json` > the
  sandbox's OWN (sticky CLI values in sandbox.json) > named PROFILES
  (`~/.vivary/profiles/<name>.json`, the last listed wins) > the default file
  `~/.vivary/vivary.json` (ONLY when the workspace has no .vivary.json — the
  user's rule) > built-ins. The user chose "set by hand on a sandbox beats its
  profiles". Lists (publish, volume) from profiles/default are ADDED to the
  winning layer's list; `dockerd` (daemon.json) deep-merges, arrays as unions;
  egress presets/allow union across profiles + project. A stored `false` in
  sandbox.json means "never said" (createSandbox writes false for every flag),
  so an explicit off is recorded in `flagsOff` (`--headed=off`; a boolean
  `--x=off` used to read as ON — any string was truthy). Resolved values go on
  cfg in memory only: saveSandbox writes back the sandbox's own value for every
  overlaid key, else an unrelated save (a port, desiredRunning) turned a
  profile's or file's value into a sticky one and removing it from the profile
  changed nothing (that leak existed for .vivary.json before profiles; a key a
  plugin changes after the overlay — paseo turning tailscale on — IS saved).
  agent/runtime are not layered: profiles and the default SEED them at creation
  (`creationSeeds`, CLI > last profile > default), then they are the sandbox's
  own. Sandboxes keep `profiles` (sticky, `--profile a,b`, `none` clears); a
  project file may add `"profiles": [...]` (approval-gated; never written back,
  names are host-specific). Profiles are host-only, so no approval gate; their
  mounts get origin 'profile' (trusted like CLI). `vivary config <name>` prints
  every value with its source; `vivary profile ls|show`. Commands that only
  READ flags (`vivary headed`, `vivary paseo`) must use `effectiveSandbox`, not
  loadSandbox — the flag may live in a profile or the approved project file.
- Project config: `<workspace>/.vivary.json` (committable; agent, runtime,
  memory/cpus, sticky `flags`, `egress: {presets, allow}`, `dockerd`,
  `profiles`) — created by `vivary init` (which writes the sandbox's own and
  the default file's values, never profile values: profiles keep applying),
  unknown keys die loudly. CLI flags that extend the file are written back
  (union only) and auto-approved.
  SECURITY: the file is agent-writable, so every content change is gated
  host-side — sha256 in sandbox.json (`configApproved`) + verbatim copy in
  `~/.vivary/<name>/vivary-approved.json`, unified diff + [y/N] on TTY,
  loud death on non-TTY. The project file is read from the sandbox's OWN
  workspace (`configWorkspace`), never the cwd: `vivary resume` runs
  `up --name <each>` from wherever it was started, and reading the cwd silently
  skipped each sandbox's file (no approval gate, global defaults — agent-sandbox
  ran 8g/6 against an approved 4g/4) or loaded another project's file for it.
  A --workspace that disagrees with an existing sandbox's dies. `vivary init`
  writes the size a start would resolve today, not the built-in 4g/4.
  `runtime` and `agent` follow CLI > project
  file > the sandbox's own; the global file only SEEDS a new sandbox — applied
  on every start it overrode the creation choice (findmy: `create
  --runtime=docker --agent=codex` came up on Apple `container` and would have
  started claude; the override then got saved). A CLI --runtime is sticky.
  Egress policy syncs to ASHP as allow rules named
  `vivary:<sandbox>:<pattern>` (hand-made UI rules never touched); presets
  in `cli/plugins/egress/presets.mjs` (anthropic/openai/cursor, harvested
  empirically; plus `uunpm`, auto-contributed by its plugin — see
  `egressPresets`). Unit tests: `cd cli && npm test` (node --test).
- `cli/plugins/<name>/` — one feature per plugin: `plugin.mjs` (host side:
  flags, runArgs/upArgs/postUp/onCreate/onPurge, needsBroker/needsCaps,
  broker routes, agents/launchers) + `image.dockerfile` fragment + `rootfs/`
  + `entrypoint.d/` hooks. Plugins: egress(5), sudo(16), headed(20),
  ports(25), mounts(26), ssh(30), tailscale(35), docker(40), npmrc(45),
  uunpm(47), host-open(50), clipboard(60), node-modules(70),
  agent-claude(80), agent-codex(85), agent-cursor(90).
  mounts: `-v/--volume HOST[:GUEST][:ro]`, bare path = SAME path in the
  sandbox; works on all 3 runtimes (RunSpec.mounts is structural, tart renders
  virtiofs). SECURITY — a mount is raw host FS access and `.vivary.json` is
  agent-writable, so origin matters: `~/.vivary` refused from BOTH (it holds
  every sandbox's broker token + the approved-config baseline → mounting it
  breaks the approval gate), credential stores/system dirs refused from the
  FILE only (deny-list in the plugin), CLI mounts allowed but warned when they
  contain `~/.vivary`. The origin reaches the plugin via
  `normalize(v, {origin})` — `overlayConfigFlags` must be given cliFlags to
  tell them apart, since effective.flags already has CLI overlaid on file.
  ports: `-p/--publish` docker-syntax, but a missing
  host-ip binds 127.0.0.1 (not 0.0.0.0) — a sandbox service must not land on
  the LAN by accident; tart has no publish at all, so there it only prints
  the guest URL. node-modules: `--node-modules[=N]` scans, or an explicit
  array of workspace-relative dirs in `.vivary.json` (exact list, live
  watcher off). On Apple `container` the overlays live on a per-sandbox
  VOLUME `vivary-<name>-modules` (256G sparse ext4, mounted at
  /vivary-modules-store), NOT on the Mac: survives `--recreate`, deleted by
  every `vivary rm` (onRemove) — it holds what was installed into that
  container, and a runtime switch (rm + fresh up) otherwise left it behind. The host share ~/.vivary/<name>/modules now carries
  only the manifest (+ legacy data, migrated once onto the volume by
  bind-modules at the first start). The plugin's `containerSnapshot` adds
  `nodeModulesStore: volume`, so a kept container from before is refused with
  the --recreate hint; `postUp` waits for bind-modules' boot_id marker
  (/run/vivary-modules.ready) so no agent runs before the overlay. Docker gets
  one named volume per package dir (`vivary-<name>-nm-<slug>`, labelled
  `vivary.sandbox=<name>`; purge deletes BY LABEL — a name prefix would also hit
  a sandbox whose name starts the same). Docker creates an empty volume's root
  as root:root (the mount point is in the workspace, never in the image), so
  npm as agent got EACCES: NEW volumes are chowned to agent — and filled from
  the old host dir, same safe-copy rules — by ONE throwaway container from the
  sandbox image per batch; on failure the new volumes are removed so none is
  left root-owned forever. Docker still has no live watcher: a package.json
  added after the container was created gets its volume only on --recreate. Flag types: `boolean|optional|string|list`; `list` is
  repeatable and may carry a `short` alias, and `list: true` on another type
  lets that flag also take an array in `.vivary.json`.
  `vivary ide` (ssh plugin command) opens Cursor/VS Code via Remote-SSH.
  ssh_config: per-sandbox Host blocks live in `~/.vivary/ssh/config` (marker
  blocks, `SANDBOXES_DIR`-relative), pulled in by ONE prepended managed
  `Include` in `~/.ssh/config`; pre-include in-place blocks are migrated on the
  next `up`, and the new `onRemove(name, cfg)` plugin hook (every `rm`, runs
  AFTER `onPurge(name, cfg)` which still needs the block's HostName) drops them
  again. Both get the sandbox config loaded BEFORE the rm: with --purge the
  state dir is gone by then, and a hook that re-read sandbox.json got nothing
  (the tailnet shares of purged sandboxes stayed up). First
  touch of `~/.ssh/config` backs it up to `~/.ssh/config.vivary.bak` (once).
  known_hosts removal is ATTRIBUTED via the block (HostName+Port ->
  `knownHostsTarget`), which is the only way to spot docker's
  `[localhost]:<sshPort>` line; unattributable leftovers stay.
  ssh publish (docker only — Apple has per-container DNS): per-sandbox port via
  core `assignStablePort` (sandbox.json `sshPort`/`tsSshPort`, prefers 2222 when
  free, probes the host, avoids other sandboxes' ports) — a FIXED 2222 made the
  second docker sandbox die with "port is already allocated". Bound to
  127.0.0.1 unless `--tailscale` (tailnet devices must reach it).
  down/rm/ls resolve the runtime via `runtimesRunning()` instead of trusting
  sandbox.json: a project `.vivary.json` may override `runtime` and that applies
  in memory only, so the instance can live in another runtime than the registry
  records (this left a container running after `rm --purge`).
  egress plugin: `--egress` forces all outbound through a shared, dual-homed
  ASHP transparent MITM proxy (`ashp.mjs`, lazy-started like the broker; state
  in `~/.vivary/.ashp/`); default-deny + per-request approval UI
  (`vivary egress status|stop|logs`).
- `cli/image/` — core Dockerfile.core/.footer + entrypoint runner. The
  container entrypoint just runs `/etc/entrypoint.d/*.sh`; every hook
  self-gates on its env var (SANDBOX_SSH, SANDBOX_DOCKER, HEADED, ...).
- `vivary build` composes ONE fat image (`agent-sandbox-agents`) from core +
  all plugin fragments; features activate at runtime via env.
- Per-sandbox state: `~/.vivary/<name>/` (dot-claude, dot-config,
  dot-codex, ssh/, modules/, sandbox.json). Broker state:
  `~/.vivary/.broker/` (token, log, pid).

## Key invariants (do not break)

- Workspace is mounted at the SAME absolute path as on the host — Claude's
  history slug derives from cwd, which makes container sessions visible to
  host `claude --resume` (and vice versa).
- Chat history mounts are SCOPED: only `~/.claude/projects/<ws-slug>*` dirs,
  never the whole projects dir (privacy).
- Hooks in imported settings.json are ALWAYS stripped.
- No flag → no feature: every host-integration is opt-in and sticky.
  (ssh was the one breach: `up` used to start sshd AND write the host-side
  ssh_config/known_hosts entries with no flag at all. It is now `--ssh`;
  sandboxes created before the flag are inferred from their existing keypair,
  so nothing that already worked stopped working.)
- `vivary up` REFUSES without `--ssh` or `--tailscale`: it exists to leave a
  container for something to attach to later, and with neither there is no way
  in except `vivary shell` on the same Mac that started it. The error names both
  flags and the `vivary shell` alternative. Note the sandbox state dir is
  created before the gate runs (the gate needs the resolved sticky flags), so a
  refused `up` leaves an empty state dir behind — harmless, reused on the retry.
- memory/cpus are STICKY per sandbox, and their tier sits ABOVE the global
  defaults: CLI > project .vivary.json > sandbox.json > ~/.vivary/vivary.json >
  built-in. The global file is a fallback for sandboxes that said nothing, so it
  must not resize one explicitly given `--memory 20g`. Pure `resolveScalars` in
  lifecycle.mjs, unit-tested. Before this the size was re-derived every run, and
  because the persistent container's config snapshot records it, the symptom was
  not a quiet downgrade but `up` REFUSING to start ("memory: 20g -> 8g").
- Loud failures, never silent (overlay binds, npmrc env refs, ...).
- Memory BUDGET: every VM start (`up`, `resume`, and `start`/`shell` when they
  boot one) is refused when the CONFIGURED memory of all running VMs plus the new
  one exceeds `memoryBudget` (default `50%` of host RAM; `"40g"` also works).
  Counts every Apple `container` VM (buildkit, ashp too), running tart VMs, and
  Docker Desktop's VM once; docker sandboxes add nothing (they live inside it).
  Configured, not RSS: a Linux guest fills its RAM with page cache and
  Virtualization.framework does not take it back. `memoryBudget` lives ONLY in
  `~/.vivary/vivary.json` and applies even when a project file exists — a project
  `.vivary.json` is agent-writable, so it may not set it (dies loudly). The gate
  throws instead of die()ing so `resume` skips a sandbox that does not fit and
  carries on. `--ignore-memory-budget` is one-off, never sticky. Pure pieces in
  `core/host.mjs`, unit-tested.

## Hard-won platform gotchas

- Apple `container` (1.1.0): builder VM breaks Node DNS (EAI_AGAIN) → build
  with Docker + `container image load` (SANDBOX_NATIVE_BUILD=1 forces
  native). Runtime gateway DNS mishandles AAAA → fix-net adds
  `options no-aaaa`. No host.docker.internal → fix-net maps it to gateway.
  ~120 virtiofs mount limit → node-modules uses 1 share + in-VM binds
  (needs `--cap-add ALL`). Chromium spawned via `container exec` renders
  white/corrupt into Xvfb — GUI must run in the main process tree. Default
  VM: 1 GB/4 CPU → vivary defaults 4 GB/4.
- macOS `InternetSharing` (com.apple.NetworkSharing) is the system daemon
  behind vmnet: every `container network` create goes through it via sync XPC.
  A crashed session can wedge it — symptoms: network ops fail with "pending
  operation" or hang forever, orphan host bridges remain (bridge101… with the
  nets' subnets), and after any apiserver restart even `container ls` hangs
  (apiserver blocks on the default-net helper; `launchctl print` shows the
  service endpoint `active = 0`, `sample` shows vmnet_network_create stuck in
  XPC). `launchctl kickstart -k …apiserver` KILLS all running containers — the
  runtime services don't survive it. Recovery: `container system stop` →
  restart the wedged daemon with `sudo kill -9 $(pgrep -x InternetSharing)`
  (launchd respawns it clean; `sudo launchctl kickstart -k
  system/com.apple.NetworkSharing` is REFUSED by SIP — "Operation not
  permitted while System Integrity Protection is engaged") →
  `sudo ifconfig bridge10X destroy` for orphans → `container system start`.
  Network names must be lowercase ([a-z0-9-]).
- virtiofs: cannot chmod unix sockets (EINVAL) → `~/.claude/remote/run`
  symlinked to VM-local fs (Claude Desktop remote daemon).
  `~/.codex/app-server-control` (Codex app-server control socket — phone/IDE
  SSH remote control) has the same problem but codex REJECTS a symlinked
  control dir ("exists and is not a directory") → tmpfs mounted over it
  (`--tmpfs`, works on both runtimes, nests fine inside a virtiofs mount).
  The tmpfs comes up root-owned and Apple `container` has no uid/mode tmpfs
  options → codex dies with EPERM securing the dir → fix-codex-ctl sudo
  helper chowns it to agent at boot.
  Nested mounts avoided via non-nested mount + symlink (host-projects).
- Apple VM network-device cap: **max 4 NICs per container** (Virtualization.framework;
  5th `--network` → `VZErrorDomain Code=2 "The number of network devices is
  greater than the maximum number supported."`). Hard limit — reshapes any
  hub-and-spoke egress design: a multi-homed hub = 1 upstream NIC + ≤3 internal
  NICs, i.e. **max 3 isolated per-sandbox egress nets** before the hub must
  restart onto a fresh set. Docker has no such low cap.
- Egress isolation on ONE shared `--internal` net (avoids the 4-NIC cap): host
  reaches any container on the net via the host bridge (`bridge10X`, gateway
  `.1`) and — key — host-originated traffic arrives at the container's netfilter
  with **source = gateway `.1`**, while peer containers arrive with their own
  `.x`. So a per-sandbox ingress firewall gives inter-sandbox isolation without
  separate nets: `iptables -P INPUT DROP; -A INPUT -i lo -j ACCEPT; -A INPUT -m
  conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; -A INPUT -s <gw> -j ACCEPT`.
  Verified: peer→sandbox DROPPED, host→sandbox (ssh) OK, sandbox outbound
  (egress via ASHP, broker) OK via ESTABLISHED return. Needs CAP_NET_ADMIN
  (root; `--cap-add ALL` already added when a plugin sets needsCaps). GOTCHA:
  `iptables` in the image is nf_tables (`iptables-nft`) and its `-vnL`/policy
  counters + `LOG` target proved unreliable here (0 counts while rules clearly
  fired) — trust end-to-end curl outcomes, not nft counters, when debugging.
- Privileged-port bind: Docker defaults `net.ipv4.ip_unprivileged_port_start=0`
  so non-root can bind :80/:443; Apple `container` leaves it at 1024, so a
  non-root service (e.g. ASHP's `ashp`-user proxy) fails with `bind:
  permission denied` on :443. No `--sysctl` flag on Apple `container run`.
  Fix: a root entrypoint sets `sysctl -w net.ipv4.ip_unprivileged_port_start=0`
  before dropping privileges (plain root has CAP_NET_ADMIN by default — no
  `--cap-add` needed). Verified with jiridudekusy/ashp transparent mode: full
  chain works on Apple (dnsmasq :53 catch-all, SNI :443/:80 intercept →
  "Blocked by ASHP" 403, mgmt :3000, CA endpoint) once the sysctl is lowered.
- ASHP on Apple `container` (egress plugin) needs two more fixes vs Docker,
  both in the egress `ashp/pre-entrypoint.sh` wrapper (no-ops on Docker):
  (1) ASHP's stock entrypoint picks dnsmasq listen addrs from `hostname -i`,
  but Apple writes only the FIRST NIC into /etc/hosts → the vivary-egress NIC
  is missed and DNS never answers sandboxes; register every global-scope v4
  addr for the hostname. Also self-pin `ASHP_TRANSPARENT_IP` to the internal
  NIC (the one NOT carrying the default route) since Apple has an incrementing
  DHCP pool and no static-IP flag, so the host can't know the IP pre-boot.
  (2) ASHP's Go transparent proxy resolves the REAL upstream of an *allowed*
  request via a HARDCODED Docker embedded-DNS addr (`127.0.0.11:53`); on Apple
  nothing listens there → allowed requests get an empty reply (deny→403 still
  works, since that path needs no upstream). Fix: run a plain dnsmasq forwarder
  on `127.0.0.11:53` → the real host nameserver (skip when the real nameserver
  already IS 127.0.0.11, i.e. Docker). Verified: allow rule → real 200.
- ASHP rule-scoping + protocol limits (verified 2026-07-22): the Go proxy
  IGNORES a rule's `agent_id` — plain rules are effectively GLOBAL across all
  agents (per-agent scoping exists only via policies, and the flat
  rules.reload fired on every rule mutation overrides the per-agent map
  anyway). And upstream is HTTP/1.1-only: h2-only backends fail (cursor's
  `agentn.global.api5.cursor.sh` closes h1 connections → cursor-agent can't
  round-trip through ASHP at all) and WebSocket upgrades die in the MITM
  (codex falls back to HTTPS by itself after ~15 s of wss retries).
- uunpm plugin: `--uunpm` aliases npm->uunpm and npx->uunpx (Plus4U
  safe-install wrappers; they screen the whole dep tree against
  docs.plus4u.net/unsafe_packages). The uu-safe-* family lives ONLY on
  repo.plus4u.net/repository/public-javascript (anonymous read, NOT on
  npmjs.org) and is BAKED in globally — npx resolves a bin from the global
  prefix before hitting the network, so `uunpm install` -> `npx uu-safe-install`
  works offline (verified with `--network none`).
  Alias is a PATH shim in `~/.local/bin` (agent-owned, first on PATH in the
  container ENV and in profile.d, so no sudo and ssh sessions are covered too);
  a shell alias would MISS non-interactive `bash -c`, which is how agents call
  npm. The hook links it only when the flag is on, and unlinks on `=off`.
  GOTCHA — the wrappers spawn bare `npm`/`npx` from PATH themselves (uunpm:
  `npm view uu-safe-<cmd>` probe + passthrough; uunpx: `npm ls`, then the real
  `npx`), so a naive shim recurses forever. The shim exports
  `VIVARY_UUNPM_INNER` and execs the real binary when it is set: outer command
  checked once, wrapper plumbing unshimmed.
  ignore-scripts=true goes into the sandbox `~/.npmrc` BY DEFAULT (`=alias`
  opts out) to close the back door of a direct `/usr/bin/npm`. Verified matrix
  (probe = a local dep whose postinstall touches a marker — note `npm install
  <pkg>` never runs the ROOT package's scripts, and esbuild is useless as a
  probe since its binary comes from an optionalDependency, not a script):
  no npmrc -> runs; ignore-scripts=true -> blocked; + CLI
  `--ignore-scripts=false` -> runs (CLI beats npmrc); through the shim -> runs,
  because uu-safe-install passes that flag itself. uu-safe-install also writes
  ignore-scripts=true into the PROJECT .npmrc, but only from its first run on,
  so the user-level setting is what covers a fresh checkout.
  Fails CLOSED: an unreachable docs.plus4u.net aborts the install after 5 s —
  hence the `uunpm` egress preset, contributed AUTOMATICALLY via the new
  `egressPresets(cfg)` plugin hook rather than left to `.vivary.json` (a
  forgotten preset shows up as a broken install, not as a visible denial).
  Build cache key vs registry outage: the uu-safe-* versions resolved on the
  host ARE the install layer's cache key. On 2026-10-15 repo.plus4u.net
  answered HTTP 500; a failed probe used to fall back to bare names, which
  changed the key, busted the layer and made the rebuild need the registry that
  was down — every `vivary build` failed. Now the last resolved versions are
  kept in ~/.vivary/.build/uunpm-versions.json and reused on a failed probe.
- Image freshness: a bare `vivary build` refreshes almost NOTHING. The plugin
  build args bust only their own layers (Claude Code, uu-safe-*); the ubuntu
  base and every apt/Node/JDK/Gradle/Playwright layer stay cached indefinitely.
  `--pull` re-resolves the base and busts everything under it when it moved;
  `--no-cache` rebuilds the lot (re-downloads Chromium — slow). A weekly
  LaunchAgent (`scripts/weekly-image-update.sh` +
  `scripts/net.vivary.image-update.plist`, Sunday 04:00) runs `build --pull`,
  logs to `~/.vivary/logs/image-update.log` and posts a notification. It sources
  nvm rather than hardcoding a node dir (launchd has no profile and the default
  node version moves), and starts Docker Desktop itself — the build must go
  through Docker, since Apple's builder VM has broken Node DNS.
  INTERACTION WITH PERSISTENT CONTAINERS: a kept container keeps the image it
  was created from, so a refreshed image reaches a sandbox only on
  `vivary up --recreate` (or after `vivary rm`). Before containers persisted,
  every `up` picked the new image up for free — now it does not, and the cost of
  adopting it is whatever was installed inside the container.
- SSH device keys (`vivary key add|ls|rm`, registry `~/.vivary/devices/*.pub`):
  the per-sandbox keypair stays (it is what the managed ssh_config `IdentityFile`
  points at, invisible on the Mac), but every REGISTERED device pubkey is merged
  into each sandbox's authorized_keys — so an iPad enrols once instead of
  importing a private key per container. Merge runs on EVERY start (a device
  added since the last start must still get in) and dedupes by key BODY, so the
  same key under two names or with a different comment authorizes once.
  `start-sshd.sh` installs authorized_keys BEFORE its "already running" guard,
  which is what lets `key add` refresh a live sandbox without restarting sshd or
  dropping sessions. Two traps found while building it: pushing via
  `sudo start-sshd` unconditionally STARTS sshd in sandboxes that never asked
  for it (breaks the SANDBOX_SSH gate) — gate the push on `pgrep -x sshd`; and a
  container running an older image exits 0 without installing anything, so the
  push must `cmp` the mounted file against the installed one and report those as
  "restart needed" instead of a false "applied". Verified end-to-end: fresh
  sandbox reachable with ONLY the device key (`ssh -F /dev/null`), add on a
  running sandbox works with no restart, `rm` revokes, other devices unaffected.
  TESTING TRAP: `-o IdentitiesOnly=yes -i <key>` still offers the ssh_config
  Host block's IdentityFile — a device-key test MUST pass `-F /dev/null`, or it
  passes on the per-sandbox key and proves nothing.
- cgroup v2 delegation is REQUIRED for systemd-in-container (kind nodes, any
  systemd image) — and it is not automatic, because tini + the entrypoint
  daemons sit in the sandbox's cgroup ROOT. The kernel refuses to enable domain
  controllers in a cgroup that holds processes ("no internal processes"), so
  runc silently falls back to a THREADED subtree at first container run; that
  poisons the root to `domain threaded`, a threaded subtree cannot hold normal
  cgroups, and systemd in the kind node dies with "Failed to create /init.scope
  control group: Structure needs cleaning" -> kind aborts with 'could not find
  a log line that matches "Reached target Multi-User System"'. Threaded mode
  also DROPS the domain-only controllers (memory, io), so docker silently loses
  memory limits. Note dockerd itself is innocent — it does not even create
  /sys/fs/cgroup/docker until a container runs; runc is what threads it.
  Fix (start-dockerd `prepare_cgroups`, what systemd does on any host): park our
  processes in a `/init` leaf, then delegate everything in cgroup.controllers.
  Later ssh/exec sessions inherit /init from their parent, so the root stays
  empty by itself. Verified on Apple `container` (8 GB sandbox, kernel 6.18,
  docker 29.1.3): single- and multi-node `kind create cluster` Ready, nginx
  deployment + service DNS reachable, `docker run --memory=256m` honoured.
- Inner dockerd settings (`dockerd` key -> daemon.json): applied by the HOST
  on every start (docker plugin postUp -> `<runtime> exec -i --user root
  dockerd-config` with the JSON on stdin), never baked in, so no --recreate.
  dockerd-config validates (`dockerd --validate`), diffs keys, SIGHUPs when all
  changed keys are live-reloadable (insecure-registries, registry-mirrors, ...),
  else restarts dockerd under `setsid -w` (Apple ends an exec session's
  processes) and says how many inner containers that stopped. It shares a flock
  with start-dockerd: postUp races the boot hook, and a SIGHUP to a dockerd
  still starting would kill it. dockerd must not inherit that lock fd (`9>&-`),
  or it holds the lock for life. Verified on both runtimes: an HTTP registry
  inside the sandbox refuses `docker push` ("server gave HTTP response to HTTPS
  client") until a profile adds `insecure-registries` (a CIDR survives Apple's
  incrementing DHCP IPs), then reloaded live; `log-level` restarts dockerd, a
  `--restart=always` container comes back. STALE PID FILES: /run is on the kept
  container's rootfs, so /run/docker/containerd/containerd.pid survives a
  restart and its PID gets reused (it was the clipboard hook's bash) -> dockerd
  died "failed to start containerd: ... process with PID 78 is still running" on
  some restarts of every --docker sandbox. start-dockerd drops a pid file whose
  PID is not the daemon it names (/proc/<pid>/comm); 4/4 restarts clean after.
  Docker runtime: /var/lib/docker is the named volume `<cname>-docker`, which
  nothing deleted — every `rm` now does (onRemove), like the node_modules ones.
- virtiofs PINS HOST FILES: Apple's virtiofs keeps one host fd open in the VM
  process for every file/dir the guest kernel holds in its dentry/inode cache.
  A sandbox walking a big workspace runs that into the hundreds of thousands —
  measured on `smarta` (workspace + node-modules share): 151k host fds 4 min
  after start, 190k a few minutes later; the per-process cap is
  kern.maxfilesperproc (245 760 on a 64 GB Mac) and the SYSTEM table
  kern.maxfiles (491 520) is shared by every app. Two such VMs fill it: on
  2026-10-01 the log showed `Too many open files in system` (ENFILE) at 21:48,
  logging stopped at 21:49 and the Mac came back from a WATCHDOG reset
  (`Boot faults: wdog` in ResetCounter*.diag). Relief, verified: drop the
  guest's caches (`sync; echo 2 > /proc/sys/vm/drop_caches`, as root via
  `container exec --user root`) -> 189 945 -> 27 310 host fds at once, no harm
  beyond a cold metadata cache. `vivary stats --trim` does that for every
  running sandbox. `vfs_cache_pressure` alone does NOT help: reclaim only runs
  under guest memory pressure, and an 8 GB guest rarely has any. What stays
  after a trim is pinned by live use (inotify watches, open files).
  COST of a trim, measured 2026-10-06 on `smarta` (median of 3, warm vs first
  run after `drop_caches`): `rg --files` over the workspace 4.7 s -> 67 s;
  `find node_modules -type f` (85k files) 2.5 s -> 77 s; `git status` (7.7k
  files) 0.23 s -> 3.5 s; `rg` content search in one repo 3.0 -> 3.6 s;
  `npm ls --all` unaffected (it reads node_modules/.package-lock.json instead of
  walking). Cold virtiofs metadata runs at ~1.1k lookups/s, so the first
  whole-tree walk after a trim costs about a minute. GROWTH: from the ~33k
  floor, one workspace `rg --files` pinned +30k and one node_modules walk +72k;
  a normal working session climbed back to 210k (86% of the per-process cap)
  within ~10 min. So a periodic blind trim would tax every big walk, while a
  threshold-triggered one pays that minute only when a VM nears danger.
  THE FLOOR was mostly vivary's own: node-modules' `modules-watch` ran
  `inotifywait -m -r --exclude '/node_modules...'` over the whole workspace and
  held 43 306 watches — 20 564 of them INSIDE node_modules, because in
  inotify-tools 3.22 `--exclude` only filters the reported EVENTS while `-r`
  still watches every subdirectory (verified by inode against the watch table).
  A watched directory stays cached, so its host fd can never be trimmed. Fixed:
  the watcher now watches only depth 0..SANDBOX_MODULES_DEPTH, pruning
  node_modules/.git/.hg exactly like the host scan, non-recursively
  (`--fromfile`), and rebuilds the list when a directory appears inside the
  limit — 4 950 watches, post-trim floor 43 493 -> 9 685 host fds. Claude Code
  itself holds ~3 900 more. Existing kept containers keep the old script until
  `--recreate` (or a hot swap of /usr/local/bin/modules-watch, see recipes).
  `vivary stats` maps VM processes to sandboxes by the images they hold open
  (`.../com.apple.container/containers/<id>/rootfs.ext4` at fds 3-9), because a
  Virtualization XPC process's parent is launchd, not the runtime.
  THE LIMIT THAT RUNS OUT IS VNODES, not kern.maxfiles: the broker died of
  ENFILE inside `stat`, which takes no file descriptor — only a vnode. macOS
  keeps the vnode table full as a cache (num_vnodes == maxvnodes, 263 168,
  always) and recycles from its free list; a file held open cannot be
  recycled. Watch `kern.free_vnodes` (~148k free with no VM running). A native
  walk of 500k files on the Mac moved it by 4k; a VM walking 85k files through
  virtiofs pinned 82k. Only VM-shared files do this — natively the Mac recycles.
  The exact edge is unknown: `smarta` once held 210k without a crash, so macOS
  can give back some of its own in-use vnodes under pressure.
  NODE_MODULES OFF THE BRIDGE (2026-10-15): measured on the same 85k-file
  tree — virtiofs share / VM rootfs / named volume: write all 54 s / 2.0 s /
  0.8 s; walk warm 2.6 / 0.13 / 0.16 s; walk cold 99 / 0.14 / 0.16 s; host files
  pinned +82 671 / +1 / +1. Hence the store volume (see node-modules above).
  Apple volumes and rootfs are sparse ext4 images on virtio-blk with discard:
  deleted space returns to the Mac only after `fstrim`, which needs
  CAP_SYS_ADMIN (bind-modules runs it once per boot; node-modules sandboxes
  have caps ALL). A volume can be attached to ONE container at a time ("The
  storage device attachment is invalid").
- headed (noVNC): STICKY, and password-protected — it used to be
  per-invocation (so `create --headed` was forgotten) and served VNC with
  `-nopw` on 0.0.0.0, which another sandbox could open (verified: agent-sandbox
  reached findmy's VNC while that browser held an iCloud login). Now a
  per-sandbox password (~/.vivary/<name>/vnc-password, 8 chars — VNC's limit)
  goes in via VIVARY_VNC_PASSWORD, x11vnc listens on localhost only. The URL
  and the password are printed on SEPARATE lines (`vivary headed <name>`
  repeats them) and the password is never in the URL or on the clipboard: a
  URL lands in synced browser history, and the Mac clipboard is synced into
  every --clipboard sandbox — i.e. to other agents. noVNC prompts for it.
  With --tailscale it is ALSO shared on the tailnet like Paseo: `tailscale
  serve --https=<tsNovncPort>` -> 127.0.0.1:<novncPort> (HTTPS with the
  tailnet's cert, wss works through serve; verified by reading the RFB greeting
  over wss on both runtimes). serve cannot target the container network — the
  macOS extension refuses "remote destinations from non-default route" — so
  Apple `container` then needs the loopback publish too, which makes headed
  part of its snapshot there. Tailnet ports skip what `tailscale serve`
  already uses (`tailnetServePorts`; hostPortFree cannot see them — that is how
  a sandbox once shadowed the user's own Paseo share); Paseo uses it too. On Apple
  `container` postUp starts the stack LIVE (`exec setsid -w start-gui`), so a
  kept container needs no --recreate (flag def `snapshot: false`); on docker
  the noVNC publish (stable `novncPort`, 127.0.0.1 — it was a fixed 6080 on
  every interface) is baked, so there `headed` IS in the snapshot. Traps found:
  x11vnc started via `container exec` lives in another IPC namespace than a
  boot-time Xvfb -> MIT-SHM "BadAccess ... X_ShmAttach" -> needs `-noshm`;
  `pgrep -f openbox` matched any shell mentioning it, so the stack silently did
  not start -> match by process name (`pgrep -x`); start-gui must wait for the
  display whoever started it (boot hooks race a live start) and for noVNC
  before returning; a wedged passwordless x11vnc ignored SIGTERM -> SIGKILL.
- `vivary exec <sb> [--session s] -- <cmd>` / `vivary attach <sb> [s]`: any
  command in a sandbox (started if needed). On a TTY it runs under `dtach`
  (core image, late layer): answer its prompt — a password that must not be
  stored — Ctrl-\ detaches, it keeps running, and the container stays up while
  the session lives (otherwise exec puts a container it started back to sleep,
  like start/shell). dtach, not tmux: no scrollback, nothing retained. The
  program is exec'd directly (no interactive bash -> no HISTFILE, which lives
  on the Mac). Verified with a canary typed through a pty: absent from the whole
  container fs (binaries too), every process's environ/cmdline, the container
  log, vivary state/logs and shell histories; present only in the service's
  memory. Without a TTY: `exec -i` (pipe, no tty) and vivary's own messages go
  to stderr — stdout is the program's. Session = --session or the script name
  (`python3 svc.py` -> svc). Sockets live in /tmp/vivary-sessions and are
  removed by entrypoint.sh at boot (a restart ends the service; type the
  password again). A service in another docker container reaches a sandbox
  port published on 127.0.0.1 via `host.docker.internal:<port>` (measured);
  other containers on the default bridge can ALSO reach it directly at its
  172.17.0.x IP — publishing to loopback does not isolate from them. Same-uid
  processes can read the service's memory (no Yama in the guest kernel), so a
  secret-holding service belongs in a sandbox with no agent. TEST TRAPS: a
  Ctrl-\ sent before dtach owns the terminal is a SIGQUIT to vivary itself
  (the session survives); and searching /proc for a canary with the canary in
  your own grep's argv finds your grep — pass it on stdin.
- STALE X LOCKS in kept containers: /tmp lives on the rootfs and survives
  stop/start (a normal boot clears it). Xvfb treats /tmp/.X99-lock as live when
  its PID exists, and after a restart that PID is reused (lock said 49, PID 49
  was clipboard-sync) -> Xvfb exits "already active": the clipboard's X server
  and the headed GUI failed ~1 restart in 5. entrypoint.sh removes X locks
  before any hook runs; 12/12 restarts clean after.
- PID 1 must REAP: the payload command (`sleep infinity` for `up`, agent/bash
  for `start`/`shell`) never calls wait(), but entrypoint hooks leave daemons
  (sshd, Xvfb, clipboard-sync) that reparent to PID 1 — so every orphan that
  exits became a permanent zombie. clipboard-sync made it unbounded (one xclip
  per host-clipboard change, each superseded by the next → ~1k zombies in a
  fortnight, 4.8k in an 11-day sandbox). Docker's `--init` would fix it but
  Apple `container` has no such flag → `tini` is baked into the core image and
  entrypoint.sh does `exec /usr/bin/tini -- "$@"`. Verified: 20 orphans → 20 Z
  under `sleep`, 0 under tini.
- macOS host: **Norton firewall + Local Network TCC** silently black-hole
  container→host connections (SYN is ACKed by the egress proxy, data dies —
  even closed ports look "open"). User must allow prompts.
- User's ~/.ssh/config has GLOBAL `UserKnownHostsFile /dev/null` — ssh_config
  first-match-wins, so vivary PREPENDS its managed `Include` directive (and
  before the include refactor, the Host blocks themselves).
- pbcopy/pbpaste transcode via process locale → broker forces
  LC_ALL=en_US.UTF-8 for them (mojibake fix).
- Claude Code reads Ctrl+V images via `xclip -t TARGETS -o` then
  `-t image/png -o`; Codex uses arboard = raw X11 → clipboard plugin runs
  bare Xvfb + sync daemon owning the X selection.
- OAuth logins: callback server binds container localhost; broker parses
  `redirect_uri=http://localhost:PORT` from opened URLs and relays the
  host's 127.0.0.1:PORT into the sandbox via `<runtime> exec curl`.
  (Fallback idea if some login lacks redirect_uri: port-diff detection —
  discussed, deliberately not built yet.)
- host-open is a sandbox-escape surface (agent owns the workspace), so the
  broker is default-deny on what reaches the host: URLs refuse
  loopback/private/link-local hosts (+ optional `hostOpenDomains` allow-list
  in sandbox.json); default-app `open` is allow-listed to safe doc/media
  extensions and refuses directories/bundles + execute-bit files (else a
  workspace `.command`/`.app`/`.pkg` would launch on the host). `code <file>`
  (via=editor) stays unrestricted — it only edits. Pure predicates
  (isPrivateHost/domainAllowed/pathSafeToDefaultOpen) are exported for tests.
  NOT covered: DNS names resolving to private IPs (rebinding) — out of scope.
- The "broker wedge" was a CRASH: 18 times between 2026-09-04 and 2026-10-06 an
  uncaught ENFILE from `fs.statSync` (listSandboxNames, called per request to
  resolve the token) killed the process, and nothing restarted it until the
  next `vivary` command (gaps of minutes to 30 h) — from the sandbox it looked
  like clipboard/host-open hanging. Per request it stat'ed every dir in
  ~/.vivary and read every token file (~80 file ops, several times a second per
  sandbox from clipboard polling), so it was the first process on the Mac to hit
  the vnode limit. Now: token -> sandbox cache (rescan only on a miss, at most
  every 5 s; a hit re-reads that one token file), errors caught per request
  (503) plus uncaughtException/unhandledRejection handlers, and every ENFILE is
  logged as a greppable `ENFILE ...` line that `vivary stats` counts (24 h).
- inotify race: new dir + immediate file creation misses events →
  modules-watch also handles directory-create events with a settle+rescan.
- --sudo cannot exceed the HOST user's file rights: on macOS the mount
  daemons (Apple virtiofs, Docker Desktop file sharing) run as the host
  user, so even container-root I/O executes with their privileges (verified:
  chown root inside a mount is a no-op; files land jdk-owned on the host).
  Would NOT hold on a Linux host with plain bind mounts — needs userns-remap
  there (relevant for future Linux/Windows support).

## Testing recipes (manual smoke)

- Non-TTY runs omit `-it` — `vivary start -- --version` works in scripts.
- `container exec` + `pkill -f <pattern>`: pattern must not match the exec
  shell's own cmdline (use `[x]` bracket trick). The trick only hides the
  pattern ITSELF: if the same command line also names the target any other way
  (`cp ... /usr/local/bin/modules-watch; pkill -f 'bin/modules-watc[h]'`), pkill
  still kills its own shell (exit 143). Kill by PID from a separate exec.
- node-modules watcher: `cli/plugins/node-modules/test-watch.sh` (header has
  the `container run` line) — 14 checks in a throwaway container: watch set,
  node_modules/.git/depth exclusion, the new-dir race, burst handling.
  Hot-swapping it into a RUNNING sandbox (persists across stop/start, since the
  kept container's rootfs does): copy the script to /usr/local/bin/modules-watch
  as root, kill the old `bash .../modules-watch` AND its `inotifywait` child by
  PID (the child survives its parent), then restart it as agent with
  SANDBOX_WORKSPACE/SANDBOX_MODULES_DEPTH taken from /proc/1/environ, under
  setsid so it outlives the exec.
- node-modules store: `cli/plugins/node-modules/test-bind.sh` (header has the
  setup) — 15 checks in a throwaway container with a real volume: migration off
  the share, agent ownership, setuid stripped, symlinks kept as links, ready
  marker, fstrim marker, idempotent re-run. It must go through the image's own
  ENTRYPOINT as agent with SANDBOX_SUDO=1: bind-modules reads the workspace from
  PID 1's environment AS AGENT, so `--user root --entrypoint bash` makes it
  refuse (by design). End to end with a scratch sandbox: up with
  --node-modules, npm install lands on the volume (findmnt FSTYPE ext4) and not
  on the Mac, survives down/up and --recreate, legacy dir migrates, a stripped
  snapshot key is refused, rm --purge deletes the volume. Same run on docker
  (`--runtime docker`, Docker Desktop up): volumes are ext4 inside Docker's VM
  and agent-owned, the Docker VM process's Mac fds do not move while walking
  them, migration strips setuid, and purge spares a decoy volume of another
  sandbox with the same name prefix.
- Clipboard tests: back up user clipboard first (pbpaste > file), restore
  after. Compare via `od -An -tx1` (no xxd in image).
- Full smoke: sandbox up with all flags → check hooks (`pgrep sshd/Xvfb/...`),
  ssh alias, broker roundtrips, overlay isolation (host mac-marker intact),
  dockerd version. See git log of "Refactor to core + plugins" for the list.

## Roadmap / open items

- noVNC publish for tailscale plugin (iPad browser access under Apple
  container — currently prints container-DNS URL that only works locally).
- `vivary key-add <name>` — append a client pubkey to authorized_keys +
  restart sshd (asked for iPad/iPhone access).
- Remote broker for headless-server topology (host-open/clipboard should
  target the CLIENT machine over tailnet, not the server).
- Network egress policy: DONE via egress plugin + `.vivary.json` presets/
  allow. Remaining: ASHP ignores rule agent_id (allow rules are global
  across sandboxes) and speaks only HTTP/1.1 upstream (h2-only backends
  like cursor's api5 and wss transports fail) — both need ASHP-side work.
- Host network parity: DONE for routing (2026-10-02). vmnet NATs sandboxes onto
  the primary interface only, so VPN (`utun`) destinations died while DNS still
  answered — read as a policy block. A root LaunchDaemon
  (`scripts/net.vivary.pf-parity.plist` + `vivary-pf-parity.sh`) keeps one
  `nat on <utun>` rule per tunnel in a dedicated `vivary` pf anchor, rediscovered
  on every network change; verified across VPN reconnect, reboot and utunN
  renumbering. Default, not a flag — egress is where access gets limited.
  SECURITY: the daemon runs a root-owned COPY in /usr/local/bin — this repo is
  mounted rw into sandboxes and launchd does not check the program's owner, so
  pointing it at `scripts/` = host root for any agent. Re-`install` after edits.
  NEVER `pfctl -f` (flushes the runtime-inserted vmnet NAT -> no sandbox
  internet until `container system stop/start`). DNS needs nothing: the gateway
  relays the host resolver, `/etc/resolver` split zones included — if a VPN
  name fails in a sandbox, `curl` it ON THE MAC first; on 2026-10-02 the host's
  mDNSResponder failed the `.local` VPN zones for a whole boot and the sandbox
  merely mirrored it (reboot fixed it, HUP did not). Open: the NAT covers the
  whole sandbox /24, not per-sandbox. Spec:
  docs/superpowers/plans/2026-09-29-host-network-parity.md
- `vivary vpn` command (asked 2026-10-06): routing parity exists but is a
  manual one-time `sudo install` + `launchctl bootstrap` of the LaunchDaemon.
  Wanted: enable it any time, for any VPN, from vivary itself — e.g.
  `vivary vpn enable|disable|status`: install/remove the root-owned script copy
  and the plist (one sudo prompt), register the `vivary` nat-anchor in
  /etc/pf.conf if missing (that step is the destructive one — it needs the
  `container system stop/start` dance, so the command must say so and ask),
  and `status` showing which tunnels are NATed right now. Discovery is already
  per-VPN-agnostic (every addressed `utun` except Tailscale's CGNAT one);
  open question whether the user should pick tunnels (`--only SMARTA`) and
  whether to scope it per sandbox instead of the whole /24.
- Trusted CAs (asked 2026-10-18): add extra root CAs to a sandbox (corporate
  MITM proxy, private registry, internal services) and have EVERYTHING in it
  trust them — not just curl. Today only the egress plugin installs a CA (ASHP's)
  and only half-way: system store + NODE_EXTRA_CA_CERTS/REQUESTS_CA_BUNDLE/
  SSL_CERT_FILE, but NOT Java and NOT Docker. Should become a generic mechanism
  (sticky `--ca <file.pem>` list + `.vivary.json` `ca: [...]`, maybe an import
  from the macOS keychain) that egress then uses for its own CA. Delivery as
  egress does it: a per-sandbox RO mount from the host, never fetched over the
  network; installed by a root boot hook on EVERY start (a kept container keeps
  its rootfs, so the hook must also REMOVE CAs dropped from the config — own
  them under a `vivary-` prefix/alias). Stores to cover, checked in the image
  2026-10-18:
  system `/usr/local/share/ca-certificates` + update-ca-certificates (curl, git,
  openssl, Go, python ssl via SSL_CERT_FILE); Node — ignores the system store,
  NODE_EXTRA_CA_CERTS takes ONE file, so a merged bundle (Node 24 also has
  NODE_USE_SYSTEM_CA=1); python requests REQUESTS_CA_BUNDLE, pip (certifi —
  PIP_CERT); Java — Zulu has its OWN `$JAVA_HOME/lib/security/cacerts`
  (-> zulu21-ca-arm64, no /etc/ssl/certs/java, no ca-certificates-java), so
  `keytool -importcert` into it (covers Maven, Gradle, JCA/JSSE); Chromium
  (Playwright, headed) — reads NSS `~/.pki/nssdb`, not the system store, and the
  image has no `certutil` (libnss3-tools); env has to reach main process, exec
  and ssh sessions (egress already does profile.d + sshd SetEnv). Docker inside
  the sandbox (docker plugin): dockerd is Go and reads the system store at
  START, so it must start after the hook or be restarted; per-registry CAs go to
  `/etc/docker/certs.d/<host>/ca.crt`. The containers that docker RUNS do not
  inherit any of it — including kind nodes, whose containerd pulls images
  through its own store (kind `extraMounts` of the bundle +
  update-ca-certificates in the node, or a containerd hosts.toml). Open: how far
  vivary goes into arbitrary images run by the inner docker (offer a bundle
  path to mount, or a helper for kind).
- Automatic fd trimming: DEFERRED (decided 2026-10-15). With node_modules on
  the volume and the watcher fixed, only workspace sources still pin host
  files. Build it only if `ENFILE` lines reappear in broker.log (`vivary stats`
  reports them). Design if needed: host-driven, threshold-triggered on
  kern.free_vnodes (not maxfiles), user LaunchAgent every 60 s, trim only the
  heaviest VM, 10-min cooldown per VM, log every trim. A trim costs ~1 min on
  the next whole-tree walk, so never periodic.
- Windows host support (core/runtime layer is prepared; untested).
- External plugins from `~/.vivary/plugins/` (loader designed for it).

## Workflow with the user

- Czech conversation; likes: design/options first ("řekni mi co a jak"),
  then explicit go; empirical verification over speculation; measurements
  (limits, benchmarks) before architecture decisions. Commits use
  Co-Authored-By: Claude Fable 5. npm global install: `npm install -g ./cli`
  after CLI changes; image rebuild (`vivary build`) after image-side changes;
  broker restart (`pkill -f "vivary.mjs broker"`) after broker-side changes.
