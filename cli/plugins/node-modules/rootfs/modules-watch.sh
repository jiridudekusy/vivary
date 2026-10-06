#!/usr/bin/env bash
# Watch the workspace for NEW package.json files (npm init, git checkout,
# agent-created) and overlay their node_modules immediately — before the
# first `npm install` runs. Watching package.json instead of node_modules
# avoids racing an in-progress install.
#
# Only the directories the handler can act on are watched: depth 0..DEPTH,
# never inside node_modules/.git/.hg — the same rules as the host-side scan
# (discoverPackageDirs in plugin.mjs). NOT `inotifywait -r --exclude`: in
# inotify-tools 3.22 the exclude regex only filters the EVENTS reported, while
# -r still puts a watch on every subdirectory, node_modules included. Measured
# on a large workspace: 43 306 watches, 20 564 of them inside node_modules
# trees. A watch pins its directory's inode in the guest cache, and through
# virtiofs that is one open file on the HOST per directory, which no cache drop
# can release — the host's open-file table is what froze the Mac. The depth
# limit alone cut the same workspace to ~5 000 watches.
set -u

WS="${SANDBOX_WORKSPACE:-$PWD}"
DEPTH="${SANDBOX_MODULES_DEPTH:-4}"
command -v inotifywait >/dev/null 2>&1 || exit 0
[ -d /vivary-modules ] || exit 0

# Directory depth below the workspace root (the root itself is 0).
depth_of() {
    local rel="${1#"$WS"}"
    rel="${rel#/}"; rel="${rel%/}"
    if [ -z "$rel" ]; then echo 0; else printf '%s' "$rel" | awk -F/ '{print NF}'; fi
}

# Overlay <dir>/node_modules if within the depth limit and not yet bound.
handle_pkg() {
    dir="$1"
    rel="${dir#"$WS"}"; rel="${rel#/}"
    [ "$(depth_of "$dir")" -le "$DEPTH" ] || return 0
    slug=$(printf '%s' "${rel:-root}" | sed 's#[^a-zA-Z0-9._-]#-#g')
    grep -q "^$slug	" /vivary-modules/.manifest 2>/dev/null && return 0
    mkdir -p "/vivary-modules/$slug" "$dir/node_modules"
    printf '%s\t%s\n' "$slug" "$dir/node_modules" >> /vivary-modules/.manifest
    sudo /usr/local/bin/bind-modules \
        || echo "WARNING: live overlay failed for $dir" >&2
    echo "overlaid $dir/node_modules"
}

# Walk `root` at most `maxdepth` levels down, never into node_modules/.git/.hg.
walk() {
    find "$1" -maxdepth "$2" \( -name node_modules -o -name .git -o -name .hg \) -prune -o "${@:3}" 2>/dev/null
}

# Every package.json within the limit that has no overlay yet. Run whenever the
# watch list is (re)built: a directory created while no watch covered it — at
# start, or during a rebuild — would otherwise go unseen. handle_pkg skips
# what the manifest already has, so this is a no-op when nothing was missed.
catch_up() {
    walk "$WS" "$((DEPTH + 1))" -type f -name package.json -print \
    | while read -r f; do handle_pkg "$(dirname "$f")"; done
}

LIST=$(mktemp) ERR=$(mktemp) FIFO=$(mktemp -u)
mkfifo "$FIFO"
# Read-write open never blocks, so inotifywait can start writing before the
# event loop reads — the watches must be in place BEFORE catch_up looks for
# what was missed, or a package.json created in between is lost.
exec 3<>"$FIFO"
WPID=
trap 'kill "$WPID" 2>/dev/null; rm -f "$LIST" "$ERR" "$FIFO"' EXIT

while :; do
    walk "$WS" "$DEPTH" -type d -print > "$LIST"
    : > "$ERR"
    inotifywait -m -e create -e moved_to --format '%w%f' --fromfile "$LIST" >&3 2>"$ERR" &
    WPID=$!
    for _ in $(seq 300); do
        grep -q 'Watches established' "$ERR" && break
        kill -0 "$WPID" 2>/dev/null || break
        sleep 0.1
    done
    if ! kill -0 "$WPID" 2>/dev/null; then
        echo "WARNING: inotifywait failed: $(tr '\n' ' ' < "$ERR")" >&2
        sleep 30; continue
    fi
    catch_up
    # Non-recursive watches: a NEW directory inside the limit is not covered
    # yet, so the loop ends there and the list is rebuilt (a find over ~5k
    # dirs). Directories appear far less often than files, and a node_modules
    # being populated never triggers it — it is pruned.
    while :; do
        if ! read -r -t 60 p <&3; then
            kill -0 "$WPID" 2>/dev/null && continue
            echo "WARNING: inotifywait exited: $(tr '\n' ' ' < "$ERR")" >&2
            break
        fi
        name=${p##*/}
        if [ "$name" = "package.json" ]; then
            handle_pkg "${p%/*}"
        elif [ -d "$p" ]; then
            case "$name" in node_modules|.git|.hg) continue ;; esac
            [ "$(depth_of "$p")" -le "$DEPTH" ] && break
        fi
    done
    kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null
    # Let a burst (git checkout, unzip) settle, then drop the events still
    # queued: the rebuild's catch_up covers them, and replaying them would
    # rebuild once per directory.
    sleep 0.3
    while read -r -t 0.05 _ <&3; do :; done
done
