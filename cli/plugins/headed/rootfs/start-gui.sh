#!/usr/bin/env bash
# Start the GUI stack: Xvfb (DISPLAY :99) + openbox + x11vnc + noVNC (:6080).
# Idempotent — run at boot by the 20-gui hook (HEADED=1) and live by the
# headed plugin's postUp (`<runtime> exec ... setsid -w start-gui`).
#
# Started live through Apple `container` exec, x11vnc lands in a different IPC
# namespace than an Xvfb started at boot (the clipboard plugin's), so MIT-SHM
# fails ("BadAccess ... X_ShmAttach") and x11vnc dies: hence -noshm.
# x11vnc listens on localhost only and requires VIVARY_VNC_PASSWORD: the only
# way in is noVNC with this sandbox's password (see the headed plugin).
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1440x900x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PORT="${VNC_PORT:-5900}"
LOG_DIR="${HOME}/.gui-logs"
mkdir -p "$LOG_DIR"

if [ -z "${VIVARY_VNC_PASSWORD:-}" ]; then
    echo "start-gui: VIVARY_VNC_PASSWORD is not set — refusing to serve VNC without a password" >&2
    exit 1
fi

# By process NAME (pgrep -x), not by command line: `pgrep -f openbox` also
# matched any shell whose command line merely mentioned openbox, and then the
# stack was silently never started.
running() { pgrep -x "$1" >/dev/null 2>&1; }

if ! pgrep -fx "Xvfb ${DISPLAY}( .*)?" >/dev/null 2>&1; then
    Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp \
        >"$LOG_DIR/xvfb.log" 2>&1 &
fi
# Wait for the display whoever started it. Run live right after a container
# start, this races the boot hooks: the clipboard plugin's Xvfb process
# already exists but does not accept connections yet, and an x11vnc started
# then dies with "cannot open display" (seen 1 restart in 3).
for _ in $(seq 1 100); do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
    sleep 0.1
done

running openbox || { openbox >"$LOG_DIR/openbox.log" 2>&1 & }

# A server started before passwords existed (or by hand) keeps serving without
# one; replace it rather than leave it. SIGTERM is not enough: an x11vnc
# wedged with a client attached ignored it (backlog filling, no accept), so
# fall back to SIGKILL — a passwordless server must not outlive this.
for pid in $(pgrep -x x11vnc || true); do
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- '-rfbauth' && continue
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
done
vnc_listening() { (exec 3<>"/dev/tcp/127.0.0.1/${VNC_PORT}") 2>/dev/null; }
start_x11vnc() {
    mkdir -p "$HOME/.vnc"
    x11vnc -storepasswd "$VIVARY_VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
    x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -localhost -noshm \
        -rfbauth "$HOME/.vnc/passwd" -forever -shared -quiet \
        >"$LOG_DIR/x11vnc.log" 2>&1 &
    for _ in $(seq 1 50); do vnc_listening && return 0; sleep 0.1; done
    return 1
}
if ! running x11vnc; then
    start_x11vnc || { pkill -x x11vnc 2>/dev/null || true; sleep 0.5; start_x11vnc || true; }
fi

running websockify || {
    websockify --web /usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
        >"$LOG_DIR/novnc.log" 2>&1 &
}
# The URL is printed as soon as this returns, so noVNC must be answering too.
for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/127.0.0.1/${NOVNC_PORT}") 2>/dev/null && break
    sleep 0.1
done

if ! vnc_listening; then
    echo "start-gui: x11vnc did not start — see $LOG_DIR/x11vnc.log" >&2
    exit 1
fi
echo "GUI stack running: DISPLAY=${DISPLAY}, noVNC on :${NOVNC_PORT} (password-protected)"
