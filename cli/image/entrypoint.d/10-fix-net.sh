#!/usr/bin/env bash
# Network workarounds for Apple `container` VMs (see fix-net). Opt out: SKIP_NET_FIX=1
[ "${SKIP_NET_FIX:-0}" = "1" ] && exit 0
# Egress sandboxes have no resolver yet (ASHP DNS comes in the next hook) —
# tell fix-net to skip its DNS probe instead of waiting out its timeout.
if [ "${SANDBOX_EGRESS:-0}" = "1" ]; then
    sudo /usr/local/bin/fix-net --no-dns-probe
else
    sudo /usr/local/bin/fix-net
fi
