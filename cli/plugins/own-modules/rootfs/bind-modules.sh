#!/usr/bin/env bash
# Overlay node_modules dirs with container-side state (Apple `container`):
# reads the manifest written by the vivary CLI (and appended by
# modules-watch) and bind-mounts /vivary-modules/<slug> over each target.
# In-VM bind mounts don't consume virtiofs shares, so this scales to
# hundreds of packages. Runs as root via the sudoers entry; idempotent.
set -u

MAN=/vivary-modules/.manifest
[ -f "$MAN" ] || exit 0

# inotify headroom for modules-watch on large trees
sysctl -qw fs.inotify.max_user_watches=524288 2>/dev/null || true

fail=0
while IFS=$'\t' read -r slug target; do
    [ -n "$slug" ] && [ -n "$target" ] || continue
    case "$target" in /*) ;; *) continue ;; esac   # absolute paths only
    mkdir -p "/vivary-modules/$slug" "$target"
    if ! mountpoint -q "$target"; then
        if ! mount --bind "/vivary-modules/$slug" "$target"; then
            echo "WARNING: bind-modules: failed to overlay $target — installs there will hit the shared mount!" >&2
            fail=1
        fi
    fi
done < "$MAN"
exit $fail
