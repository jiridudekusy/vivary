// headed: sticky, password-protected noVNC, a stable 127.0.0.1 port on docker,
// live start on Apple `container` (so it stays out of the generic snapshot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import headed, { generateVncPassword, novncUrl } from '../plugins/headed/plugin.mjs';
import { containerConfigSnapshot, diffContainerConfig } from '../core/sandbox.mjs';

test('VNC passwords: 8 chars (VNC truncates there), no look-alike characters', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generateVncPassword();
    assert.equal(pw.length, 8);
    assert.doesNotMatch(pw, /[0O1lIi2Z5S6G8Bo]/);
  }
  let n = 0;
  assert.equal(generateVncPassword(() => n++ % 3), 'abcabcab');
});

test('noVNC URL: container DNS on Apple, localhost:<port> on docker, password included', () => {
  assert.equal(novncUrl({ runtime: 'container', cname: 'claude-sandbox-findmy', domain: 'mac.local', password: 'ab cd' }),
    'http://claude-sandbox-findmy.mac.local:6080/vnc.html?autoconnect=true&resize=scale&password=ab%20cd');
  assert.equal(novncUrl({ runtime: 'docker', cname: 'x', domain: '', port: 6081, password: 'pw' }),
    'http://localhost:6081/vnc.html?autoconnect=true&resize=scale&password=pw');
});

test('headed is sticky, and in the snapshot only where it is baked in (docker)', () => {
  assert.equal(headed.flags.headed.sticky, true);
  const snap = (cfg) => containerConfigSnapshot({ workspace: '/w', ...cfg }, {}, [headed]);
  assert.equal(snap({ runtime: 'docker', headed: true }).headed, true);
  assert.equal(snap({ runtime: 'container', headed: true }).headed, undefined);
  // turning it on for a kept Apple container is not a config change — postUp starts it live
  assert.deepEqual(diffContainerConfig(snap({ runtime: 'container' }), snap({ runtime: 'container', headed: true })), []);
  assert.deepEqual(diffContainerConfig(snap({ runtime: 'docker' }), snap({ runtime: 'docker', headed: true })),
    [{ key: 'headed', from: false, to: true }]);
});

test('runArgs: nothing without the flag', async () => {
  assert.deepEqual(await headed.runArgs({ cfg: { name: 'x', runtime: 'docker' }, cname: 'c' }), []);
});
