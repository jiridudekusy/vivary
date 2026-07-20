#!/usr/bin/env bash
# Root helper (sudoers entry for user agent): hand the app-server-control
# tmpfs to the agent user. The tmpfs vivary mounts over
# ~/.codex/app-server-control comes up root-owned; the codex app-server
# secures its control dir (chown/chmod) and dies with EPERM when it does
# not own it.
set -eu

CTL=/home/agent/.codex/app-server-control
if mountpoint -q "$CTL" 2>/dev/null; then
    chown agent:agent "$CTL"
    chmod 700 "$CTL"
fi
