#!/usr/bin/env bash
# Start the GUI stack: Xvfb (DISPLAY :99) + openbox + x11vnc + noVNC (:6080).
# Idempotent — safe to call multiple times (e.g. via `docker exec <c> start-gui`).
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1440x900x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PORT="${VNC_PORT:-5900}"
LOG_DIR="${HOME}/.gui-logs"
mkdir -p "$LOG_DIR"

is_running() { pgrep -f "$1" >/dev/null 2>&1; }

if ! is_running "Xvfb ${DISPLAY}"; then
    Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp \
        >"$LOG_DIR/xvfb.log" 2>&1 &
    # wait for the X server to accept connections
    for _ in $(seq 1 50); do
        xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
        sleep 0.1
    done
fi

if ! is_running "openbox"; then
    openbox >"$LOG_DIR/openbox.log" 2>&1 &
fi

if ! is_running "x11vnc"; then
    x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -forever -shared \
        -nopw -quiet >"$LOG_DIR/x11vnc.log" 2>&1 &
fi

if ! is_running "websockify"; then
    websockify --web /usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
        >"$LOG_DIR/novnc.log" 2>&1 &
fi

echo "GUI stack running: DISPLAY=${DISPLAY}, noVNC at http://localhost:${NOVNC_PORT}/vnc.html"
