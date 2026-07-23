#!/usr/bin/env bash
# Egress control. Opt in: SANDBOX_EGRESS=1. Runs at 11 — after 10-fix-net
# (which sets resolv.conf + host.docker.internal) and before the agent hooks
# (80+), so the ASHP CA is trusted before any agent makes an HTTPS request.
[ "${SANDBOX_EGRESS:-0}" = "1" ] || exit 0
sudo /usr/local/bin/egress-setup \
    "${SBX_EGRESS_ASHP_IP:-}" "${SBX_EGRESS_AGENT:-}" "${SBX_EGRESS_TOKEN:-}" \
    "${SBX_EGRESS_MGMT_HOST:-vivary-ashp}" \
    || echo "WARNING: egress-setup failed — sandbox egress may be broken or unfiltered" >&2
