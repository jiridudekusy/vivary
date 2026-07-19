// docker: docker-in-sandbox — agents can build and run containers inside,
// with no access to the host Docker daemon.
import { containerName } from '../../core/runtime.mjs';

export default {
  name: 'docker',
  order: 40,
  flags: {
    docker: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'docker',
      help: 'Docker-in-sandbox: agents can build/run containers\ninside (sticky — remembered in the sandbox config)',
    },
  },
  needsCaps: (cfg) => !!cfg.docker,
  runArgs({ cfg }) {
    if (!cfg.docker) return [];
    const args = ['-e', 'SANDBOX_DOCKER=1'];
    if (cfg.runtime === 'docker') {
      // dockerd needs privileges, and overlay2 can't sit on overlayfs — give
      // /var/lib/docker a named volume.
      args.push('--privileged', '-v', `${containerName(cfg.name)}-docker:/var/lib/docker`);
    }
    return args;
  },
};
