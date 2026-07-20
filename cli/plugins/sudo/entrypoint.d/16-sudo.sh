#!/usr/bin/env bash
# --sudo: full passwordless sudo for the agent user (see enable-sudo helper).
set -u

[ "${SANDBOX_SUDO:-}" = "1" ] || exit 0
sudo -n /usr/local/bin/enable-sudo \
    || echo "WARNING: enable-sudo failed; agent has no full sudo" >&2
exit 0
