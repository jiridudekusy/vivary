# Clipboard bridge (Claude Code reads Ctrl+V images via xclip on Linux;
# Codex reads the X11 selection directly — served by clipboard-sync).
RUN apt-get update && apt-get install -y --no-install-recommends xclip \
    && rm -rf /var/lib/apt/lists/*
COPY plugins/clipboard/rootfs/host-clip.sh /usr/local/bin/host-clip
COPY plugins/clipboard/rootfs/clipboard-sync.sh /usr/local/bin/clipboard-sync
RUN chmod +x /usr/local/bin/host-clip /usr/local/bin/clipboard-sync \
    # PATH-first shims; the real /usr/bin/xclip stays for clipboard-sync
    && ln -s /usr/local/bin/host-clip /usr/local/bin/xclip \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/xsel \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/pbcopy \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/pbpaste
