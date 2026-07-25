import { makeContainerCliRuntime } from './container-cli.mjs';
import { makeTartRuntime } from './tart.mjs';

export function runtimeKind(name) {
  return name === 'tart' ? 'vm-tart' : 'container-cli';
}

export const RUNTIME_NAMES = ['docker', 'container', 'tart'];

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  if (name === 'tart') return makeTartRuntime();
  throw new Error(`unknown runtime '${name}' (docker, container, tart)`);
}

// Runtimes that currently hold a running instance of this sandbox.
//
// sandbox.json is NOT the last word on where the instance lives: a project
// .vivary.json may set a different `runtime`, and that override is applied in
// memory for the invocation only — so `vivary up` can start the sandbox under
// docker while the registry still says container. down/rm/ls therefore ask the
// runtimes instead of trusting the record (a missing runtime CLI just answers
// "no"), which is what kept a container running after `vivary rm --purge`.
export function runtimesRunning(sandboxName, names = RUNTIME_NAMES) {
  const found = [];
  for (const name of names) {
    try {
      if (resolveRuntime(name).isRunning(sandboxName)) found.push(name);
    } catch {
      // runtime not installed / not reachable — nothing of ours runs there
    }
  }
  return found;
}
