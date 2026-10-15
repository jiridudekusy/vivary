#!/usr/bin/env bash
# Overlay node_modules dirs with container-side state (Apple `container`):
# reads the manifest written by the vivary CLI (and appended by
# modules-watch) and bind-mounts /vivary-modules-store/<slug> — the sandbox's
# own volume — over each target (/vivary-modules/<slug>, the host share, in a
# container created before the store volume existed). In-VM bind mounts don't
# consume virtiofs shares, so this scales to hundreds of packages. Runs as
# root via the sudoers entry; idempotent.
#
# SECURITY: the manifest lives in /vivary-modules, which the (untrusted) agent
# can write, and this helper runs as root — so every entry is VALIDATED, never
# trusted. The slug must be a single plain path component (no separators, no
# `..`), and the target must canonicalize to a `<pkg>/node_modules` directory
# strictly INSIDE this sandbox's workspace. The workspace root is read from
# PID 1's environment (set by the vivary run args, not forgeable by the agent),
# exactly like the --sudo gate in enable-sudo. Without this, a tampered
# manifest could bind agent-controlled content over e.g. /usr/local/bin and
# escalate to root.
set -u

MAN=/vivary-modules/.manifest
[ -f "$MAN" ] || exit 0

# Trusted workspace root from PID 1 (unforgeable by the agent). runuser -u
# agent matches PID 1's uid, so the read needs no CAP_SYS_PTRACE; root spawns
# the pipeline, so the agent cannot tamper with the data.
WS=$(runuser -u agent -- cat /proc/1/environ 2>/dev/null | tr '\0' '\n' \
        | sed -n 's/^SANDBOX_WORKSPACE=//p' | head -n1)
WSC=$(realpath -m -- "${WS:-/nonexistent}")
if [ -z "$WS" ] || [ "$WSC" = "/" ]; then
    echo "ERROR: bind-modules: no usable SANDBOX_WORKSPACE from PID 1 — refusing" >&2
    exit 1
fi

# inotify headroom for modules-watch on large trees
sysctl -qw fs.inotify.max_user_watches=524288 2>/dev/null || true

# Where the overlays live. With the per-sandbox store VOLUME mounted (Apple
# `container`, see plugin.mjs) they come from the sandbox's own disk; without it
# (a container created before the switch) from the host share, as before. The
# share still carries the manifest either way.
STORE=/vivary-modules-store
mountpoint -q "$STORE" && use_store=1 || use_store=0
BOOT=$(cat /proc/sys/kernel/random/boot_id)
migrated=0

# One-time move of a slug's modules from the host share onto the volume, so the
# switch costs no reinstall. The source is agent-writable and this runs as
# root, so ownership is NOT preserved (the copy is root's, then handed to
# agent) and setuid/setgid bits are stripped: a planted root-owned setuid
# file must not come out the other side as one. Symlinks are copied as links.
migrate() {
    local slug=$1 legacy="/vivary-modules/$1" tmp="$STORE/.migrating-$1"
    [ -d "$legacy" ] && [ ! -L "$legacy" ] || return 1
    [ -n "$(ls -A "$legacy" 2>/dev/null)" ] || return 1
    echo "bind-modules: moving $slug/node_modules off the Mac onto the sandbox volume (one-time)" >&2
    rm -rf "$tmp"
    if cp -rP --preserve=mode,timestamps,links "$legacy" "$tmp" \
        && chown -R agent:agent "$tmp" && chmod -R u-s,g-s "$tmp" \
        && mv "$tmp" "$STORE/$slug"; then
        migrated=1
        return 0
    fi
    echo "WARNING: bind-modules: migrating $slug failed — starting it empty (npm install restores it)" >&2
    rm -rf "$tmp"
    return 1
}

reject() { echo "WARNING: bind-modules: refusing manifest entry ($1): $2" >&2; fail=1; }

fail=0
while IFS=$'\t' read -r slug target; do
    [ -n "$slug" ] && [ -n "$target" ] || continue

    # slug: one plain path component under /vivary-modules, no traversal.
    case "$slug" in
        *[!A-Za-z0-9._-]*) reject "$slug" "illegal character in slug"; continue ;;
        *..*)              reject "$slug" "slug contains '..'";        continue ;;
    esac
    if [ "$use_store" = 1 ]; then src="$STORE/$slug"; else src="/vivary-modules/$slug"; fi
    [ -L "$src" ] && { reject "$slug" "source is a symlink"; continue; }

    # target: absolute, canonicalizes to <dir>/node_modules INSIDE the workspace.
    case "$target" in /*) ;; *) reject "$target" "target is not absolute"; continue ;; esac
    ctarget=$(realpath -m -- "$target")
    case "$ctarget" in */node_modules) ;; *) reject "$target" "target is not a node_modules dir"; continue ;; esac
    pkgdir=${ctarget%/node_modules}
    case "$pkgdir" in
        "$WSC"|"$WSC"/*) ;;
        *) reject "$target" "target is outside the workspace ($WSC)"; continue ;;
    esac

    if [ "$use_store" = 1 ] && [ ! -e "$src" ]; then
        migrate "$slug" || mkdir -p "$src"
        # The volume is root's; npm runs as agent.
        chown agent:agent "$src"
    fi
    mkdir -p "$src" "$ctarget"
    if ! mountpoint -q "$ctarget"; then
        if ! mount --bind "$src" "$ctarget"; then
            echo "WARNING: bind-modules: failed to overlay $ctarget — installs there will hit the shared mount!" >&2
            fail=1
        fi
    fi
done < "$MAN"

# Reading the old tree through the share pinned a host file per entry; drop the
# guest's cache so those are released now rather than whenever.
[ "$migrated" = 1 ] && { sync; echo 2 > /proc/sys/vm/drop_caches; } 2>/dev/null

# Hand space freed by deleted modules back to the Mac — the volume is a sparse
# image that otherwise only grows. Once per boot (the watcher re-runs this
# helper for every new package), in the background: it never blocks a start.
if [ "$use_store" = 1 ] && [ "$(cat /run/vivary-modules.trimmed 2>/dev/null)" != "$BOOT" ]; then
    echo "$BOOT" > /run/vivary-modules.trimmed
    ( fstrim "$STORE" >/dev/null 2>&1 & )
fi

# Done for this boot: the host's postUp waits for this before handing the
# sandbox to an agent (see plugin.mjs). Written even after a refused entry —
# the attempt is over, and waiting would not change it.
echo "$BOOT" > /run/vivary-modules.ready
exit $fail
