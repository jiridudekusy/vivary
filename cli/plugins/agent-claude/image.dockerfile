# Claude Code (native installer, user agent) + status line renderer.
RUN npm install -g ccstatusline
USER agent
# The install layer is cached, so `curl install.sh | bash` alone would keep
# whatever version happened to be current when the layer was first built (this
# image sat on an old Claude Code until an unrelated fragment above it changed).
# The plugin resolves the version on the HOST and passes it in, so the layer
# busts exactly when a new Claude Code ships — and stays cached otherwise.
ARG CLAUDE_CODE_VERSION=latest
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"
USER root
ENV PATH="/home/agent/.local/bin:${PATH}"
