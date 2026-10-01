#!/usr/bin/env bash
# vivary entrypoint: run every hook in /etc/entrypoint.d (each self-gates on
# its own env variable), then exec the command. Hooks are contributed by
# plugins at image-compose time.
#
# The command runs under tini so that PID 1 REAPS orphans. Hooks start
# background daemons (sshd, Xvfb, clipboard-sync) that outlive the hook shell
# and reparent to PID 1; the payload commands (`sleep infinity` for `up`, the
# agent or bash for `start`/`shell`) never wait(), so every orphan that exits
# would stay a zombie forever. clipboard-sync makes this unbounded: it spawns
# one xclip per host-clipboard change, each superseded by the next (~1k
# zombies in a fortnight). Docker's --init would do the same, but Apple
# `container` has no such flag, so tini is baked into the image instead.
set -uo pipefail
export VIVARY_CMD="${1:-}"
for hook in /etc/entrypoint.d/*.sh; do
    [ -f "$hook" ] || continue
    bash "$hook" || echo "WARNING: entrypoint hook $(basename "$hook") failed" >&2
done
exec /usr/bin/tini -- "$@"
