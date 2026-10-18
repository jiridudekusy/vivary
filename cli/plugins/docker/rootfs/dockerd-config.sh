#!/usr/bin/env bash
# Apply the daemon.json vivary resolved for this sandbox (the `dockerd` key of
# .vivary.json / profiles / defaults), read from stdin, to the inner dockerd.
# Run as root by the HOST (`<runtime> exec --user root`) after every start, so
# a change needs no --recreate.
#
# Keys dockerd re-reads on SIGHUP (insecure-registries, registry-mirrors, ...)
# are applied live; any other change restarts dockerd, which stops the
# containers running inside unless live-restore is on — said so loudly.
# Serialised with start-dockerd (same lock): the boot hook may still be bringing
# dockerd up when the host calls this.
set -euo pipefail

CONF=/etc/docker/daemon.json
LOCK=/run/vivary-dockerd.lock
# https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior
RELOADABLE='["debug","labels","live-restore","max-concurrent-downloads","max-concurrent-uploads",
  "max-download-attempts","default-runtime","runtimes","authorization-plugins",
  "insecure-registries","registry-mirrors","shutdown-timeout"]'

fail() { echo "dockerd-config: $*" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
jq -S . > "$tmp/new.json" 2>/dev/null || fail "stdin is not valid JSON"
[ "$(jq -r type "$tmp/new.json")" = object ] || fail "daemon.json must be a JSON object"

exec 9>"$LOCK"
flock 9

if [ -s "$CONF" ]; then
    jq -S . "$CONF" > "$tmp/old.json" 2>/dev/null || echo '{}' > "$tmp/old.json"
else
    echo '{}' > "$tmp/old.json"
fi
if cmp -s "$tmp/old.json" "$tmp/new.json"; then
    echo "unchanged"
    exit 0
fi

dockerd --validate --config-file "$tmp/new.json" > "$tmp/validate.log" 2>&1 \
    || fail "dockerd rejects it: $(tr '\n' ' ' < "$tmp/validate.log")"

changed="$(jq -r -n --slurpfile a "$tmp/old.json" --slurpfile b "$tmp/new.json" \
    '[($a[0] + $b[0]) | keys[] | select($a[0][.] != $b[0][.])] | join(",")')"
needs_restart="$(jq -r -n --slurpfile a "$tmp/old.json" --slurpfile b "$tmp/new.json" \
    --argjson ok "$RELOADABLE" \
    '[($a[0] + $b[0]) | keys[] | select($a[0][.] != $b[0][.]) | select(. as $k | $ok | index($k) | not)] | join(",")')"

mkdir -p /etc/docker
cp "$tmp/new.json" "$CONF"
chmod 0644 "$CONF"

pid="$(cat /var/run/docker.pid 2>/dev/null || true)"
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null || ! docker version >/dev/null 2>&1; then
    # Not running (yet): start-dockerd reads the new file when it starts it.
    echo "written ($changed); dockerd picks it up when it starts"
    exit 0
fi

if [ -z "$needs_restart" ]; then
    kill -HUP "$pid"
    echo "reloaded live ($changed)"
    exit 0
fi

running="$(docker ps -q | wc -l)"
kill -TERM "$pid"
for _ in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
done
kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
# setsid -w: dockerd must outlive this exec session (Apple `container` ends the
# session's processes with it).
VIVARY_DOCKERD_LOCKED=1 setsid -w /usr/local/bin/start-dockerd >/dev/null \
    || fail "dockerd did not come back with the new settings — see /var/log/dockerd.log"
msg="restarted dockerd ($needs_restart cannot be reloaded live)"
[ "$running" -gt 0 ] && msg="$msg — $running running container(s) inside were stopped"
echo "$msg"
