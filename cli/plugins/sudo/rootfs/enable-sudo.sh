#!/usr/bin/env bash
# Root helper (sudoers entry for user agent): grant the agent user full
# passwordless sudo — the --sudo flag.
#
# Gate on PID 1's environment: SANDBOX_SUDO=1 there was set by the container
# runtime (vivary run args) and cannot be forged by the agent, unlike the
# caller's own environment. Without it this helper is a silent no-op, so the
# always-baked sudoers entry for it is not an escalation path.
#
# The read runs as the agent user: PID 1 shares that uid, so the ptrace-mode
# check passes without CAP_SYS_PTRACE (root lacks it in a caps-less
# container, e.g. the docker runtime) — and the pipeline is spawned by root,
# so the agent cannot tamper with the data.
set -eu

if runuser -u agent -- cat /proc/1/environ | tr '\0' '\n' | grep -qx 'SANDBOX_SUDO=1'; then
    echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent-all
    chmod 440 /etc/sudoers.d/agent-all
fi
