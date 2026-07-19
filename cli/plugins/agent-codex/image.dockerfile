# OpenAI Codex CLI (second supported agent). bubblewrap backs its own sandboxing.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex
