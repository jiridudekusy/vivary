// node-modules keeps its overlays on a per-sandbox volume on Apple `container`.
// The volume is baked into the container, so the snapshot must change when a
// sandbox switches to it — that is what turns a stale kept container into a
// loud --recreate instead of a silent run with node_modules still on the Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, {
  STORE_MOUNT, dockerModulesVolume, dockerVolumeSetupArgv, modulesVolume,
} from '../plugins/node-modules/plugin.mjs';
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
  assert.equal(snap({ runtime: 'docker', nodeModules: 4 }).nodeModulesStore, 'volume');
  assert.equal(snap({ runtime: 'tart', nodeModules: 4 }).nodeModulesStore, undefined);
});

test('a kept container from before the volume is a config change', () => {
  const current = snap({ runtime: 'container', nodeModules: 4 });
  const { nodeModulesStore, ...before } = current;
  assert.deepEqual(diffContainerConfig(before, current),
    [{ key: 'nodeModulesStore', from: false, to: 'volume' }]);
  assert.deepEqual(diffContainerConfig(current, current), []);
});

test('docker: one volume per package dir', () => {
  assert.equal(dockerModulesVolume('smarta', 'apps-web'), 'vivary-smarta-nm-apps-web');
  assert.equal(dockerModulesVolume('smarta', 'root'), 'vivary-smarta-nm-root');
});

test('docker volume setup: fresh volumes are handed to agent, legacy dirs copied safely', () => {
  const argv = dockerVolumeSetupArgv([
    { volume: 'vivary-s-nm-root', legacy: null },
    { volume: 'vivary-s-nm-app', legacy: '/Users/x/.vivary/s/modules/app' },
  ], 'img');
  assert.deepEqual(argv.slice(0, 6), ['run', '--rm', '--user', 'root', '--entrypoint', 'sh']);
  assert.ok(argv.join(' ').includes('-v vivary-s-nm-root:/v/0 -v vivary-s-nm-app:/v/1 -v /Users/x/.vivary/s/modules/app:/old/1:ro img -c'));
  const script = argv.at(-1);
  assert.match(script, /^set -e; /);
  assert.match(script, /chown agent:agent \/v\/0(;|$)/);
  // the legacy copy: no ownership carried over, setuid stripped, links kept
  assert.match(script, /cp -rP --preserve=mode,timestamps,links \/old\/1\/\. \/v\/1\//);
  assert.match(script, /chown -R agent:agent \/v\/1; chmod -R u-s,g-s \/v\/1/);
  assert.doesNotMatch(script, /--preserve=[^ ]*ownership|cp -a/);
});
