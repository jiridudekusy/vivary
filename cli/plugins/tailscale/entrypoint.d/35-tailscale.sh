#!/usr/bin/env bash
# Tailnet name resolution inside the sandbox. Opt in: SANDBOX_TAILSCALE=1
[ "${SANDBOX_TAILSCALE:-0}" = "1" ] || exit 0
sudo /usr/local/bin/apply-ts-hosts
