#!/usr/bin/env bash
# Sync the HOST clipboard into the X CLIPBOARD selection (:99) so X-native
# apps (e.g. Codex, which reads X11 directly via arboard instead of running
# xclip) see host content too. Claude Code doesn't need this — it shells out
# to xclip, which is shimmed to the broker.
#
# Uses the REAL xclip (/usr/bin/xclip) to own the selection; the PATH-first
# /usr/local/bin/xclip is the broker shim.
set -u

if [ -z "${SBX_OPEN_URL:-}" ] && [ -f "$HOME/.sandbox-open.env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.sandbox-open.env"
fi
[ -n "${SBX_OPEN_URL:-}" ] || exit 0

export DISPLAY="${DISPLAY:-:99}"
base="${SBX_OPEN_URL%/}/clipboard"
auth="token=${SBX_OPEN_TOKEN:-}&name=${SBX_SANDBOX_NAME:-}"
last=""

while :; do
    fp="$(curl -s --max-time 3 "$base?format=fingerprint&$auth" || true)"
    if [ -n "$fp" ] && [ "$fp" != "$last" ] && ! printf '%s' "$fp" | grep -q '"ok":false'; then
        targets="$(curl -s --max-time 3 "$base?format=targets&$auth" || true)"
        if printf '%s' "$targets" | grep -q image/png; then
            if curl -s --fail --max-time 8 "$base?format=png&$auth" -o /tmp/.hostclip.png; then
                /usr/bin/xclip -selection clipboard -t image/png -i /tmp/.hostclip.png
            fi
        else
            curl -s --fail --max-time 8 "$base?format=text&$auth" \
                | /usr/bin/xclip -selection clipboard -i
        fi
        last="$fp"
    fi
    sleep 1.5
done
