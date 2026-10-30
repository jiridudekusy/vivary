// Unit tests for device keys: one keypair per client device, merged into every
// sandbox's authorized_keys (instead of one keypair per sandbox, which forced
// an iPad to import a separate private key for each container).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAuthorizedKeys, parsePublicKey } from '../plugins/ssh/devices.mjs';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody';

test('a valid public key is accepted and normalized', () => {
  assert.equal(parsePublicKey(`${ED} me@ipad`), `${ED} me@ipad`);
  assert.equal(parsePublicKey(`  ${ED} me@ipad \n`), `${ED} me@ipad`);
  assert.equal(parsePublicKey(ED), ED);             // comment is optional
});

test('a PRIVATE key is refused with its own message', () => {
  // The .pub file sits next to the private one; pasting the wrong half must not
  // end up in a registry that is copied into every sandbox.
  assert.throws(
    () => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\n-----END OPENSSH PRIVATE KEY-----'),
    /PRIVATE key/,
  );
});

test('malformed input is refused', () => {
  assert.throws(() => parsePublicKey(''), /empty key/);
  assert.throws(() => parsePublicKey(`${ED}\n${ED}`), /exactly one public key/);
  assert.throws(() => parsePublicKey('ssh-banana AAAA x'), /unsupported key type/);
  assert.throws(() => parsePublicKey('ssh-ed25519 not!base64 x'), /not base64/);
});

test('authorized_keys options are refused, not silently copied', () => {
  // from="..." / command="..." are a policy surface; accepting them would push
  // unreviewed restrictions into every sandbox.
  assert.throws(() => parsePublicKey(`from="10.0.0.1" ${ED} me@ipad`), /unsupported key type/);
});

test('merge puts the sandbox key first, then labelled device keys', () => {
  const out = mergeAuthorizedKeys(`${ED}A own`, [
    { name: 'ipad', key: `${ED}B a@ipad` },
    { name: 'phone', key: `${ED}C a@phone` },
  ]);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /own$/);
  assert.match(lines[1], /vivary-device:ipad$/);
  assert.match(lines[2], /vivary-device:phone$/);
  assert.ok(out.endsWith('\n'), 'authorized_keys must end with a newline');
});

test('the same key body is authorized once, whatever its comment or name', () => {
  const out = mergeAuthorizedKeys(`${ED}A own`, [
    { name: 'ipad', key: `${ED}B a@ipad` },
    { name: 'ipad-again', key: `${ED}B different@comment` },
  ]);
  assert.equal(out.trim().split('\n').length, 2);
});

test('a device key identical to the sandbox key does not double up', () => {
  const out = mergeAuthorizedKeys(`${ED}A own`, [{ name: 'dup', key: `${ED}A elsewhere` }]);
  assert.equal(out.trim().split('\n').length, 1);
});

test('no devices yet still yields the sandbox key alone', () => {
  assert.equal(mergeAuthorizedKeys(`${ED}A own`, []), `${ED}A own\n`);
});
