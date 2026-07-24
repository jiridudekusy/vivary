#!/usr/bin/env bash
# Overlay node_modules dirs with container-side state (Apple `container`):
# reads the manifest written by the vivary CLI (and appended by
# modules-watch) and bind-mounts /vivary-modules/<slug> over each target.
# In-VM bind mounts don't consume virtiofs shares, so this scales to
# hundreds of packages. Runs as root via the sudoers entry; idempotent.
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

reject() { echo "WARNING: bind-modules: refusing manifest entry ($1): $2" >&2; fail=1; }

fail=0
while IFS=$'\t' read -r slug target; do
    [ -n "$slug" ] && [ -n "$target" ] || continue

    # slug: one plain path component under /vivary-modules, no traversal.
    case "$slug" in
        *[!A-Za-z0-9._-]*) reject "$slug" "illegal character in slug"; continue ;;
        *..*)              reject "$slug" "slug contains '..'";        continue ;;
    esac
    src="/vivary-modules/$slug"
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

    mkdir -p "$src" "$ctarget"
    if ! mountpoint -q "$ctarget"; then
        if ! mount --bind "$src" "$ctarget"; then
            echo "WARNING: bind-modules: failed to overlay $ctarget — installs there will hit the shared mount!" >&2
            fail=1
        fi
    fi
done < "$MAN"
exit $fail
