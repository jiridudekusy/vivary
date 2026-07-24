# node_modules overlays: in-VM binds (manifest-driven) + live package.json watcher.
RUN apt-get update && apt-get install -y --no-install-recommends inotify-tools \
    && rm -rf /var/lib/apt/lists/*
COPY plugins/node-modules/rootfs/bind-modules.sh /usr/local/bin/bind-modules
COPY plugins/node-modules/rootfs/modules-watch.sh /usr/local/bin/modules-watch
RUN chmod +x /usr/local/bin/bind-modules /usr/local/bin/modules-watch \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/bind-modules" > /etc/sudoers.d/agent-modules
