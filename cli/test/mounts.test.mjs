// Unit tests for the mounts plugin. The interesting part is the trust split:
// .vivary.json is agent-writable, the CLI is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInside, mountDenyReason, mountList, mountWarning, parseMount, resolveMounts,
} from '../plugins/mounts/plugin.mjs';

const HOME = '/Users/u';
const STATE = '/Users/u/.vivary';
const CWD = '/work/proj';
const ctx = { home: HOME, cwd: CWD };

// --- parseMount -----------------------------------------------------------------

test('a bare host path mounts at the same absolute path (vivary invariant)', () => {
  assert.deepEqual(parseMount('~/data', ctx), { host: '/Users/u/data', guest: '/Users/u/data', ro: false });
});

test('a relative host path resolves against the cwd', () => {
  assert.deepEqual(parseMount('sub/dir', ctx).host, '/work/proj/sub/dir');
});

test('HOST:ro keeps the same path and marks it read-only', () => {
  assert.deepEqual(parseMount('~/models:ro', ctx),
    { host: '/Users/u/models', guest: '/Users/u/models', ro: true });
});

test('HOST:GUEST[:mode] is honoured, rw is the default', () => {
  assert.deepEqual(parseMount('~/data:/data', ctx),
    { host: '/Users/u/data', guest: '/data', ro: false });
  assert.deepEqual(parseMount('~/data:/data:ro', ctx).ro, true);
  assert.deepEqual(parseMount('~/data:/data:rw', ctx).ro, false);
});

test('malformed specs throw', () => {
  assert.throws(() => parseMount('~/data:', ctx), /expected HOST\[:GUEST\]\[:ro\]/);
  assert.throws(() => parseMount('a:b:c:d', ctx), /expected HOST\[:GUEST\]\[:ro\]/);
  assert.throws(() => parseMount('~/data:/data:nope', ctx), /mode 'nope' must be ro or rw/);
  assert.throws(() => parseMount('~/data:relative', ctx), /'relative' must be absolute/);
});

// --- isInside -------------------------------------------------------------------

test('isInside covers the dir itself and children, not siblings or ancestors', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a', '/a/b'), false);
});

// --- policy ---------------------------------------------------------------------

test('the vivary state dir is refused from the CLI as well as from the file', () => {
  for (const origin of ['cli', 'file']) {
    assert.match(mountDenyReason('/Users/u/.vivary', { origin, home: HOME, stateDir: STATE }),
      /broker tokens and the approved-config baseline/);
    assert.match(mountDenyReason('/Users/u/.vivary/other/broker-token', { origin, home: HOME, stateDir: STATE }),
      /refusing to mount/);
  }
});

test('credential stores are refused from .vivary.json but allowed from the CLI', () => {
  for (const p of ['/Users/u/.ssh', '/Users/u/.aws/credentials', '/etc/passwd',
    '/Users/u/Library/Keychains']) {
    assert.match(mountDenyReason(p, { origin: 'file', home: HOME, stateDir: STATE }),
      /deny-list for config-file mounts/);
    assert.equal(mountDenyReason(p, { origin: 'cli', home: HOME, stateDir: STATE }), null);
  }
});

test('an ordinary path is allowed from both origins', () => {
  for (const origin of ['cli', 'file']) {
    assert.equal(mountDenyReason('/Users/u/data', { origin, home: HOME, stateDir: STATE }), null);
  }
});

test('a CLI mount that CONTAINS the state dir warns instead of failing', () => {
  assert.match(mountWarning('/Users/u', { stateDir: STATE }), /contains .*\.vivary/);
  assert.equal(mountWarning('/Users/u/data', { stateDir: STATE }), null);
  assert.equal(mountWarning(STATE, { stateDir: STATE }), null); // that one is refused outright
});

// --- resolveMounts --------------------------------------------------------------

const exists = (set) => (p) => set.includes(p);

test('resolveMounts parses, policy-checks and requires the host path to exist', () => {
  const out = resolveMounts(['~/data:/data:ro', '~/models'],
    { ...ctx, stateDir: STATE, exists: exists(['/Users/u/data', '/Users/u/models']) });
  assert.deepEqual(out, [
    { host: '/Users/u/data', guest: '/data', ro: true },
    { host: '/Users/u/models', guest: '/Users/u/models', ro: false },
  ]);
});

test('a missing host path fails loudly (a silent empty mount hides the typo)', () => {
  assert.throws(() => resolveMounts(['~/typo'], { ...ctx, stateDir: STATE, exists: exists([]) }),
    /host path '\/Users\/u\/typo' does not exist/);
});

test('a file-origin deny-listed mount never reaches the runtime', () => {
  assert.throws(() => resolveMounts(['~/.ssh:/keys'],
    { ...ctx, origin: 'file', stateDir: STATE, exists: exists(['/Users/u/.ssh']) }),
    /deny-list for config-file mounts/);
});

test('mountList tolerates a single string, blanks and a disabled flag', () => {
  assert.deepEqual(mountList('~/a:/a'), ['~/a:/a']);
  assert.deepEqual(mountList([' ~/a ', '', '~/b']), ['~/a', '~/b']);
  assert.deepEqual(mountList(false), []);
});
