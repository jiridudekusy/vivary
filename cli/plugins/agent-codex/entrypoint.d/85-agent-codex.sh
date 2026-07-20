#!/usr/bin/env bash
# Codex integration: make the app-server-control tmpfs (mounted by vivary,
# see plugin.mjs runArgs) writable by the agent user — the codex app-server
# (phone/IDE SSH remote control) refuses a control dir it does not own.
set -u

if [ -d "${HOME}/.codex/app-server-control" ]; then
    sudo -n /usr/local/bin/fix-codex-ctl \
        || echo "WARNING: fix-codex-ctl failed; codex remote control will not work" >&2
fi
exit 0
