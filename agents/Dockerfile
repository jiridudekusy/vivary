# agent-sandbox-agents
#
# Claude Code on top of agent-sandbox-base.
#
# At runtime the sandbox script mounts:
#   ~/claude-sandboxes/<name>/dot-claude  -> /home/agent/.claude   (per-sandbox state)
#   ~/.claude/projects                    -> /home/agent/.claude/projects (host chat history)
#   ~/claude-sandboxes/<name>/claude.json -> /home/agent/.claude.json    (MCP config, CLI state)
#   <workspace>                           -> same absolute path as on the host

FROM agent-sandbox-base

USER agent

# Native installer: binary in ~/.local/bin, versions in ~/.local/share/claude —
# both live outside the mounted ~/.claude, so they are baked into the image.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Status line renderer used by the host's settings.json (statusLine.command);
# its visual config is imported per-sandbox into ~/.config/ccstatusline.
# Codex CLI is the second supported agent (`sodex` launcher); its auth state
# persists in the mounted ~/.codex.
USER root
RUN npm install -g ccstatusline @openai/codex
USER agent

ENV PATH="/home/agent/.local/bin:${PATH}"

COPY --chown=root:root rootfs/agents-entrypoint.sh /usr/local/bin/agents-entrypoint.sh
USER root
RUN chmod +x /usr/local/bin/agents-entrypoint.sh
USER agent

ENTRYPOINT ["/usr/local/bin/agents-entrypoint.sh"]
CMD ["claude"]
