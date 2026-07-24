// Unit tests for the ports plugin (publish spec parsing) and the parseArgs
// pieces it needs: repeatable 'list' flags and docker-style short aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../core/util.mjs';
import { DEFAULT_BIND, parsePublish, publishList, renderPublish } from '../plugins/ports/plugin.mjs';

const SPEC = { publish: { type: 'list', short: 'p' }, name: 'string', sudo: 'boolean' };

// --- parseArgs: list + short alias ----------------------------------------------

test('a list flag is repeatable and always yields an array', () => {
  const { flags } = parseArgs(['--publish', '8080:80', '--publish=3000'], SPEC);
  assert.deepEqual(flags.publish, ['8080:80', '3000']);
});

test('a list flag also splits a comma-separated value', () => {
  const { flags } = parseArgs(['--publish', '8080:80,3000'], SPEC);
  assert.deepEqual(flags.publish, ['8080:80', '3000']);
});

test('the short alias works both attached and detached (docker-style)', () => {
  assert.deepEqual(parseArgs(['-p', '8080:80'], SPEC).flags.publish, ['8080:80']);
  assert.deepEqual(parseArgs(['-p8080:80'], SPEC).flags.publish, ['8080:80']);
  assert.deepEqual(parseArgs(['-p', '80:80', '-p', '443:443'], SPEC).flags.publish,
    ['80:80', '443:443']);
});

test('unknown short flags still behave as before', () => {
  // with unknownToRest the token goes to rest instead of dying
  const { rest, flags } = parseArgs(['-x', 'y'], SPEC, { unknownToRest: true });
  assert.deepEqual(rest, ['-x', 'y']);
  assert.equal(flags.publish, undefined);
});

test('non-list flags keep last-wins semantics', () => {
  const { flags } = parseArgs(['--name', 'a', '--name', 'b', '--sudo'], SPEC);
  assert.equal(flags.name, 'b');
  assert.equal(flags.sudo, true);
});

// --- parsePublish ---------------------------------------------------------------

test('a bare port maps to the same port on both sides, bound to loopback', () => {
  assert.deepEqual(parsePublish('3000'),
    { hostIp: DEFAULT_BIND, hostPort: 3000, containerPort: 3000, proto: 'tcp' });
  assert.equal(DEFAULT_BIND, '127.0.0.1'); // deliberate deviation from docker
});

test('HOST:CONTAINER binds loopback unless a host IP is given', () => {
  assert.deepEqual(parsePublish('8080:80'),
    { hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, proto: 'tcp' });
  assert.deepEqual(parsePublish('0.0.0.0:8080:80'),
    { hostIp: '0.0.0.0', hostPort: 8080, containerPort: 80, proto: 'tcp' });
});

test('the /proto suffix is honoured', () => {
  assert.equal(parsePublish('53:53/udp').proto, 'udp');
  assert.equal(parsePublish('127.0.0.1:53:53/UDP').proto, 'udp');
});

test('malformed specs throw with the offending value', () => {
  assert.throws(() => parsePublish('8080:'), /expected \[host-ip:\]host-port/);
  assert.throws(() => parsePublish('a:b:c:d'), /expected \[host-ip:\]host-port/);
  assert.throws(() => parsePublish('http:80'), /host port 'http' is not a port number/);
  assert.throws(() => parsePublish('99999:80'), /out of range/);
  assert.throws(() => parsePublish('0:80'), /out of range/);
});

test('renderPublish round-trips into the runtime -p value', () => {
  assert.equal(renderPublish(parsePublish('8080:80')), '127.0.0.1:8080:80/tcp');
  assert.equal(renderPublish(parsePublish('0.0.0.0:53:53/udp')), '0.0.0.0:53:53/udp');
});

test('publishList tolerates a single string, blanks and a disabled flag', () => {
  assert.deepEqual(publishList('8080:80'), ['8080:80']);
  assert.deepEqual(publishList([' 8080:80 ', '', '3000']), ['8080:80', '3000']);
  assert.deepEqual(publishList(false), []);
});
