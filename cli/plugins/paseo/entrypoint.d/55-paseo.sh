#!/usr/bin/env bash
# Start the Paseo daemon. Opt in: SANDBOX_PASEO=1
#
# The password is read from the mounted state dir rather than an -e variable, so
# it does not show up in the container's config (`container inspect`). The hook
# supplies it on every start, and the entrypoint re-runs on every container
# start, so a daemon started this way is always authenticated.
set -uo pipefail

[ "${SANDBOX_PASEO:-0}" = "1" ] || exit 0

PW_FILE=/home/agent/.paseo/.vivary-password
if [ ! -r "$PW_FILE" ]; then
    echo "WARNING: paseo password file missing ($PW_FILE) — NOT starting the daemon." >&2
    echo "         Publishing it unauthenticated would expose every agent in this" >&2
    echo "         sandbox to the whole tailnet. Re-run 'vivary up' on the host." >&2
    exit 0
fi

# Already healthy? The entrypoint runs on every start, including restarts.
port="${PASEO_LISTEN##*:}"
if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    exit 0
fi

PASEO_PASSWORD="$(cat "$PW_FILE")" paseo start >/dev/null 2>&1

for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
        echo "paseo daemon running (port ${port})"
        exit 0
    fi
    sleep 0.5
done

# Loud, but never fatal: a broken daemon must not stop the sandbox from coming
# up — ssh and the agents are still worth having.
echo "WARNING: paseo daemon did not become healthy within 15s." >&2
echo "         Logs: ~/.paseo/daemon.log" >&2
exit 0
