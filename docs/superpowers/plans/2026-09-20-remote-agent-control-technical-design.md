# Technical design: remote control of sandboxed agents

Business intent: `2026-09-20-remote-agent-control-business-design.md`
Measurements and traps behind every claim here: `2026-09-15-paseo-in-sandbox-intent.md`

Status: design. Not implemented. One open question in §9 gates it.

---

## 1. Architecture

One Paseo daemon per sandbox, reached over the tailnet with TLS terminated by
Tailscale on the host.

```
  phone / iPad / desktop client
        │  tailnet (WireGuard) + HTTPS, real Let's Encrypt cert
        ▼
  tailscale serve --https=<tsPaseoPort>            ... on the Mac
        │  proxy to host loopback
        ▼
  127.0.0.1:<paseoPort>                            ... vivary port publish
        │  container port mapping
        ▼
  paseo daemon, PASEO_LISTEN=0.0.0.0:<paseoPort>   ... inside the sandbox
        │  spawns via Claude Agent SDK / provider CLIs
        ▼
  claude · codex · cursor-agent                    ... already in the image,
                                                       logged in via the
                                                       per-sandbox state mounts
```

Two properties this shape buys, both deliberate:

**Nothing binds `0.0.0.0` on the host.** The publish is loopback-only (the ports
plugin's default when no host-ip is given). Tailscale is the only thing that
exposes it, and it exposes it to the tailnet alone. A sandbox is therefore not
reachable from the LAN, and not reachable from another sandbox.

**vivary manages no certificates.** `tailscale serve` terminates TLS with a
Let's Encrypt certificate it renews itself. We never hold a private key.

### Why the daemon is inside, not on the host

Paseo drives agents *on the machine the daemon runs on*, using those agents'
existing CLI installations and logins. In vivary, all three live inside the
container. A host daemon has nothing to drive. This is the whole reason the
feature does not work today.

## 1.1 Hard dependency: Tailscale

Remote reach requires Tailscale on the host **and** on the client device. This
is not our constraint — Paseo's own connectivity model is: SSH tunnelling for
desktop and CLI, relay or Tailscale for mobile clients. With the relay ruled out
(it routes through third-party infrastructure, which the business design
refuses), Tailscale is the only path a phone can take.

| client | without Tailscale |
|---|---|
| phone / tablet | **no** — mobile clients cannot use SSH |
| desktop / CLI | yes — SSH transport, verified |
| browser on the Mac | yes — loopback |

Tailscale is load-bearing a second, less obvious time: it is also where the TLS
certificate comes from. Without `tailscale serve` we would have to issue and
renew certificates ourselves, or serve plaintext — and the business design
commits to encrypted transport.

So `--paseo` without `--tailscale` is a sandbox reachable only from the Mac that
started it. The plugin turns `--tailscale` on rather than failing, and says so;
but a host with Tailscale stopped gets a loud warning and a local-only daemon,
never a silent plaintext fallback.

## 2. New plugin: `paseo`

`cli/plugins/paseo/`, order 55 (after the ssh/tailscale plugins it depends on,
before the agent plugins).

### 2.1 Flag

| flag | type | sticky | meaning |
|---|---|---|---|
| `--paseo` | boolean | yes | run the Paseo daemon and publish it over the tailnet |

`--paseo` implies remote reachability, so it must satisfy `requireReachable()`
in `cmdUp` alongside `--ssh` and `--tailscale` — otherwise a sandbox that is
demonstrably reachable would be refused. It also requires `--tailscale`
(for the published port and MagicDNS name); asking for `--paseo` without it
should turn it on rather than fail, and say so.

### 2.2 Image fragment

```dockerfile
ARG PASEO_VERSION=latest
RUN echo "paseo cache key: ${PASEO_VERSION}" > /dev/null \
    && npm install -g @getpaseo/cli@latest
```

Cache key, not a pin — the same convention the agent plugins now use. The
version comes from `buildArgs()` via `resolveNpmVersion('@getpaseo/cli')`, which
already exists in `core/util.mjs`. Cost: ~35 MB (`@getpaseo/server` is the bulk).

`node-pty` ships prebuilt binaries, so the image's `ignore-scripts` posture does
not break it. No `--allow-scripts` needed.

### 2.3 Ports

Two, both from `assignStablePort` — which hashes the sandbox name into a span,
skips ports recorded by other sandboxes, and probes with a real `listen()`:

| key | base | purpose |
|---|---|---|
| `paseoPort` | 6800 | container port, published to host loopback |
| `tsPaseoPort` | 8400 | tailnet HTTPS port for `tailscale serve` |

Both keys must be added to `PORT_KEYS` in `core/sandbox.mjs`, or sandboxes will
hand each other the same port.

Bases avoid 6767/6768 on purpose: those are taken by the owner's own Paseo
daemon and its existing serve rule. The allocator would catch that anyway
(`hostPortFree` binds for real), but the base should not start a collision it
then has to walk past.

### 2.4 State

`~/.vivary/<name>/dot-paseo` → `/home/agent/.paseo`, mounted per sandbox like
`dot-claude`. Holds the agent registry and config, so remote agents survive a
container restart — which matters now that containers persist.

### 2.5 Runtime environment

Set by the entrypoint hook, gated on `SANDBOX_PASEO`:

| variable | value | why |
|---|---|---|
| `PASEO_LISTEN` | `0.0.0.0:<paseoPort>` | the container's own interface; host publish does the rest |
| `PASEO_HOSTNAMES` | the MagicDNS name | the daemon checks `Host` and answers **403** otherwise — and clients connect by name |
| `PASEO_HOME` | `/home/agent/.paseo` | the mounted state dir |
| `PASEO_DICTATION_ENABLED` | `0` | see below |
| `PASEO_VOICE_MODE_ENABLED` | `0` | see below |
| `PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD` | `0` | belt and braces; alone it is NOT sufficient |

**Speech must be off by default.** A default daemon downloads ~985 MB of ONNX
speech models on first start, per sandbox, unasked. Disabling the two features
is what stops it; the auto-download flag alone still pulled 218 MB. If voice is
ever wanted, `PASEO_LOCAL_MODELS_DIR` can point every sandbox at one shared
directory so the gigabyte is paid once.

## 3. Authentication

Generated per sandbox at first `up`, stored in
`~/.vivary/<name>/paseo-password` mode 0600 — the same shape as the broker
token.

**The password has to be typed by a human, on a phone, from a screen.** A
base64 blob fails that: it is slow to read, easy to mistype and impossible to
dictate. So it is generated as syllables instead — consonant+vowel pairs, in
dash-separated groups:

    guhuki-pabati-pahuva-vajosu
    kitefa-fodiru-karuva-pevofi

Alphabet, chosen for unambiguity rather than size:

- consonants `bdfghjkmnprstvz` — no `l` (confusable with `1` and `I`), none of
  `c q w x y` (read differently in Czech and English)
- vowels `aeiou`
- no digits, no mixed case, no punctuation but the group separator

That is 75 syllables, 6.23 bits each. The default **4 groups of 3 syllables =
74.7 bits** in 27 characters. Every syllable is pronounceable by construction,
so it can be read aloud or dictated.

3×3 (56 bits, 20 characters) is also defensible for a service that is only
reachable inside the owner's own tailnet and has no public attack surface; 4×3
is the default because the extra seven characters cost nothing when the password
is typed once per device.

It must be **persisted into the daemon's own config**, not only passed as
`PASEO_PASSWORD`. Measured: the env variable is hashed at startup and held in
memory; `config.json` keeps no `auth` block. A daemon later started without the
variable would therefore come up unauthenticated on the tailnet. The hook should
run `paseo daemon set-password` on first start so the bcrypt hash lands in
`config.json` and survives.

`/api/health` is exempt from authentication by design, so a 200 there proves
liveness and nothing else. Any check that claims to verify protection must call
a real endpoint and see `Password required`.

The password is shown once at `up`, and by `vivary paseo info <name>` (§5).

## 4. Host side: the serve rule

`postUp`, after the container is running:

```
tailscale serve --bg --https=<tsPaseoPort> http://127.0.0.1:<paseoPort>
```

`onRemove` (not `onPurge` — it must run on every `rm`) tears it down:

```
tailscale serve --https=<tsPaseoPort> off
```

Leaving a stale rule behind would point a tailnet HTTPS port at a dead loopback
port, and the next sandbox to take that port would inherit the URL. The ssh
plugin's managed-block cleanup is the precedent.

## 5. New command

`vivary paseo info [name]` — prints the URL, the password and the connection
instructions for the app. `up` prints it too, but the password scrolls away and
it is the one thing the owner needs on a second device.

## 6. Failure modes

Each must be loud. This is a remote-access surface; silent degradation is the
one outcome worse than not building it.

| condition | behaviour |
|---|---|
| Tailscale not running / no MagicDNS name | daemon still starts, bound to loopback; WARN that it is unreachable remotely and why |
| HTTPS certificate cannot be issued | WARN naming the cause; **do not** silently fall back to plain HTTP — the business design commits to encrypted |
| `tailscale serve` fails | WARN, keep the sandbox up, say the daemon is local-only |
| port span exhausted | `assignStablePort` dies loudly already |
| daemon exits after start | hook must not block the entrypoint; report at next `up` and in `paseo info` |
| flag turned on for an existing kept container | the config snapshot already refuses the restart and names the change; `--recreate` is the documented fix |

A machine name with `--` in positions 3–4 makes certificates impossible
(reserved R-LDH label; Let's Encrypt rejects it, TLS dies with
`tlsv1 alert internal error`). If `tailscale cert` fails, the warning should name
this as the likely cause, because the error itself is opaque.

## 7. Changes to existing code

| file | change |
|---|---|
| `core/sandbox.mjs` | `PORT_KEYS` += `paseoPort`, `tsPaseoPort` |
| `core/lifecycle.mjs` | `requireReachable` accepts `--paseo` as a way in |
| `cli/vivary.mjs` | help entry for `--paseo` and `paseo info` |
| `CLAUDE.md` | the gotchas: 403 on Host, speech download, env-only password |

Nothing else. The port allocator, the publish path, the tailnet plumbing, the
persistent-container snapshot and the weekly image refresh all apply unchanged.

## 8. Test plan

Unit (pure, in `cli/test/`):
- port keys are distinct and both registered in `PORT_KEYS`
- env assembly: speech disabled, hostnames set, listen address correct
- `requireReachable` accepts `--paseo` alone
- password generation: length, charset, file mode 0600

Integration, against a real sandbox:
- `up --paseo` → daemon listens; `~/.paseo` stays under 1 MB (speech off)
- API without credentials → `Password required`; `/api/health` → 200
- `https://<magicdns>:<tsPaseoPort>/api/health` → 200 with a **verified** chain
  (`curl` without `-k`)
- MagicDNS name answers, not just the IP (the 403 regression)
- `rm` → serve rule gone from `tailscale serve status`
- two sandboxes with `--paseo` → different ports, both reachable

## 9. The open question that gates all of this

**Can Paseo actually drive an agent inside a sandbox?**

Transport, TLS, authentication and a real phone connection are demonstrated.
What is not is one agent turn: started remotely, executed in the sandbox,
streamed back. A first attempt returned `Failed to create agent: Caller agent
<uuid> not found`, which looks like a missing workspace/project registration
rather than an auth failure — but the sandbox used for that test had no agent
login, so it could not have succeeded regardless.

There is also a known capability gap to check while doing it: a bare `claude`
CLI has no `Artifact` tool unless `CLAUDE_CODE_ENTRYPOINT=claude-desktop` is
set. Whatever else keys off that variable may be missing under Paseo too, so
feature parity with the desktop-app path should not be assumed.

Needs a sandbox with a live login and about ten minutes. Until it is answered,
this design is sound but unproven and should not be built.
