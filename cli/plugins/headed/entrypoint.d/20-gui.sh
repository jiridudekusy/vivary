#!/usr/bin/env bash
# GUI stack (Xvfb + openbox + x11vnc on loopback, viewed via vivary web). Opt in: HEADED=1
[ "${HEADED:-0}" = "1" ] || exit 0
start-gui
