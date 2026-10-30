// docker: docker-in-sandbox — agents can build and run containers inside,
// with no access to the host Docker daemon.
//
// The inner dockerd's daemon.json comes from the `dockerd` key of
// .vivary.json / profiles / the default file (merged key by key, see
// layers.mjs) — insecure-registries, registry-mirrors, dns, ... It is applied
// on every start by the host (`dockerd-config`, run as root in the sandbox), not
// baked into the container, so changing it needs no --recreate: keys dockerd
// reloads live are reloaded, anything else restarts dockerd.
import { capture, hasCmd } from '../../core/util.mjs';
import { containerName } from '../../core/runtime.mjs';

const isEmpty = (o) => !o || !Object.keys(o).length;
// /var/lib/docker of a docker-runtime sandbox (Apple `container` keeps it in
// the container's own rootfs, which goes with the container).
export const dockerDataVolume = (name) => `${containerName(name)}-docker`;

export default {
  name: 'docker',
  order: 40,
  flags: {
    docker: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'docker',
      help: 'Docker-in-sandbox: agents can build/run containers\ninside (sticky — remembered in the sandbox config).\nIts daemon.json: the `dockerd` key of .vivary.json or a\nprofile (e.g. "insecure-registries").',
    },
  },
  needsCaps: (cfg) => !!cfg.docker,
  runArgs({ cfg }) {
    if (!cfg.docker) return [];
    const args = ['-e', 'SANDBOX_DOCKER=1'];
    if (cfg.runtime === 'docker') {
      // dockerd needs privileges, and overlay2 can't sit on overlayfs — give
      // /var/lib/docker a named volume.
      args.push('--privileged', '-v', `${dockerDataVolume(cfg.name)}:/var/lib/docker`);
    }
    return args;
  },
  async postUp(ctx) {
    const { cfg, cname } = ctx;
    const conf = cfg.dockerdConfig || {};
    if (!cfg.docker) {
      if (!isEmpty(conf)) ctx.log('WARNING: docker: dockerd settings are ignored — this sandbox has no --docker');
      return;
    }
    if (!['container', 'docker'].includes(cfg.runtime)) return;
    // Always sent, even empty: removing the key must take the settings out again.
    const r = capture(cfg.runtime, ['exec', '-i', '--user', 'root', cname, 'dockerd-config'],
      { input: JSON.stringify(conf), timeout: 90000 });
    const out = `${r.stdout}${r.stderr}`.trim();
    if (r.status === 0) {
      if (out !== 'unchanged') ctx.log(`==> docker: daemon.json ${out}`);
      return;
    }
    if (/not found|no such file/i.test(out)) {
      // A kept container from an image without dockerd-config.
      if (!isEmpty(conf)) {
        console.error(`WARNING: docker: dockerd settings NOT applied — this sandbox's image predates them.\n`
          + `    Rebuild it once: vivary up ${cfg.name} --recreate`);
      }
      return;
    }
    console.error(`WARNING: docker: dockerd settings NOT applied (the previous ones stay): ${out}`);
  },

  // Every rm, like node-modules' volumes: it holds what was pulled and built in
  // that container, and nothing else ever deleted it — a removed sandbox left
  // its images behind in Docker Desktop's VM. Checked whatever the recorded
  // runtime: a runtime switch is rm + fresh up.
  onRemove(name, cfg) {
    if (!hasCmd('docker')) return;
    const vol = dockerDataVolume(name);
    const inspect = capture('docker', ['volume', 'inspect', vol], { timeout: 15000 });
    if (inspect.status !== 0) {
      // Docker Desktop off: only worth a word for a sandbox that ran there.
      if (!/no such volume/i.test(inspect.stderr) && cfg?.runtime === 'docker') {
        console.error(`WARNING: docker not reachable — volume ${vol} (its images) was not deleted`);
      }
      return;
    }
    const r = capture('docker', ['volume', 'rm', vol]);
    if (r.status === 0) console.log(`==> docker data volume ${vol} deleted.`);
    else console.error(`WARNING: could not delete volume ${vol}: ${(r.stderr || r.stdout).trim()}`);
  },
};
