# Host network parity for sandboxes

Status: spec, not implemented.

## Problem

Apple `container`'s vmnet NATs sandbox traffic onto the host's PRIMARY interface
only. Anything the host reaches through a point-to-point tunnel (VPN `utun`) is
unreachable from a sandbox. DNS still works — the query goes to the vmnet
gateway, which the host resolver answers — so the failure looks like a
policy block rather than a routing gap, which is exactly how it was first
reported ("z hostu tam vidím, ze sandboxu ne").

Measured 2026-09-29, sandbox `smarta`, `egress: false` (so nothing in vivary was
filtering anything):

| | host | sandbox |
|---|---|---|
| DNS `smarta-perf.pseex20-smarta.local` | 10.145.33.38 | 10.145.33.38 (OK) |
| TCP 443 / 80 | open, 17 ms | timeout |

    $ route -n get 10.145.33.38
        gateway: 172.24.5.245
      interface: utun9

Adding one pf rule on the host fixed it outright:

    nat on utun9 from 192.168.64.0/24 to any -> (utun9)

after which the sandbox got `TCP 443/80 OK` and a real request returned
`HTTP 400` from `peer 10.145.33.38` — i.e. the server itself answered, so the
path works end to end. `net.inet.ip.forwarding` was already 1.

## Design position

Reachability parity with the host is the DEFAULT, not a flag. What a sandbox is
ALLOWED to reach is the egress plugin's job (ASHP, default-deny), not an
accident of network topology. This does not breach "no flag -> no feature":
the thing being added is not a host integration, it is the removal of a
surprise asymmetry — and note the asymmetry currently bites hardest when
egress is OFF, i.e. when the user asked for no restriction at all.

## Requirements

1. A sandbox reaches everything the host routes, tunnels included, with no flag.
2. ALL tunnel interfaces, discovered dynamically. This host has two right now —
   `utun4` (Tailscale, 100.104.78.128) and `utun9` (OpenVPN, 172.24.5.246).
   Never hardcode a name: `utunN` is renumbered on reconnect.
3. Survives VPN reconnect and host reboot without manual steps.
4. Must not clobber the system pf ruleset. `/etc/pf.conf` warns explicitly that
   the main ruleset must not be flushed, because system services insert nested
   anchors into it; `pfctl -f <file>` replaces the lot. Prefer adding a
   `nat-anchor "vivary"` to `/etc/pf.conf` ONCE and loading only into that
   anchor afterwards.
5. `net.inet.ip.forwarding` must be ENSURED, not assumed (it happened to be 1
   on the box where this was measured).
6. With `--egress` on, ASHP stays the gate — parity must not widen what an
   egress sandbox can reach.

## Open questions

- **Host root.** vivary needs no host sudo today and this does. Options:
  (a) prompt for sudo during `up`; (b) a one-time installed LaunchDaemon that
  maintains the anchor and re-applies it on route changes; (c) ship a script
  under `scripts/` and document it as manual host setup.
  (b) matches existing practice — `scripts/weekly-image-update.sh` +
  `net.vivary.image-update.plist` already establish the LaunchAgent pattern —
  and is the only option that satisfies requirement 3 by itself.
- **Blast radius.** The rule NATs the whole `192.168.64.0/24`, so every sandbox
  gets the host's network, not just the one that needed it. Per-sandbox scoping
  would need stable per-sandbox source IPs plus one rule each. Decide whether
  that is worth it or whether egress is the right place to draw the line.
- **Other runtimes.** Docker Desktop is believed to follow host routes (so no
  gap), tart unknown. Both UNVERIFIED — measure before assuming.

## Acceptance

- VPN up, fresh sandbox, no flags: reaches a VPN-only host over TCP.
- VPN reconnects onto a different `utunN`: still reachable, no manual step.
- Host reboots: still reachable.
- `--egress` sandbox: still default-deny, unchanged.
- Sandbox internet over `en0` unchanged (the rule matches only traffic leaving
  via a tunnel interface).

## Hard-won: `pfctl -f` is a dead end (verified 2026-09-29, the hard way)

Loading a hand-made ruleset with `sudo pfctl -E -f <file>` DOES make the tunnel
reachable from a sandbox — and simultaneously KILLS normal sandbox internet.
`/etc/pf.conf` says why: system services insert anchors into the main ruleset
AT RUNTIME, and `pfctl -f` flushes the lot. One of those runtime anchors is the
vmnet NAT that gives sandboxes their way out over `en0`. Reproducing the static
`/etc/pf.conf` verbatim is NOT enough — it only carries the anchor *references*
and `load anchor ... from /etc/pf.anchors/com.apple`, never the dynamically
inserted content.

Measured, same sandbox, in this order:

| | `1.1.1.1:443` | `registry.npmjs.org:443` | `10.145.33.38:443` (VPN) |
|---|---|---|---|
| before | OK | OK | FAIL |
| after `pfctl -E -f <file>` | **FAIL** | **FAIL** | OK |
| after `pfctl -f /etc/pf.conf` | **FAIL** | **FAIL** | FAIL |
| after `container system stop && start` | OK | OK | FAIL |

Note row 3: restoring the stock config does NOT undo the damage, because the
runtime-inserted anchors are gone and nothing re-adds them. The only recovery
found was restarting the container runtime, which kills every running container
(state survives — they are persistent — but live agent sessions die).

Consequences for the implementation:

- NEVER replace the main ruleset. Register a `nat-anchor "vivary"` in
  `/etc/pf.conf` ONCE and load only into that anchor (`pfctl -a vivary -f`),
  which leaves runtime-inserted anchors untouched.
- Even then, verify the anchor survives the runtime inserting/removing its own
  anchors, and survives `container system stop`/`start`.
- Any implementation needs a rollback that is actually tested, not assumed:
  the obvious one (`pfctl -f /etc/pf.conf`) is proven NOT to restore service.

## Verified working approach: a dedicated `vivary` nat-anchor

Confirmed end to end on 2026-09-29. `pfctl -a vivary -f <file>` loads ONLY into
the named anchor and leaves the main ruleset — runtime-inserted anchors
included — untouched, which is exactly what `pfctl -f` destroys.

Setup (one-off, needs host root):

1. Register the anchor in `/etc/pf.conf`, ahead of the Apple one:

       nat-anchor "vivary"
       nat-anchor "com.apple/*"

2. `sudo pfctl -f /etc/pf.conf` — needed once so the loaded ruleset knows the
   anchor. This IS the destructive reload, so it costs one runtime restart:
3. `container system stop && container system start` — the runtime re-inserts
   its anchors (vmnet NAT). Kills running containers; their state survives.
4. `sudo pfctl -a vivary -f <rules>` with:

       nat on utun9 from 192.168.64.0/24 to any -> (utun9)

From then on step 4 is repeatable at will with no disruption — that is the
whole point of the anchor.

Result, same sandbox, no flags, `egress: false`:

| | `1.1.1.1:443` | `registry.npmjs.org:443` | `10.145.33.38:443` (VPN) |
|---|---|---|---|
| before | OK | OK | FAIL |
| after | OK | OK | **OK** |

`https://smarta-perf.pseex20-smarta.local/` answers `HTTP 400` from
`peer 10.145.33.38` — the server itself, i.e. the path is complete.

Note the rules do NOT conflict by ordering: ours is `nat on <utun>`, vmnet's is
`nat on en0`. Different interfaces, so precedence never comes into it. The
earlier breakage was deletion of the vmnet rule, not ordering — worth stating
plainly, because the first analysis got this wrong.

Left for the implementation:

- Generate the anchor content from the routing table instead of a hardcoded
  `utun9`, and reload it on network change (`utunN` is renumbered on reconnect).
  Only step 4 needs re-running, which is cheap and safe.
- Decide whether Tailscale's `utun` belongs in the set. It was deliberately
  EXCLUDED here — vivary has its own tailscale plugin and mixing the two was
  not worth the risk during a manual fix.
- Steps 1-3 are the part that needs a real installer story (LaunchDaemon), since
  they need root and one disruptive reload.

## Manual workaround until then

None that is safe. The obvious one — reproduce `/etc/pf.conf`, add the nat
line, `sudo pfctl -E -f <file>` — is exactly the dead end documented above: it
buys tunnel access at the cost of all other sandbox connectivity, and it is not
cleanly revertible. Use a host-side forwarder (`socat TCP-LISTEN:<port>,
bind=192.168.64.1,fork TCP:<target>:<port>`) instead: the host opens the
connection, so it takes the tunnel, and killing the process ends the access.

## Installed 2026-10-02

The anchor was already registered in `/etc/pf.conf` from the manual fix, so
steps 1-3 (the destructive ones) did not repeat. Installing the LaunchDaemon
was enough:

    sudo install -o root -g wheel -m 755 \
        scripts/vivary-pf-parity.sh /usr/local/bin/vivary-pf-parity.sh
    sudo install -o root -g wheel -m 644 \
        scripts/net.vivary.pf-parity.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/net.vivary.pf-parity.plist

The daemon runs the root-owned COPY, never `scripts/`: this repo is mounted
read-write into the `agent-sandbox` and `apple-container-sandbox` sandboxes,
and launchd checks the plist's ownership but not the program's — so a daemon
pointed at the working tree would hand any agent in those sandboxes host root
on the next network change.

Result in sandbox `smarta`, VPN on `utun9`, no restart needed:

| | `1.1.1.1:443` | `registry.npmjs.org:443` | `10.145.33.38:443` (VPN) |
|---|---|---|---|
| before | OK | OK | FAIL |
| after | OK | OK | **OK** |

`https://10.145.33.38/` answers `HTTP 400` from `peer 10.145.33.38` — the
server itself.

### Survives reboot and renumbering — measured, not assumed

The host was rebooted later the same day. The VPN came back as `utun5`
(previously `utun9`) and Tailscale as `utun4`. Daemon log:

    12:01:14 SKIP: no sandbox bridge found (container runtime not up?)
    ...
    12:01:55 loaded 1 rule(s) for 192.168.64.0/24: utun5

It waited for the container runtime, then picked the new interface up by
itself; `smarta` reached `10.145.33.38:443` with no manual step. That covers the
reconnect, reboot and renumber acceptance criteria.

### DNS: the original position holds

The vmnet gateway relays the HOST's system resolver, `/etc/resolver/*` split
zones included — so when the host resolves a VPN name, a sandbox does too.
Measured after the reboot, stock `/etc/resolv.conf` (gateway only, no
workaround):

    $ getent hosts smarta-perf.pseex20-smarta.local      # inside smarta
    10.145.33.38    smarta-perf.pseex20-smarta.local

No in-sandbox forwarder is needed for parity. Do not build one: it would only
make a sandbox resolve names the host itself cannot, which is a different
feature from parity.

### What misled the first diagnosis: a host resolver broken for one boot

Before that reboot, the HOST could not resolve the `.local` VPN zones at all —
`curl` on the Mac failed with "Could not resolve host", and the sandbox,
faithfully relaying it, got ETIMEOUT from the gateway. That looked like a
sandbox gap and was first written up as one ("forwarding to the host resolver
would be worse"). It was parity: host and sandbox failed the same way.

The zone files never changed (`/etc/resolver/pseex20-smarta.local` →
`10.145.32.1`, from April). `cams`, the one zone without a `.local` suffix,
kept working throughout (0.9 s vs 10 s for the `.local` zones), so it was
specific to how mDNSResponder handles `.local`. Its log shows the two states:

    VPN not connected:   [R1066->mDNS] ... rdata: <none>  duration: 5s
    VPN connected:       [R1356] starting parallel unicast query ...
                         Question assigned DNS service 2 ... duration: 0s

i.e. for a `.local` name it adds the unicast query only when it believes the
zone's server is reachable. In the broken boot it never did, even though
`scutil --dns` reported the resolver as Reachable. `killall -HUP mDNSResponder`
did not fix it; a reboot did. Root cause NOT established — plausibly an
ordering effect at boot (mDNSResponder starts before the VPN exists), but that
is a hypothesis.

Ruled out: Tunnelblick (`SMARTA SDBuseDNS = 0`, it never sets DNS — the zone
files are the only mechanism), and any install at that restart (none of
macOS, Tailscale or Tunnelblick changed).

If it recurs: test the host first (`curl` a VPN name ON THE MAC). If the host
fails too, it is this, not vivary. Reboot fixed it; for a single sandbox the
stopgap is a direct nameserver in its `/etc/resolv.conf`:

    nameserver 192.168.64.1
    nameserver 10.145.32.1
    options no-aaaa timeout:1 attempts:1

(`timeout:1` keeps the fallback from costing 5 s per lookup; lost on container
restart.)
