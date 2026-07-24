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
  empirically). Unit tests: `cd cli && npm test` (node --test).
- `cli/plugins/<name>/` — one feature per plugin: `plugin.mjs` (host side:
  flags, runArgs/upArgs/postUp/onCreate/onPurge, needsBroker/needsCaps,
  broker routes, agents/launchers) + `image.dockerfile` fragment + `rootfs/`
  + `entrypoint.d/` hooks. Plugins: egress(5), sudo(16), headed(20),
  ports(25), mounts(26), ssh(30), tailscale(35), docker(40), npmrc(45),
  host-open(50), clipboard(60), node-modules(70), agent-claude(80),
  agent-codex(85), agent-cursor(90).
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
- macOS host: **Norton firewall + Local Network TCC** silently black-hole
  container→host connections (SYN is ACKed by the egress proxy, data dies —
  even closed ports look "open"). User must allow prompts.
- User's ~/.ssh/config has GLOBAL `UserKnownHostsFile /dev/null` — ssh_config
  first-match-wins, so vivary PREPENDS its managed Host blocks.
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
- Windows host support (core/runtime layer is prepared; untested).
- External plugins from `~/.vivary/plugins/` (loader designed for it).

## Workflow with the user

- Czech conversation; likes: design/options first ("řekni mi co a jak"),
  then explicit go; empirical verification over speculation; measurements
  (limits, benchmarks) before architecture decisions. Commits use
  Co-Authored-By: Claude Fable 5. npm global install: `npm install -g ./cli`
  after CLI changes; image rebuild (`vivary build`) after image-side changes;
  broker restart (`pkill -f "vivary.mjs broker"`) after broker-side changes.
