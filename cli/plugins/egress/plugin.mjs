// egress: default-deny outbound with per-request logging and human approval.
// The sandbox attaches ONLY to the shared internal `vivary-egress` net (no
// default net -> no direct route out); its DNS, HTTPS and HTTP are forced
// through ASHP running as a transparent MITM proxy (see ashp.mjs). Approve /
// deny requests in ASHP's policy UI. Inter-sandbox isolation comes from an
// ingress firewall raised inside each sandbox (egress-setup helper): host
// traffic arrives as gateway .1 and is allowed, peer sandboxes are dropped.
import { cmdEgress, ensureAgent, ensureAshp, purgeAgentToken, syncAgentRules, EGRESS_NET } from './ashp.mjs';
import { expandPresets } from './presets.mjs';

export default {
  name: 'egress',
  order: 5,
  flags: {
    egress: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'egress',
      help: 'Egress control (sticky): all outbound traffic goes through\n'
        + 'the shared ASHP transparent proxy — default-deny with\n'
        + 'per-request log and approval UI (vivary egress status).\n'
        + 'The sandbox loses its direct internet route; peers on the\n'
        + 'shared egress net cannot connect to it.',
    },
  },
  // The in-sandbox ingress firewall needs CAP_NET_ADMIN (root); core adds
  // --cap-add ALL on Apple when any enabled plugin declares needsCaps.
  needsCaps: (cfg) => !!cfg.egress,
  commands: { egress: cmdEgress },

  async runArgs({ cfg, log }) {
    if (!cfg.egress) return [];
    const { ip, adminPassword } = await ensureAshp(cfg.runtime);
    const token = await ensureAgent(ip, adminPassword, cfg.name);
    // Approved .vivary.json egress policy (presets + allow) -> ASHP rules.
    // No policy (no file / no egress section) -> sync to empty, which drops
    // stale vivary-managed rules and leaves deny-all + UI approval.
    const policy = cfg.egressPolicy || {};
    const patterns = [...expandPresets(policy.presets), ...(policy.allow || [])];
    await syncAgentRules(ip, adminPassword, cfg.name, patterns);
    log(`==> egress: outbound via ASHP at ${ip} (policy UI: http://${ip}:3000/)`);
    return [
      '--network', EGRESS_NET,
      '-e', 'SANDBOX_EGRESS=1',
      '-e', `SBX_EGRESS_ASHP_IP=${ip}`,
      '-e', `SBX_EGRESS_AGENT=${cfg.name}`,
      '-e', `SBX_EGRESS_TOKEN=${token}`,
      // The MITM CA for the main process and `exec` sessions (ssh sessions
      // get the same from profile.d + sshd SetEnv, written by egress-setup).
      // Node ignores the system store, so point it at the fetched CA; the
      // bundle paths for python/requests & co. are valid even before
      // update-ca-certificates merges the CA in.
      '-e', 'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ashp.crt',
      '-e', 'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt',
      '-e', 'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
    ];
  },

  onPurge(name) {
    purgeAgentToken(name);
  },
};
