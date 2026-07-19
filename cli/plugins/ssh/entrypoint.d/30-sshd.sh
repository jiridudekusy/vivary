#!/usr/bin/env bash
# SSH access (Claude Desktop "Add SSH connection"). Opt in: SANDBOX_SSH=1
[ "${SANDBOX_SSH:-0}" = "1" ] || exit 0
sudo /usr/local/bin/start-sshd
