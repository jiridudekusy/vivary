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
  routes come from plugins), build (fat-image composer), plugin loader.
- Project config: `<workspace>/.vivary.json` (committable; agent, runtime,
  memory/cpus, sticky `flags`, `egress: {presets, allow}`) — created by
  `vivary init`, unknown keys die loudly. Global defaults in
  `~/.vivary/vivary.json` apply ONLY when no project file exists (no
  merging). Precedence: CLI > project file > global > built-ins; CLI flags
  that extend the file are written back (union only) and auto-approved.
  SECURITY: the file is agent-writable, so every content change is gated
  host-side — sha256 in sandbox.json (`configApproved`) + verbatim copy in
  `~/.vivary/<name>/vivary-approved.json`, unified diff + [y/N] on TTY,
  loud death on non-TTY. Egress policy syncs to ASHP as allow rules named
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
  watcher off). Flag types: `boolean|optional|string|list`; `list` is
  repeatable and may carry a `short` alias, and `list: true` on another type
  lets that flag also take an array in `.vivary.json`.
  `vivary ide` (ssh plugin command) opens Cursor/VS Code via Remote-SSH.
  ssh_config: per-sandbox Host blocks live in `~/.vivary/ssh/config` (marker
  blocks, `SANDBOXES_DIR`-relative), pulled in by ONE prepended managed
  `Include` in `~/.ssh/config`; pre-include in-place blocks are migrated on the
  next `up`, and the new `onRemove(name)` plugin hook (every `rm`, runs AFTER
  `onPurge` which still needs the block's HostName) drops them again. First
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
  shell's own cmdline (use `[x]` bracket trick).
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
- Host network parity: a sandbox cannot reach what the host routes through a
  VPN tunnel (vmnet NATs onto the primary interface only) — DNS resolves, TCP
  dies, so it reads as a policy block. One host pf `nat on <utun>` rule fixes
  it; needs dynamic interface discovery (utunN is renumbered on reconnect) and
  host root. Should be DEFAULT, not a flag — egress is where access gets
  limited. Spec: docs/superpowers/plans/2026-09-29-host-network-parity.md
- Windows host support (core/runtime layer is prepared; untested).
- External plugins from `~/.vivary/plugins/` (loader designed for it).

## Workflow with the user

- Czech conversation; likes: design/options first ("řekni mi co a jak"),
  then explicit go; empirical verification over speculation; measurements
  (limits, benchmarks) before architecture decisions. Commits use
  Co-Authored-By: Claude Fable 5. npm global install: `npm install -g ./cli`
  after CLI changes; image rebuild (`vivary build`) after image-side changes;
  broker restart (`pkill -f "vivary.mjs broker"`) after broker-side changes.
