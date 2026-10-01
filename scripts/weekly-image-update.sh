#!/bin/bash
# Weekly refresh of the vivary sandbox image, run by the
# net.vivary.image-update LaunchAgent (see scripts/net.vivary.image-update.plist).
#
# `vivary build --pull` rather than a bare build: without --pull the base image
# and every apt/Node/JDK/Gradle layer stay cached forever, so only the
# version-pinned bits (Claude Code, the uu-safe family) would ever move.
#
# Running containers are NOT touched. A rebuilt image only reaches a sandbox
# when its container is next created, so this never interrupts live work —
# `vivary up --recreate` is what adopts the new image.
set -uo pipefail

LOG_DIR="$HOME/.vivary/logs"
LOG="$LOG_DIR/image-update.log"
mkdir -p "$LOG_DIR"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
notify() {
    /usr/bin/osascript -e "display notification \"$1\" with title \"vivary\"" >/dev/null 2>&1 || true
}

say "=== weekly image update starting ==="

# A LaunchAgent gets a minimal PATH and no shell profile, so nvm is invisible.
# Resolving it through nvm (rather than hardcoding a version directory) is what
# keeps this working after a `nvm install` moves the default.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use default >/dev/null 2>&1
fi
if ! command -v vivary >/dev/null 2>&1; then
    say "FAILED: vivary not on PATH (nvm default = $(cat "$NVM_DIR/alias/default" 2>/dev/null || echo '?'))"
    notify "Image update failed: vivary not found"
    exit 1
fi
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

# The build goes through Docker (Apple's builder VM has broken Node DNS), so
# Docker Desktop has to be up. Start it and wait rather than failing: at 4am on
# a Sunday it is usually not running.
if ! docker info >/dev/null 2>&1; then
    say "docker not running — starting Docker Desktop"
    open -a Docker >/dev/null 2>&1
    for _ in $(seq 1 60); do
        docker info >/dev/null 2>&1 && break
        sleep 5
    done
fi
if ! docker info >/dev/null 2>&1; then
    say "FAILED: docker did not come up within 5 minutes"
    notify "Image update failed: Docker would not start"
    exit 1
fi

start=$(date +%s)
if vivary build --pull >>"$LOG" 2>&1; then
    say "OK: image rebuilt in $(( $(date +%s) - start ))s"
    notify "Sandbox image updated"
else
    say "FAILED: vivary build --pull exited non-zero (see above)"
    notify "Image update FAILED — see ~/.vivary/logs/image-update.log"
    exit 1
fi

# Keep the log from growing without bound — this runs unattended forever.
if [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
    tail -c 500000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    say "(log truncated)"
fi
