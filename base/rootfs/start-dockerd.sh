#!/usr/bin/env bash
# Start dockerd for docker-in-sandbox. Runs as root (via the sudoers entry
# for user agent, see Dockerfile). Idempotent.
#
# Storage backing: under the docker runtime /var/lib/docker is a named volume
# (overlay2 can't sit on overlayfs); under Apple `container` the VM rootfs is
# ext4 which overlay2 handles directly.
set -euo pipefail

# Already healthy? (a plain pgrep would match a defunct daemon)
if docker version >/dev/null 2>&1; then
    exit 0
fi
rm -f /var/run/docker.sock

dockerd >/var/log/dockerd.log 2>&1 &

for _ in $(seq 1 75); do
    [ -S /var/run/docker.sock ] && break
    sleep 0.2
done
if [ ! -S /var/run/docker.sock ]; then
    echo "dockerd failed to start:" >&2
    tail -5 /var/log/dockerd.log >&2
    exit 1
fi

chgrp docker /var/run/docker.sock
chmod g+rw /var/run/docker.sock
echo "dockerd running (docker-in-sandbox)"
