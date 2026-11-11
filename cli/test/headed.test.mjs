// headed: sticky; the screen opens in vivary web (no URL with a port, no
// password anywhere); the GUI starts live, so the flag stays out of the
// container snapshot — except as an echo for containers that recorded it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import headed, { screenLines } from '../plugins/headed/plugin.mjs';
import { parseServePorts, tailnetPortFree } from '../plugins/tailscale/plugin.mjs';
import { containerConfigSnapshot, diffContainerConfig } from '../core/sandbox.mjs';

test('the screen opens in vivary web: its running address, else the one it will have', () => {
  const info = { origin: 'https://mac.tail1.ts.net:8737' };
  assert.deepEqual(screenLines('findmy', { info, fqdn: () => 'x' }), ['https://mac.tail1.ts.net:8737/vnc/findmy']);
  assert.deepEqual(screenLines('findmy', { info: null, fqdn: () => 'mac.tail1.ts.net' }),
    ['https://mac.tail1.ts.net:8737/vnc/findmy', 'vivary web is not running — start it with: vivary web']);
  assert.equal(screenLines('a b', { info: null, fqdn: () => null })[0], 'http://localhost:7378/vnc/a%20b');
});

test('nothing secret in the container\'s environment any more', async () => {
  assert.deepEqual(await headed.runArgs({ cfg: { name: 'x', runtime: 'docker' }, cname: 'c' }), []);
  assert.deepEqual(await headed.runArgs({ cfg: { name: 'x', runtime: 'container', headed: true }, cname: 'c' }),
    ['-e', 'HEADED=1']);
  assert.deepEqual(await headed.runArgs({ cfg: { name: 'x', runtime: 'docker', headed: true }, cname: 'c' }),
    ['-e', 'HEADED=1']);
});

test('headed is sticky and starts live: turning it on is no config change on either runtime', () => {
  assert.equal(headed.flags.headed.sticky, true);
  const snap = (cfg) => containerConfigSnapshot({ workspace: '/w', ...cfg }, {}, [headed]);
  for (const runtime of ['docker', 'container']) {
    assert.equal(snap({ runtime, headed: true }).headed, undefined, runtime);
    assert.deepEqual(diffContainerConfig(snap({ runtime }), snap({ runtime, headed: true })), [], runtime);
  }
});

test('a container that recorded headed in its snapshot is not refused over that alone', () => {
  const snap = (cfg) => containerConfigSnapshot({ workspace: '/w', ...cfg }, {}, [headed]);
  // findmy: docker, created with the old noVNC publish baked in
  const saved = { ...snap({ runtime: 'docker' }), headed: true };
  for (const on of [true, false]) {
    assert.deepEqual(diffContainerConfig(saved, snap({ runtime: 'docker', headed: on, containerConfig: saved })), []);
  }
  // an Apple sandbox that recorded headed:false (with --tailscale) — same
  const apple = { ...snap({ runtime: 'container' }), headed: false };
  assert.deepEqual(diffContainerConfig(apple, snap({ runtime: 'container', headed: true, containerConfig: apple })), []);
});

test('tailnet ports: those tailscale serve already uses are never handed out', async () => {
  assert.deepEqual([...parseServePorts('{"TCP":{"6768":{"HTTPS":true},"9048":{"HTTPS":true}}}')], [6768, 9048]);
  assert.deepEqual([...parseServePorts('')], []);
  const free = tailnetPortFree(new Set([6768]), async () => true);
  assert.equal(await free(6768), false);
  assert.equal(await free(6769), true);
});
