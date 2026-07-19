#!/usr/bin/env bash
# Bridge the clipboard between sandbox and host via the sbx broker.
# Installed as: xclip, xsel (what Claude Code uses for Ctrl+V image paste on
# Linux), pbcopy, pbpaste. Requires the sandbox to be started with
# --clipboard (enforced by the broker).
set -uo pipefail

if [ -z "${SBX_OPEN_URL:-}" ] && [ -f "$HOME/.sandbox-open.env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.sandbox-open.env"
fi
if [ -z "${SBX_OPEN_URL:-}" ]; then
    echo "host clipboard not available (start the sandbox with --clipboard)" >&2
    exit 1
fi

base="$(basename "$0")"
mode=write
format=text
case "$base" in
    pbpaste) mode=read ;;
    pbcopy) mode=write ;;
    xclip|xsel)
        # xclip defaults to input (write); -o/-out switches to output (read).
        # Claude Code first asks `-t TARGETS` to see what's available, then
        # reads `-t image/png`.
        for a in "$@"; do
            case "$a" in
                -o|-out|--output) mode=read ;;
                TARGETS) format=targets ;;
                image/png|image/bmp) format=png ;;
            esac
        done
        ;;
esac

url="${SBX_OPEN_URL%/}/clipboard"
if [ "$mode" = "read" ]; then
    exec curl -sS --fail --max-time 6 \
        "$url?token=${SBX_OPEN_TOKEN:-}&format=$format&name=${SBX_SANDBOX_NAME:-}"
else
    exec curl -sS --fail --max-time 6 -X POST "$url" \
        --data-urlencode "token=${SBX_OPEN_TOKEN:-}" \
        --data-urlencode "name=${SBX_SANDBOX_NAME:-}" \
        --data-urlencode "text@-" -o /dev/null
fi
