#!/bin/sh
# vivary wrapper around the stock ASHP entrypoint, fixing three Apple
# `container` deviations from Docker (all harmless / no-ops under Docker):
#
# 1. Apple leaves net.ipv4.ip_unprivileged_port_start at 1024 (Docker sets 0),
#    so ASHP's non-root `ashp` proxy cannot bind :443/:80. Root has
#    CAP_NET_ADMIN by default — lower it before privileges are dropped.
# 2. Apple writes only the FIRST NIC into /etc/hosts, so `hostname -i` (used
#    by the stock entrypoint to pick dnsmasq listen addresses) misses the
#    vivary-egress NIC and DNS never answers the sandboxes. Register every
#    global IPv4 address for the hostname so dnsmasq binds them all.
# 3. Apple assigns container IPs from an incrementing DHCP pool with no
#    static-IP flag, so the host can't know ASHP's vivary-egress IP before
#    boot. Compute it here (the internal net is the NIC NOT carrying the
#    default route) and pin the dnsmasq catch-all to it. On Docker the host
#    passes ASHP_TRANSPARENT_IP (static IP), so this block is skipped.
sysctl -w net.ipv4.ip_unprivileged_port_start=0 || echo "WARNING: could not lower ip_unprivileged_port_start" >&2

for addr in $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1); do
    grep -q "^$addr " /etc/hosts || echo "$addr $(hostname)" >> /etc/hosts
done

if [ -z "${ASHP_TRANSPARENT_IP:-}" ]; then
    def_iface="$(ip route | awk '/^default/ {print $5; exit}')"
    egress_ip="$(ip -4 -o addr show scope global \
        | awk -v d="$def_iface" '$2 != d {print $4; exit}' | cut -d/ -f1)"
    if [ -n "$egress_ip" ]; then
        export ASHP_TRANSPARENT_IP="$egress_ip"
        echo "vivary: pinned ASHP_TRANSPARENT_IP=$egress_ip (internal egress NIC)"
    else
        echo "WARNING: could not determine vivary-egress IP for dnsmasq catch-all" >&2
    fi
fi

exec /app/entrypoint.sh "$@"
