// Unit tests for the workspace history-slug scoping (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSlug, workspaceSlugs } from '../plugins/agent-claude/plugin.mjs';

test('projectSlug mangles every non-alphanumeric char to "-"', () => {
  assert.equal(projectSlug('/Users/me/work/app'), '-Users-me-work-app');
  assert.equal(projectSlug('/a/b.c'), '-a-b-c');
});

// Injected directory tree for a deterministic, FS-free walk.
function fakeTree(map) {
  return (dir) => {
    if (!(dir in map)) throw new Error(`ENOENT ${dir}`);
    return map[dir];
  };
}

test('workspaceSlugs includes the workspace and its real subdirectories', () => {
  const slugs = workspaceSlugs('/Users/me/work/app', fakeTree({
    '/Users/me/work/app': ['src', 'pkg', 'node_modules', '.git'],
    '/Users/me/work/app/src': [],
    '/Users/me/work/app/pkg': ['nested'],
    '/Users/me/work/app/pkg/nested': [],
  }));
  assert.ok(slugs.has('-Users-me-work-app'));
  assert.ok(slugs.has('-Users-me-work-app-src'));
  assert.ok(slugs.has('-Users-me-work-app-pkg'));
  assert.ok(slugs.has('-Users-me-work-app-pkg-nested'));
});

test('workspaceSlugs skips node_modules/.git (no overlay/vcs history noise)', () => {
  const slugs = workspaceSlugs('/Users/me/work/app', fakeTree({
    '/Users/me/work/app': ['src', 'node_modules', '.git'],
    '/Users/me/work/app/src': [],
  }));
  assert.ok(!slugs.has('-Users-me-work-app-node_modules'));
  assert.ok(!slugs.has('-Users-me-work-app--git'));
});

test('workspaceSlugs excludes a sibling matching the slug prefix (the H3 bug)', () => {
  const slugs = workspaceSlugs('/Users/me/work/app', fakeTree({ '/Users/me/work/app': [] }));
  const sibling = projectSlug('/Users/me/work/app-secret'); // '-Users-me-work-app-secret'
  assert.ok(sibling.startsWith('-Users-me-work-app-')); // would pass the old prefix test
  assert.ok(!slugs.has(sibling));                        // but is not an allowed slug
});

test('workspaceSlugs respects the depth cap', () => {
  const listDirs = fakeTree({
    '/w': ['a'], '/w/a': ['b'], '/w/a/b': ['c'], '/w/a/b/c': [],
  });
  const slugs = workspaceSlugs('/w', listDirs, { maxDepth: 1 });
  assert.ok(slugs.has('-w'));
  assert.ok(slugs.has('-w-a'));       // depth 1, walked
  assert.ok(slugs.has('-w-a-b'));     // added when visiting /w/a (before the depth gate)
  assert.ok(!slugs.has('-w-a-b-c'));  // /w/a/b was never walked (depth 2 > cap)
});
