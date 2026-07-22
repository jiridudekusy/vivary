// Renders a RunSpec into the docker/Apple-`container` `run` argv. Kept a pure
// function so it can be regression-tested against the legacy layout.

import { capture, runInherit } from '../util.mjs';
import { containerName, runningSet } from '../runtime.mjs';

export function renderRunArgs(spec, { runtime }) {
  const argv = ['run'];
  if (spec.rm) argv.push('--rm');
  if (spec.interactive) argv.push('-it');
  argv.push('--name', spec.name);
  if (spec.memory) argv.push('--memory', spec.memory);
  if (spec.cpus) argv.push('--cpus', spec.cpus);
  for (const m of spec.mounts || []) {
    argv.push('-v', `${m.host}:${m.guest}${m.ro ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(spec.env || {})) {
    argv.push('-e', `${k}=${v}`);
  }
  if (spec.cwd) argv.push('-w', spec.cwd);
  // Docker needs --init for signal reaping; Apple `container` does not.
  if (spec.init && runtime === 'docker') argv.push('--init');
  argv.push(...(spec.extraArgs || []));
  // Apple `container` strips caps by default; add ALL when a plugin needs it.
  if (spec.capsAll && runtime !== 'docker') argv.push('--cap-add', 'ALL');
  argv.push(...(spec.termEnv || []));
  argv.push(spec.image, ...(spec.command || []));
  return argv;
}

export function makeContainerCliRuntime(name) {
  return {
    name,
    kind: 'container-cli',
    runArgv(spec) { return renderRunArgs(spec, { runtime: name }); },
    ensureImage(spec) { return spec.image; },
    run(spec, { detached = false } = {}) {
      const argv = renderRunArgs(spec, { runtime: name });
      if (detached) {
        const i = argv.indexOf('--rm');
        argv.splice(i === -1 ? 1 : i + 1, 0, '-d');
        return capture(name, argv);
      }
      return runInherit(name, argv);
    },
    exec(cname, argv, { interactive = false, env = [] } = {}) {
      const a = ['exec', ...(interactive ? ['-it'] : []), ...env, cname, ...argv];
      return runInherit(name, a);
    },
    stop(cname) { return capture(name, ['stop', cname]); },
    rm(cname) { return capture(name, ['rm', cname]); },
    isRunning(sandboxName) { return runningSet(name).has(containerName(sandboxName)); },
    runningSet() { return runningSet(name); },
    ip() { return null; },
  };
}
