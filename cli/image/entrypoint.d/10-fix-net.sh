#!/usr/bin/env bash
# Network workarounds for Apple `container` VMs (see fix-net). Opt out: SKIP_NET_FIX=1
[ "${SKIP_NET_FIX:-0}" = "1" ] && exit 0
sudo /usr/local/bin/fix-net
