// Renders a RunSpec into the docker/Apple-`container` `run` argv. Kept a pure
// function so it can be regression-tested against the legacy layout.

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
