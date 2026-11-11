# GUI for the headed browser mode (Xvfb + x11-utils live in core): a window
# manager and a VNC server bound to the sandbox's loopback. No noVNC and no
# websockify any more: the viewer is served by `vivary web` on the Mac, and
# VNC leaves the sandbox only through vnc-relay over the runtime's exec channel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        x11vnc openbox \
    && rm -rf /var/lib/apt/lists/*
COPY plugins/headed/rootfs/start-gui.sh /usr/local/bin/start-gui
COPY plugins/headed/rootfs/vnc-relay.py /usr/local/bin/vnc-relay
RUN chmod +x /usr/local/bin/start-gui /usr/local/bin/vnc-relay
