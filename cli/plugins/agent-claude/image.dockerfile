# Claude Code (native installer, user agent) + status line renderer.
RUN npm install -g ccstatusline
USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
ENV PATH="/home/agent/.local/bin:${PATH}"
