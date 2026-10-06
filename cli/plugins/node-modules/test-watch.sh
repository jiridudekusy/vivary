#!/usr/bin/env bash
# Integration test for rootfs/modules-watch.sh — runs INSIDE a throwaway
# container from the sandbox image, as root, against a synthetic workspace
# (never a real sandbox: the watcher writes the manifest). From the repo root:
#
#   container run --rm --user root --memory 1g --entrypoint bash \
#     -v "$PWD/cli/plugins/node-modules/rootfs:/t" \
#     -v "$PWD/cli/plugins/node-modules:/s" \
#     docker.io/library/agent-sandbox-agents:latest /s/test-watch.sh
#
# bind-modules ERRORs in the log are expected: PID 1 of a bare container has
# no SANDBOX_WORKSPACE, so the root helper refuses to bind. What is tested is
# what gets watched and what lands in the manifest.
set -u
export SANDBOX_WORKSPACE=/tmp/ws SANDBOX_MODULES_DEPTH=2
WS=/tmp/ws
mkdir -p /vivary-modules $WS/a/node_modules/x/y/z $WS/b/c/d/e $WS/.git/objects/aa
for i in $(seq 40); do mkdir -p $WS/a/node_modules/p$i/lib/sub; done
touch $WS/a/package.json
printf 'a\t%s\n' "$WS/a/node_modules" > /vivary-modules/.manifest
expected=$(find $WS -maxdepth 2 \( -name node_modules -o -name .git -o -name .hg \) -prune -o -type d -print | wc -l)

watches() { local w; w=$(pgrep -x inotifywait | head -1); [ -n "$w" ] || { echo 0; return; }
  for f in /proc/$w/fd/*; do [ "$(readlink $f)" = "anon_inode:inotify" ] && grep -c '^inotify wd:' /proc/$w/fdinfo/${f##*/}; done; }
watched_inodes() { local w; w=$(pgrep -x inotifywait | head -1)
  for f in /proc/$w/fd/*; do [ "$(readlink $f)" = "anon_inode:inotify" ] && grep '^inotify wd:' /proc/$w/fdinfo/${f##*/} | sed -E 's/.* ino:([0-9a-f]+) .*/\1/'; done; }
isw() { watched_inodes | grep -qx "$(printf %x $(stat -c %i "$1"))"; }
ok() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fi; }

bash /t/modules-watch.sh > /tmp/w.log 2>&1 &
MW=$!
sleep 2
ok "initial watches = dirs at depth<=2 outside node_modules/.git ($expected)" '[ "$(watches)" = "$expected" ]'
ok "node_modules not watched"            '! isw $WS/a/node_modules && ! isw $WS/a/node_modules/x'
ok "deeper than DEPTH not watched"       '! isw $WS/b/c/d'
ok ".git not watched"                    '! isw $WS/.git'
ok "initial catch_up added nothing"      '[ "$(wc -l < /vivary-modules/.manifest)" = 1 ]'

touch $WS/b/package.json; sleep 1
ok "package.json in watched dir -> overlay"            'grep -q "^b	" /vivary-modules/.manifest'
mkdir $WS/new && touch $WS/new/package.json; sleep 2
ok "new dir + immediate package.json -> overlay (race)" 'grep -q "^new	" /vivary-modules/.manifest'
ok "new dir got a watch after rebuild"                  'isw $WS/new'
touch $WS/b/c/d/package.json; sleep 1
ok "package.json deeper than DEPTH -> ignored"          '! grep -q "^b-c-d	" /vivary-modules/.manifest'

before=$(watches); for i in $(seq 500); do mkdir -p $WS/a/node_modules/q$i/lib; done; sleep 1
ok "npm-install-like burst in node_modules: no new watches" '[ "$(watches)" = "$before" ]'

for i in $(seq 50); do mkdir $WS/burst$i; done; sleep 3
ok "burst of 50 new dirs: all watched afterwards" '[ "$(watches)" = "$(find $WS -maxdepth 2 \( -name node_modules -o -name .git -o -name .hg \) -prune -o -type d -print | wc -l)" ]'
cpu=$(ps -o pcpu= -p $MW | tr -d ' ')
ok "watcher idle after the burst (cpu ${cpu}%)" '[ "${cpu%.*}" -lt 5 ]'
mkdir $WS/burst7/pkg && touch $WS/burst7/pkg/package.json; sleep 2
ok "package.json two levels into a burst dir -> overlay" 'grep -q "^burst7-pkg	" /vivary-modules/.manifest'

kill $MW; sleep 1
ok "inotifywait gone after the watcher is killed" '! pgrep -x inotifywait >/dev/null'
echo "--- watcher log ---"; grep -v "^overlaid" /tmp/w.log | head -5
