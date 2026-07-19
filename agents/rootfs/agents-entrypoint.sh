#!/usr/bin/env bash
# Claude entrypoint: GUI stack (via base entrypoint logic), then a first-run
# login hint if credentials are missing, then exec the command (default: claude).
set -euo pipefail

# Network workarounds for Apple `container` VMs (see fix-net): AAAA DNS fix
# + host.docker.internal mapping. Opt out: SKIP_NET_FIX=1
if [ "${SKIP_NET_FIX:-0}" != "1" ]; then
    sudo /usr/local/bin/fix-net || true
fi

if [ "${HEADED:-0}" = "1" ]; then
    start-gui
fi

# SSH access (Claude Desktop "Add SSH connection"). Opt in: SANDBOX_SSH=1
if [ "${SANDBOX_SSH:-0}" = "1" ]; then
    sudo /usr/local/bin/start-sshd || echo "WARNING: sshd failed to start" >&2
fi

# Docker-in-sandbox. Opt in: SANDBOX_DOCKER=1
if [ "${SANDBOX_DOCKER:-0}" = "1" ]; then
    sudo /usr/local/bin/start-dockerd || echo "WARNING: dockerd failed to start" >&2
fi

# Host-open: persist broker env for SSH sessions (they don't inherit it)
if [ -n "${SBX_OPEN_URL:-}" ]; then
    printf 'SBX_OPEN_URL=%s\nSBX_OPEN_TOKEN=%s\nSBX_SANDBOX_NAME=%s\n' \
        "$SBX_OPEN_URL" "${SBX_OPEN_TOKEN:-}" "${SBX_SANDBOX_NAME:-}" \
        > "$HOME/.sandbox-open.env"
    chmod 600 "$HOME/.sandbox-open.env"
fi

# node_modules overlays (Apple container path): bind container-side dirs over
# workspace node_modules, then watch for new package.json files live.
if [ "${SANDBOX_MODULES:-0}" = "1" ] && [ -d /vivary-modules ]; then
    sudo /usr/local/bin/bind-modules \
        || echo "WARNING: node_modules overlays incomplete (see above)" >&2
    pgrep -f "bin/modules-watch" >/dev/null 2>&1 \
        || modules-watch >"$HOME/.modules-watch.log" 2>&1 &
fi

# X-native apps (Codex/arboard) read the clipboard from the X server, not via
# xclip — run a bare Xvfb plus the host->X clipboard sync when enabled.
if [ "${SANDBOX_CLIPBOARD:-0}" = "1" ]; then
    pgrep -f "Xvfb ${DISPLAY:-:99}" >/dev/null 2>&1 \
        || Xvfb "${DISPLAY:-:99}" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
    pgrep -f "bin/clipboard-sync" >/dev/null 2>&1 \
        || clipboard-sync >"$HOME/.clipboard-sync.log" 2>&1 &
fi

# Claude Desktop's remote daemon chmods its rpc.sock — that fails with EINVAL
# on the virtiofs-mounted ~/.claude and kills the daemon. Keep runtime
# sockets on the VM-local filesystem instead (nothing persistent lives there).
mkdir -p /tmp/claude-remote-run
if [ -d "${HOME}/.claude/remote/run" ] && [ ! -L "${HOME}/.claude/remote/run" ]; then
    rm -rf "${HOME}/.claude/remote/run"
fi
mkdir -p "${HOME}/.claude/remote"
ln -sfn /tmp/claude-remote-run "${HOME}/.claude/remote/run"

# Chat history sharing: the host's ~/.claude/projects is mounted at
# ~/host-projects (non-nested mount — works in Docker and Apple `container`).
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

if [[ "${1:-}" == claude* ]] && [ ! -f "${HOME}/.claude/.credentials.json" ]; then
    cat <<'EOF'
--------------------------------------------------------------------------
 First run: no Claude credentials found in this sandbox.

 Claude Code will prompt you to log in. Open the OAuth URL it prints in a
 browser on your HOST machine and paste the code back here.

 Credentials are stored in the mounted sandbox directory, so you only need
 to do this once per sandbox — they survive container rebuilds.
--------------------------------------------------------------------------
EOF
fi

exec "$@"
