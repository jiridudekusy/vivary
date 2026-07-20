#!/usr/bin/env bash
# Codex integration: app-server control-socket workaround.
#
# The Codex app-server (used by the ChatGPT phone app / IDEs connecting over
# SSH) binds a unix control socket in ~/.codex/app-server-control and chmods
# it — chmod on a socket fails with EINVAL on the virtiofs-mounted ~/.codex
# and kills the app-server ("Starting Codex failed" on the client). Keep the
# control dir on the VM-local filesystem; nothing persistent lives there
# (startup lock, log, socket).
set -u

if [ -d "${HOME}/.codex" ]; then
    mkdir -p /tmp/codex-app-server-control
    if [ -e "${HOME}/.codex/app-server-control" ] && [ ! -L "${HOME}/.codex/app-server-control" ]; then
        rm -rf "${HOME}/.codex/app-server-control"
    fi
    ln -sfn /tmp/codex-app-server-control "${HOME}/.codex/app-server-control"
fi
exit 0
