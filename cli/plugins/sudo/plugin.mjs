// sudo: full passwordless sudo for the agent user inside the sandbox.
// Opt-in and sticky. The enable-sudo helper is baked into every image, so
// it gates on the runtime-set SANDBOX_SUDO=1 in PID 1's environment — which
// the agent cannot forge — and a sandbox created without the flag cannot
// self-escalate through it (no flag -> no feature).
export default {
  name: 'sudo',
  order: 16,
  flags: {
    sudo: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'sudo',
      help: 'Full passwordless sudo for the agent inside the sandbox\n(sticky). Also grants full capabilities on the Apple\nruntime (the sandbox is its own VM). Host isolation is\nunchanged.',
    },
  },
  needsCaps: (cfg) => !!cfg.sudo,

  runArgs({ cfg }) {
    return cfg.sudo ? ['-e', 'SANDBOX_SUDO=1'] : [];
  },
};
