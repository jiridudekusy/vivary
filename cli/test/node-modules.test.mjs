// Unit tests for the node-modules plugin's explicit dir list. The list comes
// from .vivary.json, which the agent can write, so containment is the point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModuleDirs, resolveModuleDirs } from '../plugins/node-modules/plugin.mjs';
import { migrateLegacyKeys } from '../core/sandbox.mjs';

test('relative dirs are normalized and de-duplicated, order preserved', () => {
  assert.deepEqual(normalizeModuleDirs(['.', 'apps/web', './apps/web', 'packages/lib/']),
    ['.', 'apps/web', 'packages/lib']);
});

test('an empty string is not silently treated as the workspace root', () => {
  assert.throws(() => normalizeModuleDirs(['apps', '  ']), /empty path in the list/);
});

test('absolute paths are refused', () => {
  assert.throws(() => normalizeModuleDirs(['/etc']), /must be workspace-relative/);
});

test('paths escaping the workspace are refused (agent-writable config)', () => {
  assert.throws(() => normalizeModuleDirs(['..']), /escapes the workspace/);
  assert.throws(() => normalizeModuleDirs(['../../etc']), /escapes the workspace/);
  assert.throws(() => normalizeModuleDirs(['apps/../../etc']), /escapes the workspace/);
});

test('a traversal that stays inside is fine', () => {
  assert.deepEqual(normalizeModuleDirs(['apps/web/../api']), ['apps/api']);
});

const stat = (kinds) => (abs) => {
  const kind = kinds[abs];
  if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return { isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' };
};

test('resolveModuleDirs accepts plain existing dirs', () => {
  const dirs = resolveModuleDirs('/ws', ['.', 'apps/web'],
    stat({ '/ws': 'dir', '/ws/apps/web': 'dir' }));
  assert.deepEqual(dirs, ['.', 'apps/web']);
});

test('a missing dir is a loud failure, not a silent skip (typo protection)', () => {
  assert.throws(() => resolveModuleDirs('/ws', ['apps/web'], stat({ '/ws': 'dir' })),
    /'apps\/web' does not exist in \/ws/);
});

test('a symlinked dir is refused — it could point outside the workspace', () => {
  assert.throws(() => resolveModuleDirs('/ws', ['apps'], stat({ '/ws/apps': 'link' })),
    /'apps' is a symlink/);
});

test('a file where a dir is expected is refused', () => {
  assert.throws(() => resolveModuleDirs('/ws', ['apps'], stat({ '/ws/apps': 'file' })),
    /'apps' is not a directory/);
});

// --- sandbox.json migration (own-modules -> node-modules) ------------------------

test('the legacy ownModules key migrates in place, keeping its value', () => {
  const writes = [];
  const out = migrateLegacyKeys({ name: 'x', ownModules: 3 }, '/s/sandbox.json',
    (f, data) => writes.push([f, JSON.parse(data)]));
  assert.deepEqual(out, { name: 'x', nodeModules: 3 });
  assert.equal(out.ownModules, undefined); // the old key is dropped, not kept alongside
  assert.deepEqual(writes, [['/s/sandbox.json', { name: 'x', nodeModules: 3 }]]);
});

test('an array value survives the migration unchanged', () => {
  const out = migrateLegacyKeys({ ownModules: ['.', 'apps/web'] }, '/s.json', () => {});
  assert.deepEqual(out.nodeModules, ['.', 'apps/web']);
});

test('migration is a no-op with nothing to migrate (no write)', () => {
  let wrote = false;
  const w = () => { wrote = true; };
  assert.deepEqual(migrateLegacyKeys({ nodeModules: 4 }, '/s.json', w), { nodeModules: 4 });
  assert.deepEqual(migrateLegacyKeys({ name: 'x' }, '/s.json', w), { name: 'x' });
  // a new key already present wins — never clobber it with the legacy value
  assert.deepEqual(migrateLegacyKeys({ ownModules: 1, nodeModules: 9 }, '/s.json', w),
    { ownModules: 1, nodeModules: 9 });
  assert.equal(wrote, false);
});
