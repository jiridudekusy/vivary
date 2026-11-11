# vivary vs Approval MCP: auth, approvals, secrets and UI — gap analysis and plan

Status: proposal, nothing implemented. Written 2026-11-11.

Sources:
- Approval MCP (`~/work/incubator/agent-sandbox/approval-mcp-wrapper`) at `e3460ec`, plus the
  local, uncommitted briefs `docs/agent-briefs/wyvery-approval-auth-model.md` and
  `docs/design/look-and-feel.md` ("Wyvery" there = vivary).
- vivary on `feat/remote-access-and-hardening` at `dc29296`.

Every row below is marked **[exists]** (in vivary today, with where), **[verified]**
(measured on 2026-11-11) or **[proposal]**. A proposal is not a protection.

## 0. What vivary is, compared with Approval MCP

Approval MCP is ONE gateway: agents reach upstream services only through it, it holds
the upstream credentials, and every call is authorized per call (allow / deny / wait for
a human).

vivary is a sandbox manager. It has several separate surfaces, and none of them is a
credential-holding gateway yet:

| Surface | What reaches it | Auth today |
| --- | --- | --- |
| **Broker** (`core/broker.mjs`, :7377 on 0.0.0.0) | every sandbox: host-open, clipboard, OAuth callback relay | per-sandbox token (`SBX_OPEN_TOKEN`) |
| **Web UI** (`plugins/web`, loopback :7378 behind `tailscale serve`) | the user's tailnet devices: list, up/down, SSH device keys | tailnet identity header + allowlist |
| **ASHP** (egress proxy, own UI on :3000) | sandboxes with `--egress`; the user for approvals | admin basic auth (self-signed TLS); per-agent token |
| **Paseo** daemon per sandbox | Paseo apps over the tailnet | per-sandbox password |
| **noVNC** per headed sandbox | browser on Mac / tailnet | per-sandbox VNC password |

## 1. Mapping: Approval MCP component → vivary today → gap

| Approval MCP | vivary today | Gap / proposal |
| --- | --- | --- |
| **Gateway holds upstream credentials; the agent gets only its own identity** | **[exists]** broker and ASHP are gateways for host actions and network. But credentials still go INTO sandboxes: npm tokens as `-e` env (`plugins/npmrc`), Claude/Codex logins in mounted `dot-claude`/`dot-codex`, egress token as env, VNC password as env. | **[proposal]** credential injection at the egress proxy: the sandbox calls `registry.npmjs.org`, ASHP adds `Authorization` from the vault; the agent never holds the token. Needs ASHP support (own project). The agent CLIs' own logins cannot be hidden this way. |
| **Human login: passkey, 12 h revocable session, HttpOnly/SameSite=Strict/Secure cookie, CSRF token, recovery codes** | **[exists]** `tailscale serve` identity header (overwritten by the proxy — measured earlier), allowlist `~/.vivary/web-allow` (default: tailnet owner), loopback bind, CSRF via required `X-Vivary` header + `Sec-Fetch-Site`. No session, no passkey, plain HTTP by default. | **[proposal]** passkey + session + CSRF token on top of the tailnet gate; recovery codes. Today any device logged into the tailnet as the owner can enroll an SSH device key = SSH into every sandbox, with no human-presence check. |
| **Step-up passkey for consent and setup changes** | none | **[proposal]** step-up for: enrolling an SSH device key, approving high-risk requests, changing policy. Bind the challenge to the action (Approval MCP does NOT do this yet — `oauth-routes.ts:154`). |
| **MCP client identity: OAuth 2.1 + PKCE, or `amcp_` tokens stored as scrypt verifiers** | **[exists]** one broker token per sandbox, 24 random bytes, constant-time compare, token→sandbox cache (`broker.mjs`). Stored PLAINTEXT in `~/.vivary/<name>/broker-token` (0600). Passed as env, so visible to `container inspect`. | **[proposal]** store a verifier, not the token; deliver the token through a mounted file (like Paseo's) instead of env. OAuth: not needed — sandboxes are created by the human, nobody "connects" one. |
| **Per-call authorization: profiles, deny > require_approval > allow, catalog filtered and re-checked** | **[exists]** static: a route answers only if the sandbox has the flag (`--host-open`, `--clipboard`); host-open is default-deny (no loopback/private URLs, safe extensions only, `hostOpenDomains`). Egress: ASHP rules (but they ignore `agent_id`, i.e. are global — known ASHP issue). | **[proposal]** the Approval MCP policy engine (pure, MCP-agnostic) over broker actions: `host-open:url`, `host-open:file`, `clipboard:read`, `clipboard:write`, `oauth:relay`. Rules come from vivary profiles (a new `policy` key), so a profile can say "clipboard read: require approval". |
| **Human approval as a stateful process: stored request, hash-bound decision, two timeouts, never auto-allow, restart = interrupted** | none in the broker. ASHP has its own approval UI (separate login, self-signed cert). | **[proposal]** an approval inbox in vivary web for broker actions, using Approval MCP's orchestrator (hash binding, `allow_once` / time-boxed grant / deny). ASHP's pending egress requests are surfaced there later via its API. |
| **Encrypted storage: random 256-bit master key, HKDF + AES-256-GCM with AAD, wrap slots (passkey PRF, recovery secret), locked/unlocked state** | **[exists]** none. Everything is plaintext 0600 under `~/.vivary` (inventory in §3). Protections that do exist: FileVault at rest; `~/.vivary` can never be mounted into a sandbox (refused in both CLI and `.vivary.json`). | **[proposal]** a vault for vivary's own secrets and for user secrets it injects (see §4, phase 4). Default unlock from the macOS Keychain (auto, so `vivary resume` still works after a reboot); strict passkey mode optional. |
| **Web Push: generic payload, endpoint allowlist, encrypted VAPID key** | none (only the weekly-build macOS notification) | **[proposal]** reuse for "sandbox X wants to read your clipboard" on the phone. |
| **Plugins are not a sandbox** | same: vivary plugins run in the host CLI | document it; no change |
| **Not protected: whoever controls the runtime** | see §3 — vivary has two concrete holes of exactly this kind | phase 0 |

## 2. Flows

### Human login
- **Today:** a tailnet device opens `http://<host>.ts.net:8737`; `tailscale serve` adds the
  login header; the server checks the allowlist. No session — every request is authorized
  by the header alone.
- **Proposed:** `tailscale serve --https` only (WebAuthn needs a secure context; the RP ID
  becomes the `.ts.net` name). Tailnet identity stays as the outer gate. Then passkey
  login → session cookie (12 h, revocable) + CSRF token.
  - **First passkey:** `vivary web enroll` opens a one-time enrollment link on the Mac's
    own browser via `open`. Nothing is printed (house rule: vivary never prints
    secrets). Approval MCP's bootstrap is "first comer wins" when an env key is set — do
    not copy that.
  - **Recovery codes:** shown once at enrollment, scrypt-hashed.
  - **Rate limits:** behind `tailscale serve` every client is 127.0.0.1, so limits key on
    the tailnet login, not the IP.

### A sandbox (agent) connecting
- **Today:**
  - **broker:** vivary creates the token at sandbox creation and gives it to the
    container as env.
  - **egress:** ASHP registers the agent and its token goes in as env.
  - **Paseo / VNC:** passwords as a mounted file / env.
- **Proposed:**
  - The same, but tokens are stored as verifiers and delivered as files.
  - A sandbox still never authenticates a human: its token only identifies the sandbox.

### Decision on an operation
- **Today:** the broker route checks the token → the sandbox's flag → the static
  predicate → allow or deny. The user never sees the decision.
- **Proposed:**
  1. token → sandbox → policy (profile rules) → allow / deny / require_approval.
  2. On require_approval: store the request with the hash of its canonical args, push a
     notification, the broker call waits (timeout).
  3. The user sees "sandbox `smarta` wants to read the host clipboard (text, 1.7 kB)" and
     decides. The decision is bound to the request hash; deny, timeout or restart is never
     an allow.

### Unlock after restart
- **Today:** nothing is locked; `vivary resume` restarts sandboxes.
- **Proposed:**
  - **Default mode:** the vault key sits in the login Keychain → auto-unlock at the first
    `vivary` command after login. This keeps resume working.
  - **Strict mode:** no Keychain item. The broker, ASHP-backed injection and the web UI
    come up locked (503/423 as in Approval MCP) until a passkey PRF unlock or the recovery
    secret. Sandboxes that need a vault secret do not start while locked — and a locked
    state must never look like "token revoked" to anything.

### Revocation
- **Today:**
  - `vivary rm` deletes the sandbox's token.
  - `vivary key rm` revokes an SSH device key everywhere (verified earlier).
  - There is no web session to revoke.
- **Proposed:**
  - Revoke sessions and passkeys in the UI.
  - Revoke grants.
  - Rotate a sandbox's broker token without recreating the container (file delivery
    makes that possible).

## 3. Trust boundary

### Where secrets live today, and who can read them

| Secret | Stored | Readable by |
| --- | --- | --- |
| Broker token per sandbox | `~/.vivary/<name>/broker-token`, plaintext 0600; env in the container | the user's processes; that sandbox (by design); `container inspect` |
| VNC password | `~/.vivary/<name>/vnc-password` 0600; container env | as above; that sandbox's agent (harmless: it drives that browser) |
| Paseo password | `~/.vivary/<name>/dot-paseo/.vivary-password`, mounted into the sandbox | as above |
| ASHP admin password | `~/.vivary/.ashp/secrets.json` 0600; ASHP container env | the user's processes |
| Egress agent token | ASHP state; sandbox env | that sandbox |
| npm tokens | host `~/.npmrc` (user's own file) → sandbox env when `--npmrc` | that sandbox |
| Claude/Codex logins | `~/.vivary/<name>/dot-claude/.credentials.json`, `dot-codex/auth.json` (0600), mounted | that sandbox's agent (needs them) |
| SSH: per-sandbox private key | `~/.vivary/<name>/ssh/` | the user's processes |
| SSH: device public keys | `~/.vivary/devices/*.pub` | not secret |

Existing protection that matters most: a sandbox cannot mount `~/.vivary` (refused from
both CLI and `.vivary.json`), and on Apple `container` the host enforces read-only mounts —
**[verified 2026-11-11]**:
- A root agent with all capabilities could not remount a `:ro` share read-write.
- It could not mount the same virtiofs tag afresh read-write either.
- The host file stayed untouched.

### Paths that bypass everything — fix these before building anything on top

1. **Docker runtime + `--docker` = the whole Mac. [verified 2026-11-11]**
   - The cause: on the docker runtime the docker plugin runs the sandbox `--privileged`
     inside Docker Desktop's VM, and a privileged container can mount that VM's virtiofs
     shares.
   - What I saw (mounted read-only, names only):
     - `virtiofs0` is `/Users`, including `~/.vivary` (38 entries).
     - The other shares hold `/Volumes`, `/private` and `/var/folders`.
   - So an agent in such a sandbox can read and write every workspace, every sandbox's
     token and login, vivary's own code, and `~/.ssh`.
   - **Currently affected: `findmy`** (runtime docker, docker on, agent codex).
   - Options:
     - Refuse `--docker` on the docker runtime and point to Apple `container`, where each
       sandbox is its own VM and dockerd runs inside it.
     - Rootless dockerd inside.
     - Docker Desktop's Enhanced Container Isolation (Business tier only).
2. **vivary's own code is agent-writable.**
   - The global `vivary` is a symlink to this checkout (`…/lib/node_modules/vivary ->
     …/apple-container-sandbox/cli`), and the `agent-sandbox` sandbox mounts that checkout
     read-write.
   - Every `vivary` command the user runs, and `vivary web`, executes code an agent can
     edit.
   - Any vault, passkey or policy built into vivary is void while this holds.
   - The pf-parity daemon already learned this (it runs a root-owned copy).
   - Fix: install the host-side vivary from a copy that no sandbox mounts (`npm pack` +
     install, or a `vivary self-install`), and keep the checkout for development only.
3. **The broker listens on 0.0.0.0:7377** — reachable from the LAN, gated only by the
   token.
   - Bind to loopback + the vmnet gateway address instead.
   - To verify: what docker sandboxes need. `host.docker.internal` on Docker Desktop
     reaches the host's loopback.
4. **ASHP's management API (:3000) is reachable from every egress sandbox.**
   - That is by design: they register through it with their agent token.
   - The admin endpoints are guarded by one basic-auth password.
   - ASHP-side work: separate the agent-registration endpoint from the admin endpoints
     by listener.
5. **Clipboard sync pushes the host clipboard into every `--clipboard` sandbox.**
   - A password copied on the Mac reaches every such agent.
   - Phase 3 can make `clipboard:read` require approval per profile.
6. **Tailnet device compromise = web UI access** (no human factor) — phase 2.

### Out of scope even after this plan
- The user's own processes reading `~/.vivary` while unlocked.
- Malicious vivary plugins.
- A compromised tailnet admin account.
- Agents misusing their own legitimately mounted credentials.
- Anything inside a sandbox with `--sudo` against that same sandbox.

## 4. Phased plan and migration

Each phase ships on its own and keeps existing sandboxes working.

- **Phase 0 — close the bypasses (no new features).**
  - Refuse or replace `--docker` on the docker runtime, after deciding `findmy`'s
    future.
  - Run host-side vivary from an installed copy.
  - Narrow the broker bind.
  - Each fix gets a test that proves the path is closed.
  - Migration: none, except `findmy`.
- **Phase 1 — UI on the shared design system.**
  - Tokens, fonts and icons from the shared package.
  - App shell with routes; theme toggle with its own storage key; cs/en; shared date-time
    formatting.
  - Truthful loading / empty / error / offline / locked states.
  - **Open decision:** stay vanilla JS (`ui.html`) or move vivary web to Vite + React to
    share components with Approval MCP. The approval inbox, passkey flows, SSE and the
    service worker outgrow one HTML file; the React route makes the component library
    shareable.
- **Phase 2 — human auth.**
  - HTTPS-only serve, passkeys, sessions, CSRF token, recovery codes.
  - Step-up for device-key enrollment.
  - Migration: the first start after upgrading serves only the enrollment page until a
    passkey exists; the CLI keeps working throughout.
- **Phase 3 — approvals.**
  - Policy engine over broker actions, with a `policy` key in profiles and `.vivary.json`
    (the approval gate covers the latter).
  - Approval inbox with SSE and Web Push.
  - Migration: the default policy reproduces today's behaviour (flag on = allow, plus the
    existing predicates), so nothing changes until a rule says `require_approval`.
- **Phase 4 — vault and secret injection.**
  - Vault with Keychain auto-unlock, plus optional strict passkey mode.
  - Import existing plaintext secrets: ASHP admin password, broker tokens → verifiers,
    VNC/Paseo passwords.
  - Then user secrets with injection targets: egress header injection, a file at start,
    env at `vivary exec`.
  - Migration: import → verify each secret is readable through the vault → only then
    delete the plaintext. A failed import leaves the old file in place. The vault must
    never start "empty" over unreadable data.

## 5. Tests

Pairs each scenario from the brief with how vivary would test it. "Server" = enforced in
the broker or web server; "UX" = presentation only.

| Scenario | Test |
| --- | --- |
| Revoked/unknown sandbox cannot act; one sandbox cannot use another's grant | broker unit tests (exist for tokens); grant tests per sandbox (server) |
| A hidden action cannot be called by name | a broker route with the flag off returns 403 even with a valid token (server) |
| Explicit deny beats an earlier grant; a sensitive action without a grant really waits | policy unit tests, plus an end-to-end clipboard read that blocks until decided (server) |
| Changed args after approval, expired approval or a second decision do not run anything | hash-binding tests on the orchestrator (server) |
| Locked state never reads as revocation | the broker returns 503 `storage_locked`, and the in-sandbox helpers keep their token (server) |
| A wrong key or corrupted vault never starts with an empty state | vault unit tests with tampered files (server) |
| Push and logs carry no secrets | grep the test logs and payloads for canaries (the same method as the `vivary exec` canary test) |
| No bypass via network, Docker, volumes or a stolen session | scripted probes: the privileged-docker probe from §3 must FAIL; a sandbox cannot reach the web UI's loopback port; `~/.vivary` mount refused; a session cookie replayed from another tailnet login is refused (server) |
| UI | light/dark × cs/en × 390/768/1440 px, a 320 px reflow, 200 % zoom — screenshots of real screens against a running server (UX) |

## 6. What to share as a library

Approval MCP is a TypeScript npm-workspace monorepo with a `tsc -b` + Vite build. Nothing
is published, and package `exports` point `types` at `.ts` source and `default` at
`dist/`. vivary is plain ESM `.mjs` with no build. So a shared library must publish
compiled ESM + `.d.ts` (JSDoc/`.d.ts` for types) to a registry (for example GitHub
Packages), and must not depend on Fastify or React in its core.

Ranked by value for vivary:

1. **Design tokens + CSS primitives + icons + fonts** (S).
   - `design-tokens.css`/`.json` already exist with a drift check
     (`scripts/export-design-tokens.mjs --check`).
   - Carve buttons, fields, cards, badges and dialogs out of the 3,656-line global
     `styles.css` into a scoped base.
   - Framework-free, usable by `ui.html` today.
2. **Passkey + session + CSRF + recovery codes** (S–M).
   - The services are already framework-free behind small repositories; only about 260
     lines of Fastify glue tie them in.
   - Fix while extracting:
     - setup token instead of first-comer bootstrap;
     - step-up challenge bound to the action;
     - recovery codes shown and regenerable in the UI (today they are generated only at
       bootstrap and never displayed);
     - rate limiting keyed on identity, not IP;
     - session pruning.
3. **Encrypted vault with PRF / recovery unlock** (M).
   - Generic parts: the cipher, wrap/unwrap, the authenticated manifest with slots and
     `verifyKey`, and the locked/unlocked gate.
   - Start from `examples/passkey-vault-poc` (already `.mjs`), not from `storage-vault.ts`,
     which is wired to approval files.
   - Fix while extracting: derive separate keys for the credential and push envelopes
     (today they use the master key directly, separated only by AAD).
4. **Policy + grant engine** (S).
   - About 350 lines of pure functions; `upstreamId`/`toolName` are opaque strings.
   - Rename to resource/action.
5. **Approval orchestrator + SSE broker** (M).
   - Generic hash binding and timeouts; typed by contracts.
6. **Web Push** (S–M). `pocs/web-push` is already `.mjs`.
7. **Agent token service** (S). The scrypt verifier with an embedded id and constant-time
   misses.

Does not transfer: the MCP server/catalog/coordinator, upstream clients, plugin SDK,
declarative setup, and the OAuth authorization server (worth it only if vivary ever
exposes MCP/OAuth clients).

**Where it lives (decision for the maintainers):**
- (a) Publishable packages inside the approval-mcp-wrapper monorepo. That is the origin,
  where the tests already are; shared with its other contributor.
- (b) A new standalone repo that both consume.

Start with (a) and move to (b) when a third consumer appears.

## 7. Narrowed plan (decided 2026-11-11)

The user cut the scope to four goals: no secret stored in plaintext, the web UI behind a
passkey, the web UI as the place to manage a sandbox (public keys, connection details,
settings, start/stop), and VNC only behind the passkey. Approvals, policy and Web Push
(phase 3 above) are out for now.

Decisions:
- **Phase 0 is deferred** (running vivary from a copy, `findmy`). Until it lands, an agent
  that can write this checkout can remove any check built here — see §3.
- **HTTPS is required for the tailnet.** WebAuthn needs a secure context: HTTPS, or
  `http://localhost`. Approval MCP has the same rule ("HTTPS except exact loopback"), so a
  passkey over plain HTTP only ever worked on localhost. `vivary web` serves through
  `tailscale serve --https`; the passkey is bound to the Mac's tailnet name, so the web has
  ONE address, used on the Mac too. `--no-serve` (local only) uses `http://localhost` with
  its own passkeys.
- **No recovery codes.** The first passkey and every recovery come from
  `vivary web enroll` on the Mac: it opens a one-time link (single use, minutes),
  nothing is printed. Physical access to the Mac is the recovery factor.
- **Every request needs a session**, loopback included. The old "no Tailscale header =
  someone on the Mac = owner" rule is dropped: a docker-runtime sandbox reaches the host's
  loopback through `host.docker.internal`, and could also send any header it likes there.
- **Step-up bound to the action** for anything that grants lasting access: adding an SSH
  device key, adding or removing a passkey, and (later) settings changes and
  `.vivary.json` approval. The challenge is stored with a digest of the exact request; a
  different request cannot spend it.
- **Not from the web:** creating a sandbox, changing its workspace or mounts (raw access
  to the Mac's disk). The Paseo password is not shown in the web.
- **VNC:** the per-sandbox tailnet shares of noVNC go away; noVNC is proxied by the web
  for a logged-in session. The 8-character VNC password (the protocol's limit) is
  replaced as the real lock by a 256-bit secret checked by websockify on the WebSocket
  upgrade (`--auth-plugin BasicHTTPAuth`, present in the image's websockify 0.10), known
  only to the web server, plus an in-sandbox firewall that admits only the Mac to the
  noVNC port.
- **Agent logins stay as they are** (option A): `dot-claude/.credentials.json` and
  `dot-codex/auth.json` remain files on the Mac, mounted into the sandbox — a known
  exception to "no plaintext".
- **UI stays build-free**: plain ES modules served by the web server, strict CSP
  (no inline script). React is not needed without the approval inbox.

Order: (1) passkey + HTTPS, (2) VNC through the web, (3) connection details, settings,
`.vivary.json` approval from the web, (4) vault for vivary's own secrets: broker tokens
(host keeps a verifier; the token reaches the sandbox per start into tmpfs, not env — today
it also sits in Apple's container `config.json` [verified]), VNC/Paseo/ASHP passwords, the
per-sandbox SSH private keys (44, none passphrase-protected [verified]; encrypt with a
passphrase kept in the Keychain, `UseKeychain yes`).
