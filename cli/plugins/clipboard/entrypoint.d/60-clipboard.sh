#!/usr/bin/env bash
# X-native apps (Codex/arboard) read the clipboard from the X server, not via
# xclip — run a bare Xvfb plus the host->X clipboard sync when enabled.
[ "${SANDBOX_CLIPBOARD:-0}" = "1" ] || exit 0
pgrep -f "Xvfb ${DISPLAY:-:99}" >/dev/null 2>&1 \
    || Xvfb "${DISPLAY:-:99}" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
pgrep -f "bin/clipboard-sync" >/dev/null 2>&1 \
    || clipboard-sync >"$HOME/.clipboard-sync.log" 2>&1 &
exit 0
