# agent-sandbox-base
#
# Base image for safe agent development:
#   - Node.js 24 (NodeSource)
#   - Azul Zulu JDK 21 + Maven + Gradle
#   - Playwright with Chromium (headless by default)
#   - Xvfb + x11vnc + noVNC + openbox for headed browser mode (port 6080)
#
# Works with Docker and Apple `container` (both consume OCI images).

FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG ZULU_MAJOR=21
ARG GRADLE_VERSION=8.14

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- Common tooling -----------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git openssh-client \
        build-essential python3 python3-pip \
        jq ripgrep unzip zip less vim nano procps sudo locales iproute2 \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js (NodeSource) -----------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Azul Zulu JDK + Maven ----------------------------------------------------
RUN curl -fsSL https://repos.azul.com/azul-repo.key \
        | gpg --dearmor -o /usr/share/keyrings/azul.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/azul.gpg] https://repos.azul.com/zulu/deb stable main" \
        > /etc/apt/sources.list.d/zulu.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends zulu${ZULU_MAJOR}-jdk maven \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/zulu${ZULU_MAJOR}

# --- Gradle (manual install; apt version is ancient) ---------------------------
RUN curl -fsSL -o /tmp/gradle.zip \
        https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# --- GUI stack for headed browser mode -----------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc novnc websockify openbox x11-utils \
        xclip bubblewrap inotify-tools \
    && rm -rf /var/lib/apt/lists/*

# --- OpenSSL 1.1 compat ---------------------------------------------------------
# Ubuntu 24.04 ships OpenSSL 3 only, but common prebuilt binaries still link
# against libssl1.1/libcrypto.so.1.1 (e.g. older mongod pulled in by
# mongodb-memory-server: "Instance failed to start because a library is
# missing"). Install the last focal build from the Ubuntu archive.
RUN set -e; arch="$(dpkg --print-architecture)"; \
    repo="http://ports.ubuntu.com/pool/main/o/openssl/"; \
    [ "$arch" = "amd64" ] && repo="http://security.ubuntu.com/ubuntu/pool/main/o/openssl/"; \
    deb="$(curl -fsSL "$repo" | grep -o "libssl1\.1_1\.1\.1f-1ubuntu2\.[0-9]*_${arch}\.deb" | sort -V | tail -1)"; \
    curl -fsSL -o /tmp/libssl1.1.deb "$repo$deb"; \
    dpkg -i /tmp/libssl1.1.deb; \
    rm /tmp/libssl1.1.deb

# --- Docker (docker-in-sandbox: agents can build and run containers) -----------
RUN apt-get update && apt-get install -y --no-install-recommends \
        docker.io docker-buildx docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/*

# --- sshd (for Claude Desktop "Add SSH connection" / remote IDE access) --------
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    # container-generated host keys are replaced by persisted ones at runtime
    && rm -f /etc/ssh/ssh_host_*
COPY rootfs/sshd-sandbox.conf /etc/ssh/sshd_config.d/sandbox.conf
COPY rootfs/profile.d-sandbox.sh /etc/profile.d/sandbox.sh

# --- Non-root user --------------------------------------------------------------
# Ubuntu 24.04 ships user "ubuntu" with uid 1000 — remove it and create "agent".
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash agent \
    && usermod -aG docker agent \
    && mkdir -p /workspace && chown agent:agent /workspace \
    # Shell history persists across restarts (~/.config is a per-sandbox
    # mount). .bashrc covers interactive non-login shells (vivary shell,
    # exec) that skip /etc/profile.d.
    && printf '\nexport HISTFILE="$HOME/.config/bash_history"\nexport HISTSIZE=10000\nexport HISTFILESIZE=20000\nshopt -s histappend\n' \
        >> /home/agent/.bashrc

# --- Playwright + Chromium (shared browser cache, usable by user agent) --------
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
# Owned by agent so projects can `npx playwright install` additional browser
# builds (their playwright version may differ from the baked one).
RUN npm install -g playwright \
    && playwright install --with-deps chromium \
    && chown -R agent:agent /opt/pw-browsers

COPY rootfs/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY rootfs/start-gui.sh /usr/local/bin/start-gui
COPY rootfs/fix-net.sh /usr/local/bin/fix-net
COPY rootfs/start-sshd.sh /usr/local/bin/start-sshd
COPY rootfs/start-dockerd.sh /usr/local/bin/start-dockerd
COPY rootfs/bind-modules.sh /usr/local/bin/bind-modules
COPY rootfs/modules-watch.sh /usr/local/bin/modules-watch
COPY rootfs/host-open.sh /usr/local/bin/host-open
COPY rootfs/host-clip.sh /usr/local/bin/host-clip
COPY rootfs/clipboard-sync.sh /usr/local/bin/clipboard-sync
RUN chmod +x /usr/local/bin/host-open /usr/local/bin/host-clip /usr/local/bin/clipboard-sync \
    # open URLs in the host browser / files in the host editor (sbx broker)
    && ln -s /usr/local/bin/host-open /usr/local/bin/xdg-open \
    && ln -s /usr/local/bin/host-open /usr/local/bin/open \
    && ln -s /usr/local/bin/host-open /usr/local/bin/code \
    # clipboard bridge (Claude Code reads Ctrl+V images via xclip on Linux)
    && ln -s /usr/local/bin/host-clip /usr/local/bin/xclip \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/xsel \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/pbcopy \
    && ln -s /usr/local/bin/host-clip /usr/local/bin/pbpaste
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-gui \
        /usr/local/bin/fix-net /usr/local/bin/start-sshd /usr/local/bin/start-dockerd \
        /usr/local/bin/bind-modules /usr/local/bin/modules-watch \
    # Allow the entrypoint (user agent) to run these root helpers — nothing else.
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/fix-net, /usr/local/bin/start-sshd, /usr/local/bin/start-dockerd, /usr/local/bin/bind-modules" \
        > /etc/sudoers.d/agent-helpers \
    && rm -f /etc/sudoers.d/agent-fix-net

USER agent
WORKDIR /workspace

# DISPLAY is only meaningful once the GUI stack is running (HEADED=1 or start-gui)
ENV DISPLAY=:99 \
    BROWSER=/usr/local/bin/xdg-open \
    HISTFILE=/home/agent/.config/bash_history \
    HISTSIZE=10000

EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
