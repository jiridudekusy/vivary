# Cursor CLI agent (third supported agent), official installer as the agent
# user — installs a versioned dist under ~/.local/share/cursor-agent and
# symlinks ~/.local/bin/cursor-agent (already on PATH via the agent-claude
# fragment). ~/.cursor is left alone: it is the per-sandbox state mount.
USER agent
RUN curl -fsSL https://cursor.com/install | bash
USER root
