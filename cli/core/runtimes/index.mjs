import { makeContainerCliRuntime } from './container-cli.mjs';

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  if (name === 'tart') throw new Error("runtime 'tart' is not yet implemented (Phase 2)");
  throw new Error(`unknown runtime '${name}' (docker, container, tart)`);
}
