# Root helper for the --sudo flag: grants the agent full passwordless sudo,
# gated on the runtime-set SANDBOX_SUDO=1 in PID 1's environment.
COPY plugins/sudo/rootfs/enable-sudo.sh /usr/local/bin/enable-sudo
RUN chmod +x /usr/local/bin/enable-sudo \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/enable-sudo" > /etc/sudoers.d/agent-sudo
