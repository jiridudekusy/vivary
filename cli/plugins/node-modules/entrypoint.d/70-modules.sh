#!/usr/bin/env bash
# node_modules overlays (Apple container path): bind container-side dirs over
# workspace node_modules, then watch for new package.json files live.
[ "${SANDBOX_MODULES:-0}" = "1" ] && [ -d /vivary-modules ] || exit 0
sudo /usr/local/bin/bind-modules \
    || echo "WARNING: node_modules overlays incomplete (see above)" >&2
# An explicit dir list (array in .vivary.json) means exactly those dirs — no
# live discovery, so the watcher stays down.
if [ "${SANDBOX_MODULES_WATCH:-1}" = "1" ]; then
    pgrep -f "bin/modules-watch" >/dev/null 2>&1 \
        || modules-watch >"$HOME/.modules-watch.log" 2>&1 &
fi
exit 0
