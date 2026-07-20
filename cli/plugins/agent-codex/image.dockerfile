# OpenAI Codex CLI (second supported agent). bubblewrap backs its own sandboxing.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex

# Root helper: chown the app-server-control tmpfs to the agent user at boot.
COPY plugins/agent-codex/rootfs/fix-codex-ctl.sh /usr/local/bin/fix-codex-ctl
RUN chmod +x /usr/local/bin/fix-codex-ctl \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/fix-codex-ctl" > /etc/sudoers.d/agent-codex
