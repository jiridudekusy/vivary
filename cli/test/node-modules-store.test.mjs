// node-modules keeps its overlays on a per-sandbox volume on Apple `container`.
// The volume is baked into the container, so the snapshot must change when a
// sandbox switches to it — that is what turns a stale kept container into a
// loud --recreate instead of a silent run with node_modules still on the Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { modulesVolume, STORE_MOUNT } from '../plugins/node-modules/plugin.mjs';
import { containerConfigSnapshot, diffContainerConfig } from '../core/sandbox.mjs';

const snap = (cfg) => containerConfigSnapshot({ workspace: '/w', ...cfg }, {}, [plugin]);

test('volume and mount names', () => {
  assert.equal(modulesVolume('smarta'), 'vivary-smarta-modules');
  assert.equal(STORE_MOUNT, '/vivary-modules-store');
});

test('the store volume shows up in the snapshot only where it is used', () => {
  assert.equal(snap({ runtime: 'container', nodeModules: 4 }).nodeModulesStore, 'volume');
  assert.equal(snap({ runtime: 'container', nodeModules: ['.', 'apps/web'] }).nodeModulesStore, 'volume');
  assert.equal(snap({ runtime: 'container', nodeModules: false }).nodeModulesStore, undefined);
  assert.equal(snap({ runtime: 'docker', nodeModules: 4 }).nodeModulesStore, undefined);
});

test('a kept container from before the volume is a config change', () => {
  const current = snap({ runtime: 'container', nodeModules: 4 });
  const { nodeModulesStore, ...before } = current;
  assert.deepEqual(diffContainerConfig(before, current),
    [{ key: 'nodeModulesStore', from: false, to: 'volume' }]);
  assert.deepEqual(diffContainerConfig(current, current), []);
});
