#!/usr/bin/env bash
# Start the GUI stack: Xvfb (DISPLAY :99) + openbox + x11vnc on 127.0.0.1:5900.
# Idempotent — run at boot by the 20-gui hook (HEADED=1) and live by the
# headed plugin's postUp (`<runtime> exec ... setsid -w start-gui`).
#
# VNC never listens on the network. The one viewer is `vivary web` on the Mac
# (passkey login); it reaches x11vnc through `<runtime> exec -i <container>
# vnc-relay`, the runtime's own exec channel. So x11vnc runs WITHOUT a
# password: only processes inside this sandbox reach 127.0.0.1:5900, and the
# agent already owns this display. (Before: noVNC on 0.0.0.0:6080, first with
# no password at all — another sandbox could open this browser — then behind
# VNC's own password, which the protocol cuts to 8 characters.)
#
# Started live through Apple `container` exec, x11vnc lands in a different IPC
# namespace than an Xvfb started at boot (the clipboard plugin's), so MIT-SHM
# fails ("BadAccess ... X_ShmAttach") and x11vnc dies: hence -noshm.
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1440x900x24}"
VNC_PORT="${VNC_PORT:-5900}"
LOG_DIR="${HOME}/.gui-logs"
mkdir -p "$LOG_DIR"

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

vnc_listening() { (exec 3<>"/dev/tcp/127.0.0.1/${VNC_PORT}") 2>/dev/null; }
start_x11vnc() {
    # -localhost: 127.0.0.1/::1 only. -nopw: see the header — the network
    # cannot reach it, so a password would only stand between the user and
    # their own screen.
    x11vnc -display "${DISPLAY}" -rfbport "${VNC_PORT}" -localhost -nopw -noshm \
        -forever -shared -quiet \
        >"$LOG_DIR/x11vnc.log" 2>&1 &
    for _ in $(seq 1 50); do vnc_listening && return 0; sleep 0.1; done
    return 1
}
if ! running x11vnc; then
    start_x11vnc || { pkill -x x11vnc 2>/dev/null || true; sleep 0.5; start_x11vnc || true; }
fi

if ! vnc_listening; then
    echo "start-gui: x11vnc did not start — see $LOG_DIR/x11vnc.log" >&2
    exit 1
fi
echo "GUI stack running: DISPLAY=${DISPLAY}, VNC on 127.0.0.1:${VNC_PORT} (reached through vivary web only)"
