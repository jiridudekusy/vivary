#!/usr/bin/env bash
# Forward "open this" requests to the host broker (sbx broker) so URLs open
# in the host browser and files in the host editor. Installed as xdg-open,
# open and code. Falls back to printing the target when no broker is
# configured (sandbox started without --host-open) or unreachable.
set -uo pipefail

# Main-process env comes via docker/container -e; SSH sessions don't inherit
# it, so the entrypoint persists it to ~/.sandbox-open.env.
if [ -z "${SBX_OPEN_URL:-}" ] && [ -f "$HOME/.sandbox-open.env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.sandbox-open.env"
fi

status=0
for target in "$@"; do
    case "$target" in -*) continue ;; esac   # ignore flags (e.g. `code -g`)

    action=path
    case "$target" in http://*|https://*) action=url ;; esac
    if [ "$action" = "path" ]; then
        target="$(realpath -m -- "$target" 2>/dev/null || echo "$target")"
    fi

    # `code <file>` means "open in the editor"; `open`/`xdg-open` mean
    # "open with the host's default application" (Word for .docx etc.).
    via=default
    [ "$(basename "$0")" = "code" ] && via=editor

    if [ -n "${SBX_OPEN_URL:-}" ]; then
        resp="$(curl -sS --max-time 6 -X POST "$SBX_OPEN_URL" \
            --data-urlencode "token=${SBX_OPEN_TOKEN:-}" \
            --data-urlencode "action=$action" \
            --data-urlencode "target=$target" \
            --data-urlencode "via=$via" \
            --data-urlencode "name=${SBX_SANDBOX_NAME:-}" 2>&1)" || resp=""
        case "$resp" in
            *'"ok":true'*) continue ;;
            '') echo "host-open: broker unreachable" >&2 ;;
            *) echo "host-open: $resp" >&2 ;;
        esac
        status=1
    fi
    echo "→ $target"
done
exit $status
