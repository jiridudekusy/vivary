// headed: sticky, password-protected noVNC, a stable 127.0.0.1 port on docker,
// live start on Apple `container` (so it stays out of the generic snapshot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import headed, { accessLines, generateVncPassword, novncUrl, tailnetUrl } from '../plugins/headed/plugin.mjs';
import { parseServePorts, tailnetPortFree } from '../plugins/tailscale/plugin.mjs';
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

test('noVNC URL: container DNS on Apple, localhost:<port> on docker — never the password', () => {
  assert.equal(novncUrl({ runtime: 'container', cname: 'claude-sandbox-findmy', domain: 'mac.local', password: 'secret12' }),
    'http://claude-sandbox-findmy.mac.local:6080/vnc.html?autoconnect=true&resize=scale');
  assert.equal(novncUrl({ runtime: 'docker', cname: 'x', domain: '', port: 6081, password: 'secret12' }),
    'http://localhost:6081/vnc.html?autoconnect=true&resize=scale');
});

test('the password is shown on a line of its own, after every URL', () => {
  assert.deepEqual(accessLines('http://localhost:6080/vnc.html', 'abcDEF34'),
    ['http://localhost:6080/vnc.html', 'password: abcDEF34']);
  assert.deepEqual(accessLines(['http://a', 'https://b'], 'pw'), ['http://a', 'https://b', 'password: pw']);
});

test('tailnet URL: HTTPS on the host FQDN and the share port, no password', () => {
  assert.equal(tailnetUrl('mac.tail1.ts.net', 8701), 'https://mac.tail1.ts.net:8701/vnc.html?autoconnect=true&resize=scale');
});

test('the publish is baked (in the snapshot) on docker, and on Apple only with --tailscale', () => {
  const snap = (cfg) => containerConfigSnapshot({ workspace: '/w', ...cfg }, {}, [headed]);
  assert.equal(snap({ runtime: 'container', tailscale: true, headed: true }).headed, true);
  assert.equal(snap({ runtime: 'container', tailscale: false, headed: true }).headed, undefined);
});

test('tailnet ports: those tailscale serve already uses are never handed out', async () => {
  assert.deepEqual([...parseServePorts('{"TCP":{"6768":{"HTTPS":true},"9048":{"HTTPS":true}}}')], [6768, 9048]);
  assert.deepEqual([...parseServePorts('')], []);
  const free = tailnetPortFree(new Set([6768]), async () => true);
  assert.equal(await free(6768), false);
  assert.equal(await free(6769), true);
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
