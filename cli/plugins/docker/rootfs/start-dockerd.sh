#!/usr/bin/env bash
# Start dockerd for docker-in-sandbox. Runs as root (via the sudoers entry
# for user agent, see Dockerfile). Idempotent.
#
# Storage backing: under the docker runtime /var/lib/docker is a named volume
# (overlay2 can't sit on overlayfs); under Apple `container` the VM rootfs is
# ext4 which overlay2 handles directly.
set -euo pipefail

# cgroup v2 delegation — REQUIRED for systemd-in-container (kind nodes, any
# systemd image). The kernel forbids enabling domain controllers in a cgroup
# that still holds processes ("no internal processes"), and our own tini +
# entrypoint daemons sit in the sandbox's cgroup root. runc then silently falls
# back to a THREADED subtree, which poisons the root to "domain threaded" — and
# a threaded subtree cannot hold normal cgroups, so systemd inside the node
# container dies with:
#   Failed to create /init.scope control group: Structure needs cleaning
# and kind aborts with 'could not find a log line that matches "Reached target
# Multi-User System"'. Threaded mode also loses the domain-only controllers
# (memory, io), so docker cannot apply memory limits either.
#
# The fix is what systemd does on any normal host: park our processes in a leaf
# cgroup and delegate the controllers. Later ssh/exec sessions inherit /init
# from their parent, so the root stays empty by itself.
prepare_cgroups() {
    local root=/sys/fs/cgroup
    [ "$(stat -fc %T "$root" 2>/dev/null)" = cgroup2fs ] || return 0
    [ -w "$root/cgroup.subtree_control" ] || return 0

    local available
    available="$(cat "$root/cgroup.controllers" 2>/dev/null)" || return 0
    [ -n "$available" ] || return 0

    # Already delegated (idempotent — the hook runs on every start).
    local current
    current="$(cat "$root/cgroup.subtree_control")"
    [ "$current" = "$available" ] && return 0

    mkdir -p "$root/init"
    # Moving a process rewrites cgroup.procs under us, so sweep until empty.
    local left=1
    for _ in 1 2 3 4 5; do
        while read -r pid; do
            echo "$pid" > "$root/init/cgroup.procs" 2>/dev/null || true
        done < "$root/cgroup.procs"
        left="$(wc -l < "$root/cgroup.procs")"
        [ "$left" -eq 0 ] && break
    done
    if [ "$left" -ne 0 ]; then
        echo "WARNING: $left process(es) left in the cgroup root — controller delegation" \
             "will fail, so systemd-in-container (kind) will not work" >&2
        return 0
    fi

    local want=""
    for c in $available; do want="$want +$c"; done
    if ! echo "${want# }" > "$root/cgroup.subtree_control" 2>/dev/null; then
        echo "WARNING: could not delegate cgroup controllers (${want# }) —" \
             "systemd-in-container (kind) will not work" >&2
        return 0
    fi
    echo "cgroup v2 controllers delegated:${want}"
}

prepare_cgroups

# Serialised with dockerd-config, which the host runs right after a start —
# while this boot hook may still be bringing dockerd up. dockerd-config holds
# the lock itself when it restarts dockerd through here.
if [ -z "${VIVARY_DOCKERD_LOCKED:-}" ]; then
    exec 9>/run/vivary-dockerd.lock
    flock 9
fi

# Already healthy? (a plain pgrep would match a defunct daemon)
if docker version >/dev/null 2>&1; then
    exit 0
fi
rm -f /var/run/docker.sock

# Stale pid files. /run lives on the kept container's rootfs, so they survive a
# restart, and after it the PID inside belongs to someone else (PID 78 was the
# clipboard hook's bash) -> dockerd refuses to start: "failed to start
# containerd: ... process with PID 78 is still running". Drop a file whose PID
# is not the daemon it names.
clear_stale_pid() {
    local pid
    pid="$(cat "$1" 2>/dev/null)" || return 0
    [ "$(cat "/proc/${pid}/comm" 2>/dev/null)" = "$2" ] || rm -f "$1"
}
clear_stale_pid /var/run/docker.pid dockerd
clear_stale_pid /var/run/docker/containerd/containerd.pid containerd

# 9>&-: dockerd must not inherit the lock, or it would hold it for its lifetime.
dockerd >/var/log/dockerd.log 2>&1 9>&- &

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
