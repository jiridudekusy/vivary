# Claude Code (native installer, user agent) + status line renderer.
# Cache key only (see agent-codex): an unpinned global install sits in a cached
# layer forever, so the resolved version busts the layer while the install
# itself still takes @latest.
ARG CCSTATUSLINE_VERSION=latest
RUN echo "ccstatusline cache key: ${CCSTATUSLINE_VERSION}" > /dev/null \
    && npm install -g ccstatusline@latest
USER agent
# The install layer is cached, so `curl install.sh | bash` alone would keep
# whatever version happened to be current when the layer was first built (this
# image sat on an old Claude Code until an unrelated fragment above it changed).
# The plugin resolves the current version on the HOST and passes it in purely as
# a CACHE KEY: the layer busts exactly when a new Claude Code ships, and the
# installer is still told `latest` so the image gets the newest build.
ARG CLAUDE_CODE_VERSION=latest
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- latest
USER root
ENV PATH="/home/agent/.local/bin:${PATH}"
