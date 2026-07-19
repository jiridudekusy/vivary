#!/usr/bin/env bash
# Docker-in-sandbox. Opt in: SANDBOX_DOCKER=1
[ "${SANDBOX_DOCKER:-0}" = "1" ] || exit 0
sudo /usr/local/bin/start-dockerd
