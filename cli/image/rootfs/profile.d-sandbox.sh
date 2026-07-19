# Sandbox environment for interactive (login) shells — SSH sessions don't
# inherit the container's ENV, which only applies to the main process.
export CLAUDE_CONFIG_DIR=/home/agent/.claude
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
export DISPLAY=:99
# Shell history persists across container restarts (~/.config is a
# per-sandbox mount).
export HISTFILE="$HOME/.config/bash_history"
export HISTSIZE=10000
export HISTFILESIZE=20000
[ -n "${BASH_VERSION:-}" ] && shopt -s histappend 2>/dev/null
case ":$PATH:" in
    *:"$HOME/.local/bin":*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
