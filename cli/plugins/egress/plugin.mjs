// egress: default-deny outbound with per-request logging and human approval.
// The sandbox attaches ONLY to the shared internal `vivary-egress` net (no
// default net -> no direct route out); its DNS, HTTPS and HTTP are forced
// through ASHP running as a transparent MITM proxy (see ashp.mjs). Approve /
// deny requests in ASHP's policy UI. Inter-sandbox isolation comes from an
// ingress firewall raised inside each sandbox (egress-setup helper): host
// traffic arrives as gateway .1 and is allowed, peer sandboxes are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { die } from '../../core/util.mjs';
import { detectRuntime } from '../../core/runtime.mjs';
import { runtimeKind } from '../../core/runtimes/index.mjs';
import { sandboxDir } from '../../core/sandbox.mjs';
import {
  cmdEgress, ensureAgent, ensureAshp, purgeAgent, syncAgentRules,
  ashpCaCertPath, mgmtCertPath, EGRESS_NET, MGMT_HOSTNAME, PROXY_PORT,
} from './ashp.mjs';
import { expandPresets } from './presets.mjs';

// Where the per-sandbox egress dir (ASHP CA) mounts inside a tart guest.
const TART_EGRESS_DIR = '/Users/admin/.vivary-egress';

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

    // Deliver the MITM CA (public) and the mgmt TLS cert (public) to the
    // sandbox via a per-sandbox mount, instead of the sandbox fetching them
    // over the shared L2 where a hostile peer could inject its own CA. The CA
    // private key and the mgmt key never leave the host.
    const egressDir = path.join(sandboxDir(cfg.name), 'egress');
    fs.mkdirSync(egressDir, { recursive: true });
    const caSrc = ashpCaCertPath();
    for (let i = 0; i < 40 && !fs.existsSync(caSrc); i++) {
      await new Promise((r) => setTimeout(r, 250)); // ASHP writes its CA on first proxy start
    }
    if (!fs.existsSync(caSrc)) {
      die(`egress: ASHP CA not found at ${caSrc} (ASHP may not have finished starting)`);
    }
    fs.copyFileSync(caSrc, path.join(egressDir, 'ashp-ca.crt'));
    fs.copyFileSync(mgmtCertPath(), path.join(egressDir, 'mgmt.crt'));

    log(`==> egress: outbound via ASHP at ${ip} (policy UI: https://${ip}:3000/)`);
    return [
      '--network', EGRESS_NET,
      '-e', 'SANDBOX_EGRESS=1',
      '-e', `SBX_EGRESS_ASHP_IP=${ip}`,
      '-e', `SBX_EGRESS_AGENT=${cfg.name}`,
      '-e', `SBX_EGRESS_TOKEN=${token}`,
      '-e', `SBX_EGRESS_MGMT_HOST=${MGMT_HOSTNAME}`,
      '-v', `${egressDir}:/vivary-egress`,
      // The MITM CA for the main process and `exec` sessions (ssh sessions get
      // the same from profile.d + sshd SetEnv, written by egress-setup). Node
      // ignores the system store, so point it at the CA egress-setup installs;
      // the bundle paths for python/requests & co. are valid even before
      // update-ca-certificates merges the CA in.
      '-e', 'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ashp.crt',
      '-e', 'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt',
      '-e', 'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
    ];
  },

  // tart: no internal egress net and no in-guest firewall. Instead: a Softnet
  // floor (default-deny outbound, gateway-only) forces the guest's ONLY route
  // out to be the host, where ASHP's explicit proxy (published on the vmnet
  // gateway) enforces the L7 policy. The MITM CA rides in on a per-sandbox RO
  // mount (never fetched over the wire), and HTTPS_PROXY carries the agent's
  // ASHP token so per-agent rules apply. __GATEWAY__ is resolved after boot.
  async vmContribute(ctx) {
    const { cfg, log } = ctx;
    if (!cfg.egress || runtimeKind(cfg.runtime) !== 'vm-tart') return {};
    const runtime = detectRuntime(); // ASHP itself always runs as a container
    const { ip, adminPassword } = await ensureAshp(runtime);
    const token = await ensureAgent(ip, adminPassword, cfg.name);
    const policy = cfg.egressPolicy || {};
    const patterns = [...expandPresets(policy.presets), ...(policy.allow || [])];
    await syncAgentRules(ip, adminPassword, cfg.name, patterns);

    const egressDir = path.join(sandboxDir(cfg.name), 'egress');
    fs.mkdirSync(egressDir, { recursive: true });
    const caSrc = ashpCaCertPath();
    for (let i = 0; i < 40 && !fs.existsSync(caSrc); i++) {
      await new Promise((r) => setTimeout(r, 250)); // ASHP writes its CA on first proxy start
    }
    if (!fs.existsSync(caSrc)) {
      die(`egress: ASHP CA not found at ${caSrc} (ASHP may not have finished starting)`);
    }
    fs.copyFileSync(caSrc, path.join(egressDir, 'ashp-ca.crt'));
    const guestCa = `${TART_EGRESS_DIR}/ashp-ca.crt`;
    const proxy = `http://${cfg.name}:${token}@__GATEWAY__:${PROXY_PORT}`;

    log(`==> egress(tart): softnet default-deny + ASHP proxy at <gateway>:${PROXY_PORT} (policy UI: https://${ip}:3000/)`);
    return {
      // Softnet floor: deny all, allow only the vmnet/private space (the guest
      // can physically reach only the host gateway there — i.e. the proxy).
      runArgs: ['--net-softnet', '--net-softnet-block=0.0.0.0/0', '--net-softnet-allow=192.168.0.0/16'],
      mounts: [{ host: egressDir, guest: TART_EGRESS_DIR, ro: true }],
      env: {
        HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
        NODE_EXTRA_CA_CERTS: guestCa, SSL_CERT_FILE: guestCa, REQUESTS_CA_BUNDLE: guestCa,
      },
    };
  },

  async onPurge(name) {
    await purgeAgent(name);
  },
};
