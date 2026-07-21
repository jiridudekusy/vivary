#!/usr/bin/env bash
# Network workarounds for Apple `container` VMs. Idempotent and non-fatal;
# harmless under Docker. Runs as root (via the sudoers entry for user agent,
# see Dockerfile).
set -uo pipefail

# 1) The gateway DNS proxy (192.168.64.1) mishandles AAAA queries from glibc,
#    so getaddrinfo(AF_UNSPEC) fails with EAI_AGAIN (breaking Node.js, curl,
#    ...). The VM has no IPv6 connectivity anyway, so disable AAAA lookups.
if ! grep -q "^options no-aaaa" /etc/resolv.conf 2>/dev/null; then
    echo "options no-aaaa" >> /etc/resolv.conf
fi

# 2) Apple `container` has no host.docker.internal equivalent and no
#    --add-host flag. Map it to the default gateway (= the host). Checked via
#    getent, NOT /etc/hosts: under Docker the name resolves through the
#    embedded DNS and an /etc/hosts entry would shadow that working mapping.
#    RES_OPTIONS bounds the probe: answering resolvers reply in ms, dead ones
#    would otherwise stall boot with glibc timeouts. On an egress sandbox
#    without embedded DNS (Apple internal net) there is NO resolver at all at
#    this point — ASHP DNS is set by the NEXT hook — so the hook passes
#    --no-dns-probe (sudo strips env, hence an argument) and we skip the
#    probe entirely. Docker's embedded DNS (127.0.0.11) still gets probed:
#    there the mapping works and a hosts entry would shadow it. Worst case of
#    a forged flag is a hosts entry the agent could write anyway — harmless.
probe() {
    if [ "${1:-}" = "--no-dns-probe" ] \
       && ! grep -q '^nameserver 127\.0\.0\.11' /etc/resolv.conf 2>/dev/null; then
        return 1
    fi
    RES_OPTIONS="timeout:1 attempts:1" getent hosts host.docker.internal >/dev/null 2>&1
}
if ! probe "${1:-}"; then
    gw="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
    # fallback for images without iproute2: the nameserver is the gateway
    [ -z "$gw" ] && gw="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)"
    if [ -n "$gw" ] && ! grep -q "host.docker.internal" /etc/hosts 2>/dev/null; then
        echo "$gw host.docker.internal gateway.docker.internal" >> /etc/hosts
    fi
fi

exit 0
