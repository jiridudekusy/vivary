#!/usr/bin/env bash
# Route npm/npx through the uu-safe-* wrappers by shimming them into
# ~/.local/bin (agent-owned, first on PATH — no root needed).
#
# Runs after 45-npmrc so the ignore-scripts hardening lands in the ~/.npmrc that
# hook has just rewritten from the host import.
set -uo pipefail

bin="$HOME/.local/bin"
shim=/usr/local/lib/vivary-uunpm-shim

# Always start from a clean slate: the flag is sticky, so turning it off must
# actually remove the shims (~/.local may be a persisted per-sandbox mount).
for name in npm npx; do
    [ -L "$bin/$name" ] && rm -f "$bin/$name"
done

[ -n "${SANDBOX_UUNPM:-}" ] || exit 0

if [ ! -x "$shim" ]; then
    echo "WARNING: --uunpm is on but the shim is missing from the image — rebuild with 'vivary build'" >&2
    exit 0
fi

mkdir -p "$bin"
for name in npm npx; do
    if [ -e "$bin/$name" ]; then
        echo "WARNING: $bin/$name exists and is not a vivary shim — leaving it alone, npm/npx are NOT routed through uunpm" >&2
        continue
    fi
    ln -s "$shim" "$bin/$name"
done

# Block install scripts for any npm invocation that BYPASSES the wrappers
# (absolute /usr/bin/npm, a toolchain spawning npm directly). The wrappers
# themselves pass --ignore-scripts=false, so `npm install` through the shim
# still runs scripts — this only closes the back door. `--uunpm=alias` opts out.
[ "${SANDBOX_UUNPM}" = "alias" ] && exit 0

npmrc="$HOME/.npmrc"
touch "$npmrc"
existing="$(grep -E '^[[:space:]]*ignore-scripts[[:space:]]*=' "$npmrc" | tail -1)"
case "$existing" in
    "")
        printf 'ignore-scripts=true\n' >> "$npmrc"
        ;;
    *=*[Tt]rue*)
        ;;  # already hardened (typically inherited from the host ~/.npmrc)
    *)
        # Never silently override an explicit opt-out — say which one wins.
        echo "WARNING: ~/.npmrc has '${existing# }' (imported from the host?) — leaving it;" \
             "install scripts stay enabled for npm calls that bypass uunpm" >&2
        ;;
esac
chmod 600 "$npmrc"
