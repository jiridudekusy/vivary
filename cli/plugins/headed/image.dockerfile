# VNC stack for the headed browser mode (Xvfb + x11-utils live in core).
RUN apt-get update && apt-get install -y --no-install-recommends \
        x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*
COPY plugins/headed/rootfs/start-gui.sh /usr/local/bin/start-gui
RUN chmod +x /usr/local/bin/start-gui
EXPOSE 6080
