#!/usr/bin/env bash
# Base entrypoint.
#
# HEADED=1  -> start the GUI stack (Xvfb + openbox + x11vnc + noVNC on :6080)
#              so a headed browser is visible at http://localhost:6080/vnc.html
# otherwise -> purely headless; the GUI stack can still be enabled later with
#              `start-gui` inside a running container.
set -euo pipefail

# Network workarounds for Apple `container` VMs (see fix-net): AAAA DNS fix
# + host.docker.internal mapping. Opt out: SKIP_NET_FIX=1
if [ "${SKIP_NET_FIX:-0}" != "1" ]; then
    sudo /usr/local/bin/fix-net || true
fi

if [ "${HEADED:-0}" = "1" ]; then
    start-gui
fi

# SSH access (Claude Desktop "Add SSH connection"). Opt in: SANDBOX_SSH=1
if [ "${SANDBOX_SSH:-0}" = "1" ]; then
    sudo /usr/local/bin/start-sshd || echo "WARNING: sshd failed to start" >&2
fi

# Docker-in-sandbox. Opt in: SANDBOX_DOCKER=1
if [ "${SANDBOX_DOCKER:-0}" = "1" ]; then
    sudo /usr/local/bin/start-dockerd || echo "WARNING: dockerd failed to start" >&2
fi

# Host-open: persist broker env for SSH sessions (they don't inherit it)
if [ -n "${SBX_OPEN_URL:-}" ]; then
    printf 'SBX_OPEN_URL=%s\nSBX_OPEN_TOKEN=%s\nSBX_SANDBOX_NAME=%s\n' \
        "$SBX_OPEN_URL" "${SBX_OPEN_TOKEN:-}" "${SBX_SANDBOX_NAME:-}" \
        > "$HOME/.sandbox-open.env"
    chmod 600 "$HOME/.sandbox-open.env"
fi

# node_modules overlays (Apple container path): bind container-side dirs over
# workspace node_modules, then watch for new package.json files live.
if [ "${SANDBOX_MODULES:-0}" = "1" ] && [ -d /vivary-modules ]; then
    sudo /usr/local/bin/bind-modules \
        || echo "WARNING: node_modules overlays incomplete (see above)" >&2
    pgrep -f "bin/modules-watch" >/dev/null 2>&1 \
        || modules-watch >"$HOME/.modules-watch.log" 2>&1 &
fi

# X-native apps (Codex/arboard) read the clipboard from the X server, not via
# xclip — run a bare Xvfb plus the host->X clipboard sync when enabled.
if [ "${SANDBOX_CLIPBOARD:-0}" = "1" ]; then
    pgrep -f "Xvfb ${DISPLAY:-:99}" >/dev/null 2>&1 \
        || Xvfb "${DISPLAY:-:99}" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
    pgrep -f "bin/clipboard-sync" >/dev/null 2>&1 \
        || clipboard-sync >"$HOME/.clipboard-sync.log" 2>&1 &
fi

exec "$@"
