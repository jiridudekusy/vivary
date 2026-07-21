# Egress control (sandbox side): root helper baked in, gated at runtime on
# SANDBOX_EGRESS=1 (set by the --egress flag; the agent cannot forge PID 1's
# env). No extra packages — iptables, curl and update-ca-certificates are
# already in the core image.
COPY plugins/egress/rootfs/egress-setup.sh /usr/local/bin/egress-setup
RUN chmod +x /usr/local/bin/egress-setup \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/egress-setup" > /etc/sudoers.d/agent-egress
