import { die } from '../util.mjs';
import { makeContainerCliRuntime } from './container-cli.mjs';

export function resolveRuntime(name) {
  if (name === 'docker' || name === 'container') return makeContainerCliRuntime(name);
  return die(`unknown runtime '${name}' (docker, container)`);
}
