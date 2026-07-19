#!/usr/bin/env bash
# vivary entrypoint: run every hook in /etc/entrypoint.d (each self-gates on
# its own env variable), then exec the command. Hooks are contributed by
# plugins at image-compose time.
set -uo pipefail
export VIVARY_CMD="${1:-}"
for hook in /etc/entrypoint.d/*.sh; do
    [ -f "$hook" ] || continue
    bash "$hook" || echo "WARNING: entrypoint hook $(basename "$hook") failed" >&2
done
exec "$@"
