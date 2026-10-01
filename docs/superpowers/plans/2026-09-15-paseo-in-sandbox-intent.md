# Intent: drive sandboxed agents from Paseo

Status: **research + intent only.** Nothing implemented, nothing decided.
Date: 2026-09-15

## The problem, stated precisely

Paseo cannot control the Claude Code running inside a vivary sandbox.

Not a bug — an architectural mismatch. Paseo is a **daemon plus clients**: the
daemon manages coding agents *on the machine it runs on*, and clients (iOS,
Android, desktop, web, CLI) connect to it. `public-docs/claude-code.md` is
explicit that it "runs Claude Code through the official `claude` CLI using the
Claude Agent SDK" and uses "that existing installation and account" on the
daemon's machine.

A vivary sandbox keeps all three of those things inside the container: the agent
binaries, their logins (`~/.vivary/<name>/dot-claude`) and the workspace mount.
A daemon on the Mac sees none of it. There is nothing for it to drive.

## Why "a thin Paseo client in the container" is the wrong shape

The idea as first framed was to expose a thin *client* from the sandbox. That
inverts the architecture: clients are the remote controls, the daemon is what
holds and runs agents. A client inside the container would have nothing to
control, and would still need a daemon to talk to.

**The thing that belongs in the sandbox is the daemon.** Paseo already ships
exactly this shape: `ghcr.io/getpaseo/paseo` runs daemon + bundled web UI on
`0.0.0.0:6767` and deliberately **does not bundle agent CLIs** —
`docker/Dockerfile.agents.example` shows the expected pattern of a child image
that `npm install -g`s the agents you want.

Our image is already that child image. It has claude, codex and cursor-agent
baked in, pinned and refreshed weekly.

## What is already in place

This lands on top of work that exists, which is most of why it looks cheap:

| Paseo needs | vivary already has |
|---|---|
| SSH transport — daemon at `127.0.0.1:6767` on the remote host | `--ssh`, sshd in the sandbox, managed ssh_config, device keys |
| Tailscale transport | `--tailscale`, per-sandbox published port on the tailnet |
| A published port | ports plugin (`-p`), tailscale publish |
| Agent CLIs on the daemon's machine | claude / codex / cursor-agent in the image |
| Agent logins on that machine | per-sandbox `dot-claude` / `dot-codex` / `dot-cursor` mounts |
| PID 1 that reaps | tini (their base image does the same) |

Paseo's own SSH transport expects the daemon at `127.0.0.1:6767` **on the remote
host** — which is exactly what a `vivary up --ssh` sandbox is. On paper a client
should reach it with `paseo --host ssh://agent@claude-sandbox-<name>`.

## Sketch of the shape (not a plan)

A `paseo` plugin, same skeleton as the others:

- `image.dockerfile` — install the daemon (Node package, so no build toolchain,
  unlike the Swift claude-bridge looked at earlier) with a version cache key
- `entrypoint.d/NN-paseo.sh` — start the daemon, gated on `SANDBOX_PASEO`
- `plugin.mjs` — sticky `--paseo` flag, per-sandbox state mount for
  `~/.paseo`, generated `PASEO_PASSWORD`, port publish
- health check via `/api/health`, which the daemon already exposes

One daemon per sandbox, not one daemon for all: it keeps the existing isolation
boundary intact and needs no new mechanism.

## Open questions — answer before committing to anything

1. ~~Is the daemon actually on npm?~~ **RESOLVED — yes, under a scope.**
   The bare `paseo` name is a squatted, unrelated package (a `create-next-app`
   bootstrap from `github.com/wahyueskaking/holo`, one version, no `bin`), which
   is what made the first check look wrong. The real packages are
   `@getpaseo/*` at 0.8.0 — matching the repo — with `0.9.0-beta.2` on the
   `beta` tag. `@getpaseo/cli` carries `bin.paseo` and pulls in
   `@getpaseo/server` (34 MB); both are `os: any, cpu: any`.
   Verified by installing into our own image: `npm install -g @getpaseo/cli`
   succeeds (as root, i.e. at build time — as `agent` it is EACCES on
   `/usr/lib/node_modules`), giving `/usr/bin/paseo` 0.8.0 with `paseo start`
   ("Start the local Paseo daemon"), `paseo onboard` (first-run setup + pairing
   instructions) and a `paseo daemon` command group.
   **So the image fragment is three lines, not a build stage.**
2. **Does the Agent SDK path hit the same capability gap we just found?**
   Paseo drives Claude Code through the Agent SDK against the `claude` CLI.
   Measured on 2026-09-15: a plain `claude -p` has no `Artifact` tool unless
   `CLAUDE_CODE_ENTRYPOINT=claude-desktop` is set. Whatever else keys off that
   variable may also be absent under Paseo. Worth checking before promising
   feature parity with the desktop-app path.
3. **Resources.** A daemon plus N parallel agents inside one sandbox, times
   several sandboxes. The RAM arithmetic that bit this Mac earlier applies.
4. **Where may the port be reachable?** Same reasoning as `vivary web`: the
   management surface must not land somewhere other sandboxes can reach. The
   daemon does have its own `PASEO_PASSWORD`, which helps.
5. **Does the relay transport matter?** If mobile clients are meant to use the
   Paseo relay rather than Tailscale, outbound from the sandbox becomes part of
   the threat model — and with `--egress` it needs an allow-list entry.

## Measured 2026-09-20 — the transport works

Run against a real sandbox (`memtest`, `--ssh`, Apple `container`), no plugin
written:

1. `sudo npm install -g @getpaseo/cli` inside the sandbox → `/usr/bin/paseo` 0.8.0.
2. `paseo start` → daemon up, **listening on `127.0.0.1:6767`** — exactly where
   the SSH transport expects it. `paseo status` reports reachable.
3. From the Mac: `paseo --host ssh://agent@claude-sandbox-memtest ls --json`
   → **exit 0, `[]`**. The round-trip works through the managed ssh_config with
   no Paseo-specific setup at all.

So the central assumption holds: a vivary `--ssh` sandbox *is* the "remote host
with a daemon on 6767" that Paseo already knows how to talk to.

### Two things the measurement turned up

**The daemon downloads ~1 GB of speech models on first start, unasked.**
`du -sh ~/.paseo` → **985 MB**, all under `models/local-speech`
(`parakeet-tdt-0.6b-v2-int8`, `kokoro-en-v0_19`), begun seconds after
`paseo start`. Per sandbox. That is not acceptable as a default here — the
plugin must either disable local speech or point every sandbox at one shared
model directory. Find the config knob before anything else; this alone could
make the feature worse than not having it.

**node-pty survives our npm hardening.** The install warned that scripts were
blocked for `esbuild` and `node-pty` (uunpm's `ignore-scripts` posture), which
looked fatal for a PTY-based agent runner — but the package ships prebuilds and
`require('node-pty')` loads fine. No action needed; noted so the warning is not
mistaken for a problem later.

### The phone works — verified 2026-09-20

A Paseo phone client reached a daemon running **inside a sandbox** over the
tailnet, and authenticated. Confirmed by the user on a real device, so the
whole remote-control premise holds.

Shape that got there, all of it measured:

- daemon inside the sandbox on `PASEO_LISTEN=0.0.0.0:<port>`
- vivary publishes that port (`-p 0.0.0.0:<port>:<port>`); the sandbox has no
  tailnet identity of its own, so the HOST does the tailnet exposure — Paseo's
  own docs assume a daemon machine with its own Tailscale IP and **do not apply
  verbatim here**
- `PASEO_HOSTNAMES` must list the MagicDNS name. Without it the daemon answers
  the IP but returns **403** on the hostname (Host-header check), and the phone
  connects by name
- `PASEO_PASSWORD` — mandatory in this shape, since publishing on the tailnet
  exposes the daemon to every device on it. Note `/api/health` is exempt from
  auth by design, so a 200 there proves nothing about protection; the real check
  is an API call returning `Password required`
- SSH transport (CLI/desktop) worked too, straight through the managed
  ssh_config. **Mobile clients cannot use SSH** — relay or Tailscale only

### PORT: never hardcode 6767

Measured on this Mac before vivary touched anything:

| port | held by |
|---|---|
| 6767 | the user's OWN Paseo daemon (`127.0.0.1`) |
| 6768 | `IPNExtens` — the Tailscale extension itself |

A first attempt published the sandbox on `*:6767`, which **shadowed the user's
own daemon on the tailnet**: their loopback bind still won locally, but every
tailnet device reaching `:6767` got the sandbox instead. The plugin must take a
port from `assignStablePort` (as ssh does) and probe it with a real bind —
`lsof` alone does not prove a port is free.

### Bundled web UI is off by default

`/` returns 404 on a CLI-managed daemon; the browser UI ships enabled only in
their Docker image. Turn it on with `PASEO_WEB_UI_ENABLED=true` or
`features.webUi.enabled`. The native phone app does not need it — it talks to
the API.

### SSL — solved by `tailscale serve`, verified 2026-09-20

Certificates work now. They did not before: the machine was named
`ji---macbook-pro-2-1`, and `--` in positions 3-4 is a reserved (R-LDH) label
that Let's Encrypt refuses — `tlsv1 alert internal error`. After the rename to
`jdk-macbook14-m3`, `tailscale cert` issues normally.

Measured end to end on a throwaway server:

    tailscale serve --bg --https=8443 http://127.0.0.1:6790
    curl https://jdk-macbook14-m3.taila4682.ts.net:8443/   # no -k

→ HTTP 200, `ssl_verify_result 0`, issuer `Let's Encrypt CN=YE2`. **A custom
HTTPS port works**, so :443 need not be monopolised.

This gives a better shape than the 0.0.0.0 publish used while testing:

    container :PORT  →  published to HOST 127.0.0.1:PORT  →  tailscale serve
                        --https=TSPORT  →  tailnet, TLS, real cert

Nothing binds 0.0.0.0, nothing lands on the LAN, no certificate management in
vivary, and it matches the ports plugin's existing default (a missing host-ip
binds loopback). Two ports per sandbox: the loopback publish and the tailnet
HTTPS port — both from `assignStablePort`, under distinct keys.

### Ports — the existing mechanism is already right

`assignStablePort` is NOT base+offset: it hashes the sandbox name into a span,
skips every port recorded by another sandbox, and probes with `hostPortFree`,
which does a real `listen()` on 0.0.0.0 rather than trusting `lsof`. It dies
loudly when the span is exhausted. Reuse it; add the new keys to `PORT_KEYS` so
sandboxes avoid each other's Paseo ports too.

CORRECTION to an earlier note in this document: 6768 is not held by "the
Tailscale extension" for its own purposes. `tailscale serve status` shows the
user already runs

    https://jdk-macbook14-m3.taila4682.ts.net:6768  ->  proxy http://127.0.0.1:6767

i.e. their OWN Paseo daemon, already published over HTTPS by exactly the
mechanism proposed above. So the allocator must also avoid ports already claimed
by existing serve rules — `tailscale serve status` is the place to read them,
and `hostPortFree` catches them anyway since the extension holds the socket.

### Not yet verified

Actually driving an agent. `paseo run --provider claude` returned
`Failed to create agent: Caller agent <uuid> not found` — a Paseo-side error,
not an auth one; it likely wants a registered workspace/project first. The test
sandbox also had no Claude login, so this could not have succeeded anyway.
**Whether Paseo can genuinely drive the sandboxed Claude Code is still open** —
the one thing left. Transport, auth and the phone are all proven; what is
untested is a real agent turn, which needs a sandbox with a live Claude login.

## Rough effort, conditional on question 1

With question 1 resolved in favour of the cheap branch: **~3–4 hours** —
image fragment (`npm install -g @getpaseo/cli`, version cache key), entrypoint
hook running `paseo start`, sticky flag, state mount, port publish, smoke test.

That assumes the SSH transport works against a sandbox as-is. It is the cheapest
thing left to verify and should be checked first: install the CLI in a running
sandbox, `paseo start`, then `paseo --host ssh://agent@claude-sandbox-<name> ls`
from the Mac. If that round-trips, the rest is plumbing we have already built
three times.

## Relationship to Tailscode

Tailscode (also cloned alongside) answers a similar question with a different
architecture: its clients drive opencode / claude-bridge / omp-bridge over a tailnet.
Paseo is the broader fit — more providers, already containerised, and its
transports match what vivary already publishes. If only one gets built, this is
the one.
