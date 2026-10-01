# Cursor CLI agent (third supported agent), official installer as the agent
# user — installs a versioned dist under ~/.local/share/cursor-agent and
# symlinks ~/.local/bin/cursor-agent (already on PATH via the agent-claude
# fragment). ~/.cursor is left alone: it is the per-sandbox state mount.
# CURSOR_AGENT_VERSION is a pure CACHE KEY: the installer takes no version
# argument, so the arg is only referenced to bust this layer when a new
# cursor-agent ships. The plugin reads the version out of the install script
# itself (it carries a pinned downloads.cursor.com/lab/<version>/ URL).
USER agent
ARG CURSOR_AGENT_VERSION=latest
RUN echo "cursor-agent ${CURSOR_AGENT_VERSION}" > /dev/null \
    && curl -fsSL https://cursor.com/install | bash
USER root
