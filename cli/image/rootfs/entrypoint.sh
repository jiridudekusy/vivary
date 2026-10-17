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

# Stale X server locks. A kept container's /tmp lives on its rootfs and
# survives a stop/start, where a normal Linux boot would clear it. Xvfb treats
# /tmp/.X99-lock as live when the PID inside it exists — and after a restart
# that PID is routinely reused (measured: the lock said 49, PID 49 was now
# clipboard-sync). Xvfb then exits "already active", so the clipboard's X
# server and the headed GUI failed on about one restart in five. Nothing can
# be serving a display this early in a boot, so every such lock is stale.
rm -f /tmp/.X[0-9]*-lock /tmp/.X11-unix/X[0-9]* 2>/dev/null || true
for hook in /etc/entrypoint.d/*.sh; do
    [ -f "$hook" ] || continue
    bash "$hook" || echo "WARNING: entrypoint hook $(basename "$hook") failed" >&2
done
exec /usr/bin/tini -- "$@"
