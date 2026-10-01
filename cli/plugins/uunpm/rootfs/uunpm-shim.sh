#!/bin/sh
# PATH shim that routes npm/npx through the uu-safe-* wrappers.
# Installed (by the 47-uunpm entrypoint hook, only when the flag is on) as
# ~/.local/bin/npm and ~/.local/bin/npx — that dir is agent-owned and first on
# PATH in every entry path (container ENV and /etc/profile.d/sandbox.sh), so no
# root is needed and ssh/exec sessions are covered too.
#
# A shell alias would NOT do: agents run `npm ...` through non-interactive
# `bash -c`, which never reads .bashrc aliases.
#
# RECURSION GUARD — uunpm/uunpx spawn bare `npm` and `npx` from PATH
# themselves (uunpm: `npm view uu-safe-<cmd>` probe + passthrough for unmapped
# commands; uunpx: `npm install --package-lock-only`, `npm ls`, and finally the
# real `npx`). Without the guard the shim would re-enter the wrapper forever.
# The guard is EXPORTED, so every nested call inside a wrapper reaches the real
# binary: the outer command is security-checked once, the wrapper's own plumbing
# runs unshimmed.
set -u

real="/usr/bin/$(basename "$0")"

if [ -n "${VIVARY_UUNPM_INNER:-}" ]; then
    exec "$real" "$@"
fi

case "$(basename "$0")" in
    npm) wrapper=uunpm ;;
    npx) wrapper=uunpx ;;
    *)   exec "$real" "$@" ;;
esac

# No wrapper on PATH (image built before this plugin) — fall back loudly
# rather than breaking npm entirely.
if ! command -v "$wrapper" >/dev/null 2>&1; then
    echo "WARNING: $wrapper not found in the image — running plain $(basename "$0")" >&2
    exec "$real" "$@"
fi

VIVARY_UUNPM_INNER=1 export VIVARY_UUNPM_INNER
exec "$wrapper" "$@"
