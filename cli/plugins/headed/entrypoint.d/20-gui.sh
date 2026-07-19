#!/usr/bin/env bash
# GUI stack (Xvfb + x11vnc + noVNC). Opt in: HEADED=1
[ "${HEADED:-0}" = "1" ] || exit 0
start-gui
