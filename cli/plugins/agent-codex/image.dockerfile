# OpenAI Codex CLI (second supported agent). bubblewrap backs its own sandboxing.
# CODEX_VERSION is a pure CACHE KEY, not a pin: the host resolves the current
# version and passing it in busts this layer exactly when a new codex ships.
# The install itself takes @latest, so the image always gets the newest build
# — pinning to the resolved version would freeze the image one release behind
# whenever a release lands mid-build.
ARG CODEX_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && echo "codex cache key: ${CODEX_VERSION}" > /dev/null \
    && npm install -g @openai/codex@latest

# Root helper: chown the app-server-control tmpfs to the agent user at boot.
COPY plugins/agent-codex/rootfs/fix-codex-ctl.sh /usr/local/bin/fix-codex-ctl
RUN chmod +x /usr/local/bin/fix-codex-ctl \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/fix-codex-ctl" > /etc/sudoers.d/agent-codex
