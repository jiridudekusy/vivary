import { makeContainerCliRuntime } from './container-cli.mjs';
import { makeTartRuntime } from './tart.mjs';

export function runtimeKind(name) {
  return name === 'tart' ? 'vm-tart' : 'container-cli';
}

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  if (name === 'tart') return makeTartRuntime();
  throw new Error(`unknown runtime '${name}' (docker, container, tart)`);
}
