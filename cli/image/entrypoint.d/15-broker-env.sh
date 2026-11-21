#!/usr/bin/env bash
# Persist broker env for SSH sessions (they don't inherit container env).
# The token is NOT written here: it lives in RAM (/run/vivary/broker-token,
# handed in by vivary at every start) and the shims read it from there. Only a
# throwaway --rm run, or a container from before, carries it in its env.
set -u
[ -n "${SBX_OPEN_URL:-}" ] || exit 0
{
    printf 'SBX_OPEN_URL=%s\nSBX_SANDBOX_NAME=%s\n' "$SBX_OPEN_URL" "${SBX_SANDBOX_NAME:-}"
    [ -n "${SBX_OPEN_TOKEN:-}" ] && printf 'SBX_OPEN_TOKEN=%s\n' "$SBX_OPEN_TOKEN"
} > "$HOME/.sandbox-open.env"
chmod 600 "$HOME/.sandbox-open.env"
