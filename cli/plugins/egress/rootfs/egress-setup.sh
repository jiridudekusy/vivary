#!/usr/bin/env bash
# Egress control, sandbox side. Root helper (sudoers entry for user agent),
# run once at boot by the 11-egress hook AFTER 10-fix-net. Forces every route
# out through ASHP and raises the inter-sandbox ingress firewall. Loud on
# failure — a silent miss would either break the sandbox or, worse, leak
# egress. Idempotent.
#
# Args (sudo strips the environment, so they are passed positionally):
#   $1 ASHP_IP     ASHP's address on the vivary-egress net (DNS + CA + register)
#   $2 AGENT_NAME  this sandbox's ASHP agent name
#   $3 AGENT_TOKEN this sandbox's ASHP agent token
set -uo pipefail

ASHP_IP="${1:?egress-setup: ASHP_IP required}"
AGENT_NAME="${2:?egress-setup: AGENT_NAME required}"
AGENT_TOKEN="${3:?egress-setup: AGENT_TOKEN required}"

fail() { echo "ERROR: egress-setup: $*" >&2; exit 1; }

# 1) DNS -> ASHP's dnsmasq catch-all. Keep `options no-aaaa` (fix-net; the VM
#    has no IPv6 egress and glibc AAAA lookups hang the gateway proxy). Names
#    in /etc/hosts (host.docker.internal from fix-net, tailnet names from the
#    tailscale hook) win over DNS via nsswitch, so the broker / tailnet stay
#    local and never hit the catch-all.
{
    echo "nameserver ${ASHP_IP}"
    echo "options no-aaaa"
} > /etc/resolv.conf || fail "could not rewrite /etc/resolv.conf"

# 2) Trust ASHP's MITM CA. curl talks to the mgmt API by IP over plain HTTP,
#    so no chicken-and-egg with the not-yet-trusted CA.
CA_DST=/usr/local/share/ca-certificates/ashp.crt
if ! curl -fsS -m 15 "http://${ASHP_IP}:3000/api/ca/certificate" -o "$CA_DST"; then
    fail "could not fetch ASHP CA from http://${ASHP_IP}:3000/api/ca/certificate"
fi
[ -s "$CA_DST" ] || fail "fetched ASHP CA is empty"
update-ca-certificates >/dev/null 2>&1 || fail "update-ca-certificates failed"

# Point common runtimes at the merged bundle / the CA (Node ignores the system
# store). Covers profile (login + ssh via sshd SetEnv) and non-login shells.
cat > /etc/profile.d/egress-ca.sh <<EOF
export NODE_EXTRA_CA_CERTS=${CA_DST}
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
EOF
chmod 0644 /etc/profile.d/egress-ca.sh

# ssh / Remote-SSH / Claude Desktop exec sessions read sshd SetEnv, not
# profile.d. sshd is first-match-wins per variable and the ssh plugin already
# ships a SetEnv line, so a second line would be ignored — EXTEND the existing
# line in place (idempotent). Runs at 11, before sshd starts at 30, so the
# edit is in effect on first boot. Falls back to a fresh line if none exists.
SSHD_CONF=/etc/ssh/sshd_config.d/sandbox.conf
CA_ENV="NODE_EXTRA_CA_CERTS=${CA_DST} REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
if [ -f "$SSHD_CONF" ] && ! grep -q "NODE_EXTRA_CA_CERTS" "$SSHD_CONF"; then
    if grep -q '^SetEnv ' "$SSHD_CONF"; then
        sed -i "s#^SetEnv \(.*\)#SetEnv \1 ${CA_ENV}#" "$SSHD_CONF"
    else
        echo "SetEnv ${CA_ENV}" >> "$SSHD_CONF"
    fi
fi

# 3) Register this sandbox's vivary-egress IP with ASHP so transparent mode
#    maps intercepted connections to this agent identity. The egress IP is the
#    NIC NOT carrying the default route (there is none on an internal net, so
#    just the sole global v4 here, but derive it robustly).
DEF_IFACE="$(ip route | awk '/^default/ {print $5; exit}')"
MY_IP="$(ip -4 -o addr show scope global | awk -v d="$DEF_IFACE" '$2 != d {print $4; exit}' | cut -d/ -f1)"
[ -n "$MY_IP" ] || MY_IP="$(ip -4 -o addr show scope global | awk '{print $4; exit}' | cut -d/ -f1)"
[ -n "$MY_IP" ] || fail "could not determine own egress IP"
if ! curl -fsS -m 15 -X POST "http://${ASHP_IP}:3000/api/agents/register-ip" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"${AGENT_NAME}\",\"token\":\"${AGENT_TOKEN}\",\"ip_address\":\"${MY_IP}\"}" \
        >/dev/null; then
    fail "could not register IP ${MY_IP} for agent ${AGENT_NAME} with ASHP"
fi
echo "egress-setup: registered ${MY_IP} as ASHP agent '${AGENT_NAME}', DNS+CA -> ${ASHP_IP}"

# 4) Ingress firewall (LAST). Inter-sandbox isolation on the shared net:
#    host-originated traffic arrives with source = gateway .1 (allow — ssh,
#    broker return), peer sandboxes arrive with their own .x (drop). Own
#    outbound and its ESTABLISHED return are unaffected. iptables here is
#    nf_tables; trust end-to-end reachability, not its counters.
GW="$(ip route | awk '/^default/ {print $3; exit}')"
[ -n "$GW" ] || GW="$(ip -4 -o addr show scope global | awk '{print $4; exit}' | sed -E 's#\.[0-9]+/.*#.1#')"
[ -n "$GW" ] || fail "could not determine gateway for ingress firewall"
iptables -F INPUT || fail "iptables -F INPUT failed (need CAP_NET_ADMIN / --egress adds it)"
iptables -P INPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -s "$GW" -j ACCEPT
echo "egress-setup: ingress firewall up (accept lo + established + host ${GW}, drop peers)"

exit 0
