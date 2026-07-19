#!/usr/bin/env bash
# Claude Code integration: host chat-history symlink, Desktop remote-daemon
# socket workaround, first-run login hint.
set -u

# Chat history sharing: the host's project dirs are mounted at
# ~/host-projects (non-nested — works in Docker and Apple `container`).
# Link it into place so sessions land directly in the host's history.
if [ -d "${HOME}/host-projects" ]; then
    if [ -d "${HOME}/.claude/projects" ] && [ ! -L "${HOME}/.claude/projects" ]; then
        if [ -z "$(ls -A "${HOME}/.claude/projects")" ]; then
            rmdir "${HOME}/.claude/projects"
        else
            echo "WARNING: ~/.claude/projects exists and is not empty; leaving it as-is." >&2
            echo "         Sessions will NOT be visible on the host." >&2
        fi
    fi
    if [ ! -e "${HOME}/.claude/projects" ]; then
        ln -sfn "${HOME}/host-projects" "${HOME}/.claude/projects"
    fi
fi

# Claude Desktop's remote daemon chmods its rpc.sock — that fails with EINVAL
# on the virtiofs-mounted ~/.claude and kills the daemon. Keep runtime
# sockets on the VM-local filesystem instead (nothing persistent lives there).
if [ -d "${HOME}/.claude" ]; then
    mkdir -p /tmp/claude-remote-run
    if [ -d "${HOME}/.claude/remote/run" ] && [ ! -L "${HOME}/.claude/remote/run" ]; then
        rm -rf "${HOME}/.claude/remote/run"
    fi
    mkdir -p "${HOME}/.claude/remote"
    ln -sfn /tmp/claude-remote-run "${HOME}/.claude/remote/run"
fi

if [[ "${VIVARY_CMD:-}" == claude* ]] && [ ! -f "${HOME}/.claude/.credentials.json" ]; then
    cat <<'BANNER'
--------------------------------------------------------------------------
 First run: no Claude credentials found in this sandbox.

 Claude Code will prompt you to log in. Open the OAuth URL it prints in a
 browser on your HOST machine and paste the code back here.

 Credentials are stored in the mounted sandbox directory, so you only need
 to do this once per sandbox — they survive container rebuilds.
--------------------------------------------------------------------------
BANNER
fi
exit 0
