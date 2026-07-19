#!/usr/bin/env bash
# Persist broker env for SSH sessions (they don't inherit container env).
set -u
[ -n "${SBX_OPEN_URL:-}" ] || exit 0
printf 'SBX_OPEN_URL=%s\nSBX_OPEN_TOKEN=%s\nSBX_SANDBOX_NAME=%s\n' \
    "$SBX_OPEN_URL" "${SBX_OPEN_TOKEN:-}" "${SBX_SANDBOX_NAME:-}" \
    > "$HOME/.sandbox-open.env"
chmod 600 "$HOME/.sandbox-open.env"
