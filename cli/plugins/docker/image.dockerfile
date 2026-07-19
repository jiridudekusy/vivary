# Docker-in-sandbox: agents can build and run containers inside.
RUN apt-get update && apt-get install -y --no-install-recommends \
        docker.io docker-buildx docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -aG docker agent
COPY plugins/docker/rootfs/start-dockerd.sh /usr/local/bin/start-dockerd
RUN chmod +x /usr/local/bin/start-dockerd \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/start-dockerd" > /etc/sudoers.d/agent-docker
