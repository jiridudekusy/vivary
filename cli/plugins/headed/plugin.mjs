// headed: GUI stack (Xvfb + x11vnc + noVNC) so the user can watch and drive
// the agent's browser from the host.
import { containerDnsDomain } from '../../core/runtime.mjs';

function novnc(cfg, cname) {
  const domain = cfg.runtime === 'container' ? containerDnsDomain() : '';
  if (domain) {
    // Directly reachable via local DNS — no port publish needed, so
    // multiple headed sandboxes can coexist.
    return { publish: [], url: `http://${cname}.${domain}:6080/vnc.html` };
  }
  const port = process.env.NOVNC_PORT || '6080';
  return { publish: ['-p', `${port}:6080`], url: `http://localhost:${port}/vnc.html` };
}

export default {
  name: 'headed',
  order: 20,
  flags: {
    headed: {
      type: 'boolean',
      help: 'Enable the GUI stack; browser visible via noVNC (per invocation)',
    },
  },
  runArgs(ctx) {
    if (!ctx.flags.headed) return [];
    const { publish, url } = novnc(ctx.cfg, ctx.cname);
    ctx.log(`==> Headed mode: browser will be visible at ${url}`);
    return ['-e', 'HEADED=1', ...publish];
  },
};
