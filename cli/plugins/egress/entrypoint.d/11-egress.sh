#!/usr/bin/env bash
# Egress control. Opt in: SANDBOX_EGRESS=1. Runs at 11 — after 10-fix-net
# (which sets resolv.conf + host.docker.internal) and before the agent hooks
# (80+), so the ASHP CA is trusted before any agent makes an HTTPS request.
[ "${SANDBOX_EGRESS:-0}" = "1" ] || exit 0
# The agent token arrives in RAM right after the start (/run/vivary, handed in
# by vivary); a container from before has it in its env.
token="${SBX_EGRESS_TOKEN:-}"
if [ -z "$token" ]; then
    for _ in $(seq 1 60); do
        [ -s /run/vivary/egress-token ] && break
        sleep 1
    done
    [ -s /run/vivary/egress-token ] && token="$(cat /run/vivary/egress-token)"
fi
sudo /usr/local/bin/egress-setup \
    "${SBX_EGRESS_ASHP_IP:-}" "${SBX_EGRESS_AGENT:-}" "$token" \
    "${SBX_EGRESS_MGMT_HOST:-vivary-ashp}" \
    || echo "WARNING: egress-setup failed — sandbox egress may be broken or unfiltered" >&2
