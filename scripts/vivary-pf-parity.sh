#!/bin/bash
# Host network parity for sandboxes: let a sandbox reach whatever the host
# routes through a VPN tunnel.
#
# Apple `container`'s vmnet NATs sandbox traffic onto the host's PRIMARY
# interface only, so anything behind a point-to-point tunnel is unreachable from
# a sandbox. DNS still answers (the query goes to the vmnet gateway, which the
# host resolver serves), so the failure reads as a policy block rather than a
# routing gap.
#
# Fix: one NAT rule per tunnel interface, loaded into a DEDICATED pf anchor.
#
# NEVER use `pfctl -f` here. The main ruleset carries anchors that system
# services — including the vmnet NAT that gives sandboxes their way out over
# en0 — insert AT RUNTIME. `pfctl -f` flushes those, which kills all sandbox
# internet, and reloading the stock /etc/pf.conf does NOT bring them back: the
# only recovery found was restarting the container runtime, killing every
# running container. `pfctl -a vivary -f` touches only our anchor and is safe to
# repeat at will. See docs/superpowers/plans/2026-09-29-host-network-parity.md.
#
# Requires the anchor to be registered once in /etc/pf.conf (see --check).
set -uo pipefail

ANCHOR=vivary
RULES=/var/run/vivary-pf-parity.conf
LOG=${VIVARY_PF_LOG:-/var/log/vivary-pf-parity.log}

# Tailscale's own utun is EXCLUDED by default, and not out of caution: vivary
# publishes per-sandbox services (Paseo, the web UI) on the host's tailnet
# address. NATing sandboxes onto the tailnet would let any sandbox reach another
# sandbox's published endpoints — an inter-sandbox path that does not exist
# today. Set VIVARY_PF_INCLUDE_TAILSCALE=1 to accept that and include it.
INCLUDE_TAILSCALE=${VIVARY_PF_INCLUDE_TAILSCALE:-0}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG" 2>/dev/null || true; }

# The sandbox subnet, read from the live bridge rather than hardcoded — Apple
# `container` renumbers it if its network is recreated.
sandbox_subnet() {
    local cidr
    cidr=$(ifconfig 2>/dev/null | awk '
        /^[a-z0-9]+:/ { iface = $1 }
        /inet 192\.168\.6[0-9]\./ { print $2; exit }')
    [ -n "$cidr" ] || return 1
    echo "${cidr%.*}.0/24"
}

# Every tunnel interface carrying an address. utunN is renumbered on reconnect,
# so this is discovered every run and never remembered.
tunnels() {
    local i ip
    for i in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep '^utun'); do
        ip=$(ifconfig "$i" 2>/dev/null | awk '/inet /{print $2; exit}')
        [ -n "$ip" ] || continue
        # 100.64.0.0/10 is the CGNAT range Tailscale assigns — the reliable way
        # to spot its interface without depending on the utun number.
        if [ "$INCLUDE_TAILSCALE" != "1" ] && [[ "$ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
            continue
        fi
        echo "$i"
    done
}

case "${1:-apply}" in
  --check|check)
    if grep -qE '^[[:space:]]*nat-anchor[[:space:]]+"vivary"' /etc/pf.conf 2>/dev/null; then
        echo "anchor registered in /etc/pf.conf: yes"
    else
        echo "anchor registered in /etc/pf.conf: NO"
        echo
        echo "One-off host setup is still needed. It is disruptive exactly once:"
        echo "  1. add   nat-anchor \"vivary\"   to /etc/pf.conf, BEFORE nat-anchor \"com.apple/*\""
        echo "  2. sudo pfctl -f /etc/pf.conf         # flushes runtime anchors — see below"
        echo "  3. container system stop && container system start"
        echo "     (step 2 removes the vmnet NAT that gives sandboxes internet; only a"
        echo "      runtime restart puts it back. Running containers die; their state survives.)"
        exit 1
    fi
    echo "sandbox subnet: $(sandbox_subnet || echo 'NOT FOUND — is the container runtime up?')"
    echo "tunnels to NAT: $(tunnels | tr '\n' ' ')"
    echo "forwarding:     $(sysctl -n net.inet.ip.forwarding 2>/dev/null)"
    exit 0
    ;;
esac

[ "$(id -u)" = "0" ] || { echo "must run as root (it loads a pf anchor)" >&2; exit 1; }

subnet=$(sandbox_subnet)
if [ -z "$subnet" ]; then
    log "SKIP: no sandbox bridge found (container runtime not up?)"
    exit 0
fi

# Ensured, not assumed — it happened to be 1 on the box this was developed on.
[ "$(sysctl -n net.inet.ip.forwarding 2>/dev/null)" = "1" ] || {
    sysctl -w net.inet.ip.forwarding=1 >/dev/null 2>&1
    log "enabled net.inet.ip.forwarding"
}

: > "$RULES"
count=0
for i in $(tunnels); do
    echo "nat on $i from $subnet to any -> ($i)" >> "$RULES"
    count=$((count + 1))
done

# An empty anchor is the correct state with no tunnels up, and loading it is how
# stale rules from a disconnected VPN get removed.
if pfctl -a "$ANCHOR" -f "$RULES" 2>>"$LOG"; then
    log "loaded $count rule(s) for $subnet: $(tunnels | tr '\n' ' ')"
else
    log "FAILED to load anchor $ANCHOR"
    exit 1
fi

pfctl -E >/dev/null 2>&1   # idempotent; -E refcounts, never flushes
exit 0
