# Tailnet name injection helper (MagicDNS names -> /etc/hosts).
COPY plugins/tailscale/rootfs/apply-ts-hosts.sh /usr/local/bin/apply-ts-hosts
RUN chmod +x /usr/local/bin/apply-ts-hosts \
    && echo "agent ALL=(root) NOPASSWD: /usr/local/bin/apply-ts-hosts" > /etc/sudoers.d/agent-tailscale
