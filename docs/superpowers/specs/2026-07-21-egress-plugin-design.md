# vivary `egress` plugin — design spec

**Date:** 2026-07-21 · **Owner:** Jiří Dudek · **Status:** approved, ready for implementation

## 1. Goal

Add an opt-in, sticky **egress-control** feature to vivary: when a sandbox is
started with `--egress`, all of its outbound network traffic is forced through
**ASHP** (https://github.com/jiridudekusy/ashp) running as a **transparent MITM
proxy**. This gives **default-deny outbound** with per-request logging and human
approval — the biggest remaining security gap in vivary.

This is a **defensive security feature** (egress policy / DLP-style control),
explicitly NOT bypass or evasion. The agent inside the sandbox is the untrusted
party; ASHP + the network topology are the trust boundary.

## 2. Verified facts (empirical, this session — do NOT re-litigate)

All confirmed by running commands on Apple `container` 1.1.0 on this host:

- **Apple VM NIC cap = 4** per container (`VZErrorDomain Code=2` on the 5th
  `--network`). Rules out a hub-and-spoke pool beyond 3 isolated nets — hence
  the shared-net design below.
- **Privileged-port bind:** Apple leaves `net.ipv4.ip_unprivileged_port_start=1024`
  (Docker sets 0). ASHP's non-root `ashp` proxy therefore fails `bind :443`
  with "permission denied". **Fix (verified):** a root entrypoint runs
  `sysctl -w net.ipv4.ip_unprivileged_port_start=0` before ASHP drops privileges.
  Plain root has CAP_NET_ADMIN by default — no `--cap-add` needed for the sysctl.
  After the fix the full ASHP chain works on Apple: dnsmasq :53 catch-all,
  SNI :443/:80 intercept → "Blocked by ASHP" 403, mgmt :3000, CA endpoint.
- **Host reaches containers on an `--internal` net** via the host bridge
  (`bridge10X`, gateway `.1`). Internal net blocks external egress but NOT
  host↔container.
- **Source-IP discrimination (the key to isolation):** host-originated traffic
  arrives at a container's netfilter with **source = gateway `.1`**; peer
  containers arrive with their own `.x`. Verified end-to-end with an ingress
  firewall:
  - `iptables -P INPUT DROP; -A INPUT -i lo -j ACCEPT; -A INPUT -m conntrack
    --ctstate ESTABLISHED,RELATED -j ACCEPT; -A INPUT -s <gw> -j ACCEPT`
  - Result: **peer→sandbox DROPPED**, **host→sandbox (ssh) OK**, **sandbox
    outbound (egress via ASHP, broker) OK** via ESTABLISHED return.
- **GOTCHA:** image `iptables` is nf_tables (`iptables-nft`); its `-vnL`/policy
  counters and `LOG` target were unreliable here (0 counts while rules fired).
  Trust end-to-end curl outcomes, not nft counters, when debugging.
- Image already ships `iptables`, `curl`, `update-ca-certificates`,
  `/usr/share/ca-certificates` — no new image packages needed.

## 3. Architecture

### 3.1 Topology — one shared internal net + per-sandbox ingress firewall

- One shared internal network **`vivary-egress`** (`container network create
  --internal vivary-egress`; lowercase name required).
- **ASHP is dual-homed:** `default` (upstream egress to the internet) +
  `vivary-egress` (faces the sandboxes) = **2 NICs**, well under the 4-NIC cap,
  **no restart ever** as sandboxes come and go, **no cap** on sandbox count.
- Each egress sandbox is attached **only** to `vivary-egress` (NOT `default`) →
  it has no direct route to the internet; the only way out is via ASHP.
- **Inter-sandbox isolation** is enforced inside each sandbox by an ingress
  firewall (see 2 above): peers cannot initiate connections to each other, but
  the host still reaches each sandbox (ssh/broker) and each sandbox's own
  outbound still works. This replaces per-sandbox nets — same isolation,
  no NIC-cap problem.

### 3.2 ASHP as a shared vivary-managed service (mirror the broker)

- Lazy-started like the broker. State dir **`~/claude-sandboxes/.ashp/`**:
  - `ashp.json` (config, `default_behavior: deny`, transparent mode on)
  - `data/ashp.db` (SQLite, SQLCipher-encrypted)
  - secrets generated `0600` on first start (like the broker token):
    `ASHP_DB_KEY`, `ASHP_LOG_KEY` (hex32), `ASHP_CA_KEY`, admin password.
    Store in `~/claude-sandboxes/.ashp/secrets.json` (0600) or discrete files.
- Started via `<runtime> run -d` with:
  - `--entrypoint /vivary/pre-entrypoint.sh` + a bind-mounted wrapper that runs
    `sysctl -w net.ipv4.ip_unprivileged_port_start=0` then `exec /app/entrypoint.sh "$@"`
    (wrapper ships at `cli/plugins/egress/ashp/pre-entrypoint.sh`).
  - `--network default --network vivary-egress`
  - `-v <state>/ashp.json:/etc/ashp/ashp.json:ro`, `-v <state>/data:/data`
  - `-e ASHP_TRANSPARENT=true`, the secrets as env, and
    `-e ASHP_TRANSPARENT_IP=<ashp's vivary-egress IP>` (multi-homed → must pin
    which IP the dnsmasq catch-all resolves to; discover via `container inspect`
    after the container is up, or compute the vivary-egress subnet's `.2`).
- Health/readiness: poll `GET http://<ashp-ip>:3000/` (or a health route) with a
  timeout loop, like `brokerHealthy()`.
- **Lifecycle default:** ASHP stays running after the last egress sandbox is
  `down` (cheap, avoids churn) — like the broker. Provide `vivary egress stop`
  (and maybe `vivary egress status`/`logs`) as plugin `commands`.
- **Runtime difference:** on Docker `docker network connect` could hot-attach,
  but the design keeps ASHP attached to `vivary-egress` from start on both
  runtimes for uniformity. No per-sandbox restart on either runtime.

### 3.3 Per-sandbox ASHP identity

- Each egress sandbox = one ASHP "agent" (name = sandbox name, own token).
- Host side ensures the ASHP agent + token exist (create via ASHP admin API if
  missing; persist token in the sandbox's `sandbox.json`, e.g. `egressToken`,
  or in `.ashp/agents/<name>`), and passes name+token to the sandbox as env.
- **The sandbox self-registers its own IP** with ASHP at boot (POST
  `/api/agents/register-ip` `{name, token, ip_address}` — confirm exact shape
  against the ashp repo). Self-registration from inside the sandbox handles BOTH
  `vivary start` (foreground `run --rm`, no postUp) and `vivary up` (detached)
  uniformly — the host can't easily know a foreground container's IP pre-exec.

> **Confirm ASHP API shapes against the source**, don't guess: reference clone at
> `<scratchpad>/ashp` (re-clone `gh repo clone jiridudekusy/ashp` if gone) and
> its `run/{docker-compose.yml,ashp.json,entrypoint-sandbox.sh,Dockerfile.sandbox}`.
> Image `jiridudekusy/ashp:latest` is already pulled (Docker) — load into Apple
> with `docker save … | container image load` (or the smoke script pattern).

## 4. Components to build

### 4.1 `cli/plugins/egress/plugin.mjs`

- `name: 'egress'`, `order: 5` (runs early; but note entrypoint.d ordering is by
  filename, see 4.3).
- `flags.egress`: `{ type: 'boolean', sticky: true, cfgKey: 'egress', help: … }`.
- `needsCaps: (cfg) => !!cfg.egress` (firewall needs CAP_NET_ADMIN → core adds
  `--cap-add ALL` on Apple).
- `runArgs(ctx)` (async): when `cfg.egress`:
  1. ensure `vivary-egress` net exists (create `--internal` if missing).
  2. ensure ASHP service running (module 4.2); get its vivary-egress IP.
  3. ensure ASHP agent+token for this sandbox; get token.
  4. return `['--network', 'vivary-egress', '-e', 'SANDBOX_EGRESS=1', '-e',
     `SBX_EGRESS_ASHP_IP=<ip>`, '-e', `SBX_EGRESS_AGENT=<name>`, '-e',
     `SBX_EGRESS_TOKEN=<token>']`. (Attaching only `vivary-egress` — no
     `default` — is what removes the sandbox's direct egress; verified that a
     lone `--network X` yields no default IP.)
- `commands`: `{ egress: fn }` for `vivary egress stop|status|logs`.
- Keep host-integration invariant: **no `--egress` → nothing happens** (all
  gated on `cfg.egress`).

### 4.2 `cli/plugins/egress/ashp.mjs` (service kernel, mirror `core/broker.mjs`)

- `ensureAshp(runtime)`: idempotent lazy start; returns `{ ip, adminPassword }`.
- secrets bootstrap (0600), `ashp.json` render, network ensure, health poll.
- `ensureAgent(name)` → token (create via admin API if absent; persist).
- `cmdEgress(argv)` for stop/status/logs.
- `ashp/pre-entrypoint.sh` wrapper (sysctl fix) lives here.

### 4.3 Sandbox-side: root helper + entrypoint hook

- **One root helper** `cli/plugins/egress/rootfs/egress-setup.sh` →
  `/usr/local/bin/egress-setup`, run as root via sudo. Does, in order:
  1. **DNS:** set `/etc/resolv.conf` nameserver = `$SBX_EGRESS_ASHP_IP`; keep
     `options no-aaaa`. `host.docker.internal` stays in `/etc/hosts` (added by
     fix-net) so broker/clipboard/host-open keep resolving locally (DNS catch-all
     never sees it). If tailscale is also on, tailnet names are in `/etc/hosts`
     too → also exempt. (resolv.conf/hosts precedence: /etc/hosts wins.)
  2. **CA:** `curl -s http://$SBX_EGRESS_ASHP_IP:3000/api/ca/certificate` →
     `/usr/local/share/ca-certificates/ashp.crt` → `update-ca-certificates`.
     Also export `NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE` via
     `/etc/profile.d/egress-ca.sh` AND ensure sshd `SetEnv` (so ssh / Cursor
     Remote-SSH / Claude Desktop sessions inherit — coordinate with ssh plugin).
  3. **Register:** POST own IP (`ip -4 addr` on the vivary-egress iface) +
     `$SBX_EGRESS_AGENT` + `$SBX_EGRESS_TOKEN` to ASHP `/api/agents/register-ip`.
  4. **Firewall (LAST):** `iptables -P INPUT DROP; -A INPUT -i lo -j ACCEPT;
     -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT;
     -A INPUT -s <gw> -j ACCEPT`. Derive `<gw>` from `ip route` default (fallback
     = subnet `.1`). Idempotent (`-F INPUT` first).
- Pass env into the sudo'd helper as **args** (sudo strips env), e.g.
  `sudo /usr/local/bin/egress-setup "$SBX_EGRESS_ASHP_IP" "$SBX_EGRESS_AGENT" "$SBX_EGRESS_TOKEN"`.
- **Entrypoint hook** `cli/plugins/egress/entrypoint.d/11-egress.sh` (self-gated
  `[ "${SANDBOX_EGRESS:-0}" = 1 ] || exit 0`) → runs the helper. **11** so it
  sorts AFTER `10-fix-net` (which sets resolv.conf + host.docker.internal) and
  BEFORE agent hooks (80+), so the CA is trusted before any agent makes HTTPS.

### 4.4 `cli/plugins/egress/image.dockerfile`

- COPY `rootfs/egress-setup.sh` → `/usr/local/bin/egress-setup`, `chmod +x`.
- sudoers: `echo "agent ALL=(root) NOPASSWD: /usr/local/bin/egress-setup" >
  /etc/sudoers.d/agent-egress`.
- No extra packages (iptables/curl/ca-certificates already present).

## 5. Interactions to preserve (regression checklist)

- **Broker** (host-open/clipboard): sandbox → `host.docker.internal` → the
  vivary-egress gateway `.1` → host broker on `0.0.0.0:7377`. Works because the
  /etc/hosts entry maps host.docker.internal to the default route (= .1 of
  vivary-egress once that's the only net), and broker return traffic is
  ESTABLISHED. **Verify explicitly.**
- **SSH / `vivary ide`**: host → sandbox on vivary-egress, source = gateway `.1`,
  allowed by the firewall. **Verify sshd reachable on an egress sandbox.**
- **fix-net** still runs first (10) and its no-aaaa + host.docker.internal
  mapping must survive the egress DNS rewrite (helper preserves them).
- **tailscale + egress** combined: tailnet names must stay resolvable (exempt
  from catch-all via /etc/hosts). Lower priority; note if out of scope for v1.

## 6. Implementation phases (TDD + empirical verification throughout)

The user strongly values empirical verification over speculation. Each phase
ends with a real run, not an assertion.

1. **ASHP service kernel** (`ashp.mjs` + wrapper): bring ASHP up on the current
   host via the module; assert dnsmasq/:443/:3000/CA all live (reuse the
   verified smoke pattern). Secrets 0600.
2. **Network + plugin skeleton**: `--egress` flag, `vivary-egress` net ensure,
   sandbox attaches only to it. Assert sandbox has no direct egress (curl to
   1.1.1.1 times out) before ASHP DNS is set.
3. **Sandbox egress-setup helper** (DNS+CA+register+firewall) + entrypoint hook
   + image fragment; rebuild image. Assert: (a) external HTTPS from the sandbox
   is intercepted by ASHP (deny→403 until allowed), (b) CA trusted (no cert
   error via Node/curl), (c) inter-sandbox isolation holds (peer→sandbox
   blocked), (d) host→sandbox ssh works, (e) broker roundtrip works.
4. **`vivary egress` subcommands** (stop/status/logs) + wizard/help text.
5. **Full smoke** with `--egress` alongside existing flags; confirm no
   regressions (ssh, broker, clipboard, overlay isolation).

Pre-existing pieces to reuse: the verified `ashp-apple-smoke.sh` /
`pre-entrypoint.sh` / firewall commands from this session's scratchpad
(`<scratchpad>/ashp-test/`).

## 7. Non-goals / deferred

- DNS-rebinding protection (names resolving to private IPs) — out of scope,
  already noted for host-open.
- Egress allow-list UX / policy authoring beyond ASHP's own GUI/API.
- Remote-broker / headless-server ASHP targeting the client machine — separate
  roadmap item.

## 8. Conventions (match the codebase)

- Plugin API per `cli/core/plugins.mjs` header. Sticky opt-in flags. Loud
  failures, never silent. Root helpers via `/etc/sudoers.d/agent-<plugin>` +
  `sudo /usr/local/bin/<helper>` (mirror fix-net / start-dockerd / bind-modules).
- Entrypoint hooks self-gate on their env var and are ordered by `NN-` filename.
- Code/docs in English. Commits: `Co-Authored-By: Claude Fable 5`.
- After CLI changes: `npm install -g ./cli`. After image changes:
  `vivary build`. After broker/service changes: restart.
