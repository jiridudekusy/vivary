# sshd for Claude Desktop "Add SSH connection" / remote IDE access.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    # container-generated host keys are replaced by persisted ones at runtime
    && rm -f /etc/ssh/ssh_host_*
COPY plugins/ssh/rootfs/sshd-sandbox.conf /etc/ssh/sshd_config.d/sandbox.conf
COPY plugins/ssh/rootfs/start-sshd.sh /usr/local/bin/start-sshd
RUN chmod +x /usr/local/bin/start-sshd \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/start-sshd" > /etc/sudoers.d/agent-ssh
