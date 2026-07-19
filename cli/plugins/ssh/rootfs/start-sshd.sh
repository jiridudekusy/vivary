#!/usr/bin/env bash
# Start sshd for the sandbox. Runs as root (via the sudoers entry for user
# agent, see Dockerfile). Idempotent.
#
# Host keys are persisted in the mounted sandbox dir (~/host-ssh/hostkeys) so
# the SSH identity survives container rebuilds and clients don't get
# known_hosts warnings. authorized_keys comes from the same mount.
set -euo pipefail

SSH_STATE=/home/agent/host-ssh

pgrep -x sshd >/dev/null 2>&1 && exit 0

mkdir -p /run/sshd

if [ -d "$SSH_STATE/hostkeys" ] && ls "$SSH_STATE"/hostkeys/ssh_host_*_key >/dev/null 2>&1; then
    cp "$SSH_STATE"/hostkeys/ssh_host_* /etc/ssh/
    chmod 600 /etc/ssh/ssh_host_*_key
else
    ssh-keygen -A
    mkdir -p "$SSH_STATE/hostkeys"
    cp /etc/ssh/ssh_host_* "$SSH_STATE/hostkeys/"
fi

if [ -f "$SSH_STATE/authorized_keys" ]; then
    install -d -m 700 -o agent -g agent /home/agent/.ssh
    install -m 600 -o agent -g agent "$SSH_STATE/authorized_keys" \
        /home/agent/.ssh/authorized_keys
fi

/usr/sbin/sshd
echo "sshd running (port 22)"
