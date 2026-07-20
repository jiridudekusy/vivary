# vivary — notes for Claude

Sandboxed AI coding agents (Claude Code, Codex) in Docker / Apple `container`
with deep host integration. Owner: Jiří Dudek (jiridudekusy). Repo:
https://github.com/jiridudekusy/vivary (private). Language: code/docs in
English, converse with the user in Czech.

## Architecture (post core+plugins refactor)

- `cli/vivary.mjs` — thin entry; dispatches commands and agent launchers
  (`slaude`=claude, `sodex`=codex) by argv0.
- `cli/core/` — util, runtime (docker/apple abstraction), sandbox registry
  (sandbox.json, **sticky flags** as a generic service), lifecycle
  (start/up/down/shell/ls/rm/create), broker kernel (HTTP, token, audit log —
  routes come from plugins), build (fat-image composer), plugin loader.
- `cli/plugins/<name>/` — one feature per plugin: `plugin.mjs` (host side:
  flags, runArgs/upArgs/postUp/onCreate/onPurge, needsBroker/needsCaps,
  broker routes, agents/launchers) + `image.dockerfile` fragment + `rootfs/`
  + `entrypoint.d/` hooks. Plugins: headed(20), ssh(30), tailscale(35),
  docker(40), npmrc(45), host-open(50), clipboard(60), own-modules(70),
  agent-claude(80), agent-codex(85).
- `cli/image/` — core Dockerfile.core/.footer + entrypoint runner. The
  container entrypoint just runs `/etc/entrypoint.d/*.sh`; every hook
  self-gates on its env var (SANDBOX_SSH, SANDBOX_DOCKER, HEADED, ...).
- `vivary build` composes ONE fat image (`agent-sandbox-agents`) from core +
  all plugin fragments; features activate at runtime via env.
- Per-sandbox state: `~/claude-sandboxes/<name>/` (dot-claude, dot-config,
  dot-codex, ssh/, modules/, sandbox.json). Broker state:
  `~/claude-sandboxes/.broker/` (token, log, pid).

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
  ~120 virtiofs mount limit → own-modules uses 1 share + in-VM binds
  (needs `--cap-add ALL`). Chromium spawned via `container exec` renders
  white/corrupt into Xvfb — GUI must run in the main process tree. Default
  VM: 1 GB/4 CPU → vivary defaults 4 GB/4.
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
- inotify race: new dir + immediate file creation misses events →
  modules-watch also handles directory-create events with a settle+rescan.

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
- Network egress policy (default-deny + allow-list à la NVIDIA OpenShell) —
  biggest remaining security gap; agreed as worthwhile.
- Windows host support (core/runtime layer is prepared; untested).
- External plugins from `~/.vivary/plugins/` (loader designed for it).

## Workflow with the user

- Czech conversation; likes: design/options first ("řekni mi co a jak"),
  then explicit go; empirical verification over speculation; measurements
  (limits, benchmarks) before architecture decisions. Commits use
  Co-Authored-By: Claude Fable 5. npm global install: `npm install -g ./cli`
  after CLI changes; image rebuild (`vivary build`) after image-side changes;
  broker restart (`pkill -f "vivary.mjs broker"`) after broker-side changes.
