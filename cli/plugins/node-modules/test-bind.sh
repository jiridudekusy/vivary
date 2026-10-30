#!/usr/bin/env bash
# Integration test for rootfs/bind-modules.sh with the store VOLUME — runs
# INSIDE a throwaway container from the sandbox image, against a synthetic
# workspace; never against a real sandbox. It goes through the image's own
# entrypoint as agent with SANDBOX_SUDO=1, exactly like a sandbox: bind-modules
# reads the workspace from PID 1's environment AS AGENT, so a root PID 1 makes
# it refuse (by design).
# From the repo root (prepares the share, runs, cleans up):
#
#   S=$(mktemp -d); V=vivary-bindtest
#   mkdir -p "$S/share/a/pkg/bin"; echo x > "$S/share/a/pkg/index.js"
#   echo '#!/bin/sh' > "$S/share/a/pkg/bin/tool"; chmod 755 "$S/share/a/pkg/bin/tool"
#   echo x > "$S/share/a/evil"; chmod 4755 "$S/share/a/evil"
#   ln -s /etc/shadow "$S/share/a/link"
#   printf 'a\t/tmp/ws/a/node_modules\nb\t/tmp/ws/b/node_modules\n' > "$S/share/.manifest"
#   container volume create -s 2G $V
#   container run --rm --cap-add ALL --memory 1g -e SANDBOX_SUDO=1 -e SANDBOX_WORKSPACE=/tmp/ws \
#     -v "$S/share:/vivary-modules" -v $V:/vivary-modules-store \
#     -v "$PWD/cli/plugins/node-modules:/s" docker.io/library/agent-sandbox-agents:latest \
#     bash /s/test-bind.sh
#   container volume rm $V; rm -rf "$S"
set -u
ST=/vivary-modules-store WS=/tmp/ws
mkdir -p $WS/a $WS/b; touch $WS/a/package.json $WS/b/package.json
ok() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fi; }

sudo bash /s/rootfs/bind-modules.sh 2> /tmp/bind.err
BOOT=$(cat /proc/sys/kernel/random/boot_id)
ok "store volume detected: a/node_modules is a bind of the volume" 'mountpoint -q $WS/a/node_modules && [ -e $ST/a ]'
ok "legacy modules migrated off the share"        '[ -f $WS/a/node_modules/pkg/index.js ]'
ok "migration said so on stderr"                   'grep -q "moving a/node_modules off the Mac" /tmp/bind.err'
ok "migrated tree belongs to agent"               '[ "$(stat -c %U $ST/a $ST/a/pkg/index.js | sort -u)" = agent ]'
ok "setuid bit stripped in the copy"              '[ ! -u $ST/a/evil ]'
ok "exec bit kept"                                '[ -x $ST/a/pkg/bin/tool ]'
ok "symlink copied as a link, not followed"       '[ -L $ST/a/link ] && [ "$(readlink $ST/a/link)" = /etc/shadow ]'
ok "no leftover temp dir"                         '! ls -d $ST/.migrating-* 2>/dev/null | grep -q .'
ok "fresh slug: empty, agent-owned, bound"        '[ -z "$(ls -A $ST/b)" ] && [ "$(stat -c %U $ST/b)" = agent ] && mountpoint -q $WS/b/node_modules'
ok "agent can install into it"                    'touch $WS/b/node_modules/installed'
ok "installs land on the volume, not the share"   '[ -e $ST/b/installed ] && [ ! -e /vivary-modules/b/installed ]'
ok "ready marker = this boot"                     '[ "$(cat /run/vivary-modules.ready)" = "$BOOT" ]'
ok "fstrim scheduled once for this boot"          '[ "$(cat /run/vivary-modules.trimmed)" = "$BOOT" ]'

sudo rm -f /vivary-modules/a/pkg/index.js   # if it re-migrated, the store copy would vanish
sudo bash /s/rootfs/bind-modules.sh 2> /tmp/bind2.err
ok "re-run is idempotent: no second migration"    '[ -f $ST/a/pkg/index.js ] && ! grep -q moving /tmp/bind2.err'
ok "ran as agent with PID 1 as agent (like a sandbox)" '[ "$(id -un)" = agent ] && [ "$(stat -c %U /proc/1)" = agent ]'
echo "--- bind-modules stderr ---"; cat /tmp/bind.err
