# vivary

*A vivary is an enclosure for keeping live creatures under observation.*

Run AI coding agents (Claude Code, Codex, Cursor) in isolated containers — **Docker**
or **Apple `container`** — while keeping host-level convenience: shared chat
history, one-time login, imported settings/skills/MCP, a browser the agent can
drive (headless or visible via noVNC), and SSH access for Claude Desktop.

```bash
cd ~/work/myproj
slaude               # sandboxed Claude Code for this project. That's it.
```

## Install

```bash
vivary build                 # compose + build the image
npm install -g ./cli         # installs the `vivary`, `slaude`, `sodex` and `sursor` commands
```

Requires Node.js >= 20 on the host and Docker and/or Apple `container`.

## CLI

```
vivary start | run [name]   start an interactive agent session — auto-creates the
                         sandbox on first use (name + workspace = current dir);
                         extra args are passed to the agent
vivary create [name]        explicit create with an interactive import wizard
                         (MCP servers, skills, settings)
vivary up [name]            long-running container with sshd (Claude Desktop, IDEs)
vivary down [name]          stop the long-running container
vivary ls                   list sandboxes across both runtimes
vivary shell [name]         bash in the sandbox (auto-starts it if not running)
vivary rm [name] [--purge]  remove container (--purge deletes state too)
vivary build [base|agents]  build images
vivary help                 full help with options and examples
```

Agent launchers (equivalent to `vivary start --agent ... -- args`):

- **`slaude`** — sandboxed **Claude Code** in the current directory (`slaude -r`
  passes `-r` to claude)
- **`sodex`** — sandboxed **Codex**
- **`sursor`** — sandboxed **Cursor CLI agent**

Common options: `--headed`, `--docker`, `--memory 8g`, `--cpus 6`, `--runtime
docker|container`, `--name`, `--workspace`, `--agent`. Environment defaults:
`SANDBOX_RUNTIME`, `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOXES_DIR`,
`NOVNC_PORT`, `SSH_PORT`.

**Runtime selection**: chosen when the sandbox is created (`--runtime`, else
`$SANDBOX_RUNTIME`, else autodetect — `container` wins if installed) and
stored in the sandbox config; `start`/`up` always use the stored runtime.
`vivary ls` shows sandboxes of both runtimes side by side.

## Image

One fat image (`agent-sandbox-agents`) composed by `vivary build` from the
core Dockerfile plus every plugin fragment — Ubuntu 24.04 with:

| Component | Version / source |
|---|---|
| Node.js | 24 (NodeSource) |
| Java | Azul Zulu JDK 21 |
| Build tools | Maven (apt), Gradle 8.14 |
| Playwright | latest, global npm install, Chromium pre-installed (`/opt/pw-browsers`, agent-writable so projects can `npx playwright install`) |
| GUI stack | Xvfb + openbox + x11vnc + noVNC (headed browser mode) |
| sshd | key-only, user `agent` (for Claude Desktop / IDE access) |

Browser modes:

- **Headless** (default): Playwright works out of the box.
- **Headed**: `--headed` starts Xvfb (`:99`) + noVNC — watch and control the
  browser from the host (URL is printed on start; run agent code with
  `headless: false`).

One image serves all agents — Claude can call Codex (`codex exec ...`) and
vice versa within the same sandbox.

**Host-open** (`--host-open`, sticky per sandbox): `xdg-open`/`open`/`code`
inside the sandbox forward to a small host-side broker (`vivary broker`,
auto-started) — URLs open in the **host browser** (http/https only; e.g.
OAuth login flows open automatically via `$BROWSER`), files open in the
**host editor** (VS Code), restricted to sandbox workspaces. Requests are
token-authenticated and logged to `~/claude-sandboxes/.broker/broker.log`.
This is a deliberate, narrowly-scoped hole in the sandbox — enable per
sandbox only when you want it.

**OAuth login just works with `--host-open`**: `claude /login` (and `codex
login`) run their callback server on the *container's* localhost while the
browser opens on the *host*. The broker detects `redirect_uri=
http://localhost:PORT` in the authorize URL, listens on the host's
`127.0.0.1:PORT` for 5 minutes and replays the browser's redirect into the
sandbox (via `<runtime> exec curl`, i.e. inside the container's network
namespace). One login per sandbox, credentials persist.

**Own node_modules** (`--own-modules[=N]`, sticky per sandbox): every
workspace dir with a `package.json` (scanned N levels deep, default 4, no
symlink following) gets its `node_modules` overlaid with a per-sandbox
directory — Linux modules never mix with the host's macOS ones, and the
host's existing `node_modules` stay untouched underneath. Docker uses one
bind mount per package dir; Apple `container` (which caps out at ~120
virtiofs shares) uses a single share plus in-VM bind mounts, scaling to
hundreds of packages. New `package.json` files created inside the sandbox
are picked up **live** by an inotify watcher (overlay lands before the first
`npm install`). Host-side additions are picked up on restart.
`--own-modules=0` disables. Overlay failures are loud, never silent.

**npmrc import** (`--npmrc[=…]`, sticky per sandbox): carries the host
`~/.npmrc` into the sandbox, re-read on every start (token rotation just
works). Values: bare = whole file; `registries` = no credentials;
comma list = selective (`default`, `@scope`, hostname fragment — e.g.
`--npmrc=default,nexus.cams`); `off` disables. localhost registries are
rewritten to `host.docker.internal` (including the auth keys npm matches by
URL), `cafile` paths are copied along, and `${VAR}` token references are
injected via container env at start — never stored in the sandbox state.

**Clipboard bridge** (`--clipboard`, sticky per sandbox): the host clipboard
reaches the sandbox — **Ctrl+V pastes a host screenshot straight into Claude
Code** (it reads images via `xclip`, which is shimmed to fetch from the
broker), `pbpaste`/`xclip -o` return host clipboard text, and `pbcopy` inside
sets the host clipboard. X-native agents are covered too — Codex reads the
clipboard from the X server directly (arboard), so a bare Xvfb plus a sync
daemon mirror the host clipboard into the X CLIPBOARD selection.
Per-sandbox permission enforced by the broker;
reads/writes are logged. Note the host clipboard may hold sensitive data —
enable only where you want it.

**Tailscale** (`--tailscale`, sticky per sandbox): tailnet integration in
both directions. Outbound: raw 100.x connectivity works through the host's
NAT out of the box; MagicDNS names (short + FQDN) are injected into the
container's /etc/hosts from `tailscale status` at every start. Inbound:
`vivary up` publishes the sandbox's sshd on a stable per-sandbox port
(22000+), so any tailnet device reaches it at `<host-magicdns>:<port>` —
Claude Desktop from your laptop, ssh from an iPad. The identity file lives
on the container host (`~/claude-sandboxes/<name>/ssh/`); copy it to the
client once.

**Docker-in-sandbox**: start with `--docker` (sticky per sandbox) and agents
can build and run containers inside — `dockerd` runs in the sandbox, with no
access to the host Docker daemon. Under the docker runtime this uses
`--privileged` (contained by the Docker Desktop VM) and a named volume for
`/var/lib/docker` (overlay2 can't sit on overlayfs); under Apple `container`
the sandbox is its own VM, so neither is needed.

## How host sharing works

Per-sandbox state lives in `~/claude-sandboxes/<name>/`:

| Host path | In container | Purpose |
|---|---|---|
| `dot-claude/` | `/home/agent/.claude` | settings, skills, credentials, CLI config (`CLAUDE_CONFIG_DIR`) — survives container deletion |
| `dot-config/` | `/home/agent/.config` | status line config etc. |
| `dot-codex/` | `/home/agent/.codex` | Codex auth/state |
| `dot-cursor/` | `/home/agent/.cursor` | Cursor CLI auth/state |
| `ssh/` | `/home/agent/host-ssh` | SSH keypair + persisted host keys |
| `~/.claude/projects/<workspace-slug>*` (only this project + its subdirs) | `/home/agent/host-projects/<slug>` → symlinked to `~/.claude/projects` | **chats land directly in the host's history** — but the container never sees other projects' chats |
| `<workspace>` | same absolute path | history slug derives from cwd — identical paths mean host `claude --resume` sees container sessions natively |

Consequences:

- Chat history is visible on the host (`claude --resume` in the workspace) and
  survives `vivary rm`, even `--purge`.
- Login (`/login` inside the sandbox) happens **once per sandbox** — macOS
  Keychain credentials can't be shared, container credentials live in
  `dot-claude/` and survive rebuilds.
- The `create` wizard imports only what you select: MCP servers from
  `~/.claude.json`, skills, `settings.json` (hooks always stripped — they may
  reference host paths; status line config is carried along). Auto-create
  (via `start`) imports settings only.

## Claude Desktop / SSH access

`vivary up` runs the sandbox with sshd and prints everything needed. In Claude
Desktop: Code tab → environment dropdown → **"+ Add SSH connection"** → enter
the config alias `claude-sandbox-<name>` as the host.

- Per-sandbox ed25519 keypair; public key = container's `authorized_keys`.
- SSH **host keys persist** across rebuilds (no known_hosts churn); `up`
  pre-registers them in `~/.ssh/known_hosts` and maintains a marker-delimited
  `Host` block in `~/.ssh/config`. The block is **prepended** — in ssh_config
  the first obtained value wins, and a global `UserKnownHostsFile /dev/null`
  later in the file would break Desktop's host verification.
- Apple `container`: direct connection to `claude-sandbox-<name>.<dns-domain>:22`
  (no published ports, no conflicts). Docker: `localhost:2222` (`SSH_PORT=`).
- Non-interactive SSH sessions get `CLAUDE_CONFIG_DIR`, `PLAYWRIGHT_BROWSERS_PATH`,
  `DISPLAY` and PATH via `sshd_config SetEnv`.
- The Desktop remote daemon's unix sockets can't be chmod'ed on the virtiofs
  mount (EINVAL), so the entrypoint symlinks `~/.claude/remote/run` to the
  VM-local filesystem.

**Where things execute**: with Desktop connected over SSH, the agent, Bash,
builds and sandbox-configured MCP servers run **in the container**; but
Desktop injects its own client-side connectors (e.g. Claude in Chrome) that
execute **on the host** — disable them in Desktop settings if you want the
session fully contained. Plain CLI sessions (`slaude`, `vivary start`) have no
host-side channel at all.

## Security boundary

The container sees only: the workspace, its own per-sandbox state, and the
host's chat history. No SSH keys, no Keychain, no Docker socket. Chromium runs
with `--no-sandbox` inside the already-isolated container. Network is open
(agents need internet); restrict it in `commonRunArgs` (cli/vivary.mjs) if needed.
Apple `container` runs each sandbox in its own lightweight VM — a stronger
boundary than Docker's shared-kernel isolation.

## Apple `container` specifics

Verified with `container` CLI 1.1.0. Handled automatically:

- **Builder DNS bug**: the buildkit VM breaks Node.js DNS (`EAI_AGAIN`), so
  `npm install` can never succeed in a native `container build`. `vivary build`
  builds with Docker and loads via `container image load`
  (`SANDBOX_NATIVE_BUILD=1` forces native).
- **Runtime AAAA DNS bug**: the gateway DNS proxy mishandles AAAA queries from
  glibc (breaks Node/curl). Entrypoints append `options no-aaaa` to
  `/etc/resolv.conf` via the `fix-net` sudo helper (`SKIP_NET_FIX=1` opts out).
- **`host.docker.internal`**: no native equivalent / `--add-host`; `fix-net`
  maps it (and `gateway.docker.internal`) to the gateway = the host. Under
  Docker the embedded DNS mapping is left untouched.
- **Resources**: VMs default to 1 GB / 4 CPUs — too little for browser work,
  so `vivary` defaults to 4 GB / 4 CPUs.
- **Headed browser must run in the main process tree**: Chromium launched from
  a `container exec` session renders a white/corrupted window into Xvfb (exec
  path bug; fine under Docker). Everything the agent spawns in its session,
  and SSH sessions, are in the main tree and render correctly.

**Host-side gotchas** (macOS): container→host connections can be silently
black-holed even though TCP handshakes succeed (the egress proxy ACKs every
SYN — closed ports look "open"). Two switches must be open: System Settings →
Privacy & Security → **Local Network** for `container-runtime-linux`, and any
third-party firewall (e.g. Norton) must allow the flow — watch for its prompt.

## Repository layout

```
cli/vivary.mjs         thin CLI entry (command dispatch, launcher dispatch)
cli/core/              runtime abstraction, sandbox registry, lifecycle,
                       broker kernel, image composer, plugin loader
cli/plugins/<name>/    one feature = one plugin:
                       plugin.mjs         host side (flags, run args, broker routes)
                       image.dockerfile   fragment baked into the fat image
                       rootfs/            files copied into the image
                       entrypoint.d/      startup hooks (self-gated by env)
cli/image/             core image (toolchain) + entrypoint runner
bench/                 performance benchmarks
```

**Architecture**: a small core plus plugins (headed, ssh, docker, host-open,
clipboard, own-modules, agent-claude, agent-codex). `vivary build` composes
ONE fat image from the core Dockerfile and every plugin fragment; features
activate at runtime via env variables, so a single image serves all
sandboxes. The container entrypoint just runs `/etc/entrypoint.d/*.sh` —
each hook checks its own env variable.
