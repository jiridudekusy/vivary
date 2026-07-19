#!/usr/bin/env bash
# Watch the workspace for NEW package.json files (npm init, git checkout,
# agent-created) and overlay their node_modules immediately — before the
# first `npm install` runs. Watching package.json instead of node_modules
# avoids racing an in-progress install.
set -u

WS="${SANDBOX_WORKSPACE:-$PWD}"
DEPTH="${SANDBOX_MODULES_DEPTH:-4}"
command -v inotifywait >/dev/null 2>&1 || exit 0
[ -d /vivary-modules ] || exit 0

# Overlay <dir>/node_modules if within the depth limit and not yet bound.
handle_pkg() {
    dir="$1"
    rel="${dir#"$WS"}"; rel="${rel#/}"
    if [ -n "$rel" ]; then
        d=$(printf '%s' "$rel" | awk -F/ '{print NF}')
    else
        d=0
    fi
    [ "$d" -le "$DEPTH" ] || return 0
    slug=$(printf '%s' "${rel:-root}" | sed 's#[^a-zA-Z0-9._-]#-#g')
    grep -q "^$slug	" /vivary-modules/.manifest 2>/dev/null && return 0
    mkdir -p "/vivary-modules/$slug" "$dir/node_modules"
    printf '%s\t%s\n' "$slug" "$dir/node_modules" >> /vivary-modules/.manifest
    sudo /usr/local/bin/bind-modules \
        || echo "WARNING: live overlay failed for $dir" >&2
    echo "overlaid $dir/node_modules"
}

inotifywait -m -r -q -e create -e moved_to --format '%w%f' \
    --exclude '(/node_modules(/|$)|/\.git(/|$))' "$WS" 2>/dev/null \
| while read -r p; do
    if [ "$(basename "$p")" = "package.json" ]; then
        handle_pkg "$(dirname "$p")"
    elif [ -d "$p" ]; then
        # New directory: files created inside it before our watch attached
        # were never seen (inotify race) — settle briefly, then scan it.
        sleep 0.3
        find "$p" -maxdepth 4 -name node_modules -prune -o \
            -type f -name package.json -print 2>/dev/null \
        | while read -r f; do handle_pkg "$(dirname "$f")"; done
    fi
done
