// Unit tests for the uunpm plugin: version pinning of the uu-safe-* family and
// the flag normalization. The shim's recursion guard is shell-side and covered
// by the manual smoke recipe (see CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import uunpm, { parseNpmVersion, resolveSafeSpecs } from '../plugins/uunpm/plugin.mjs';
import { collectPresets } from '../plugins/egress/plugin.mjs';

const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('parseNpmVersion accepts a version and rejects npm noise', () => {
  assert.equal(parseNpmVersion('1.4.1\n'), '1.4.1');
  assert.equal(parseNpmVersion('1.4.1-beta.2'), '1.4.1-beta.2');
  // `npm view` may print a deprecation/notice line before the value
  assert.equal(parseNpmVersion('npm warn deprecated foo\n1.4.1\n'), '1.4.1');
  assert.equal(parseNpmVersion('npm error code E404'), null);
  assert.equal(parseNpmVersion(''), null);
  assert.equal(parseNpmVersion(undefined), null);
});

test('every package is pinned separately — the family may diverge', () => {
  const versions = { 'uu-safe-npm': '1.4.1', 'uu-safe-npx': '1.5.0' };
  const specs = resolveSafeSpecs(['uu-safe-npm', 'uu-safe-npx'],
    (pkg) => ({ status: 0, stdout: versions[pkg], stderr: '' }));
  assert.equal(specs, 'uu-safe-npm@1.4.1 uu-safe-npx@1.5.0');
});

test('an unreachable registry warns and degrades to unpinned, never fails the build', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(resolveSafeSpecs(['uu-safe-npm'], () => ({ status: 7, stdout: '', stderr: 'no net' })),
      'uu-safe-npm');
    // an npm error page must not be mistaken for a version
    assert.equal(resolveSafeSpecs(['uu-safe-npx'], ok('npm error 404 Not Found')), 'uu-safe-npx');
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 2);
  assert.match(errs[0], /could not resolve versions/);
});

test('a partly resolvable family pins what it can', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    const specs = resolveSafeSpecs(['good', 'bad'],
      (pkg) => (pkg === 'good' ? { status: 0, stdout: '1.4.1' } : { status: 1, stdout: '' }));
    assert.equal(specs, 'good@1.4.1 bad');
  } finally {
    console.error = orig;
  }
  assert.match(errs[0], /for: bad/);
});

test('--uunpm normalizes to on|alias|false', () => {
  const { normalize } = uunpm.flags.uunpm;
  assert.equal(normalize(true), 'on');
  assert.equal(normalize('on'), 'on');
  assert.equal(normalize('1'), 'on');
  assert.equal(normalize('alias'), 'alias');
  assert.equal(normalize('ALIAS'), 'alias');
  assert.equal(normalize('off'), false);
  assert.equal(normalize('0'), false);
});

test('the flag is sticky and gates the env that the entrypoint hook reads', () => {
  assert.equal(uunpm.flags.uunpm.sticky, true);
  const log = () => {};
  assert.deepEqual(uunpm.runArgs({ cfg: {}, log }), []);
  assert.deepEqual(uunpm.runArgs({ cfg: { uunpm: 'on' }, log }), ['-e', 'SANDBOX_UUNPM=on']);
  assert.deepEqual(uunpm.runArgs({ cfg: { uunpm: 'alias' }, log }), ['-e', 'SANDBOX_UUNPM=alias']);
});

test('uunpm runs after npmrc so it can append to the ~/.npmrc that hook writes', () => {
  assert.ok(uunpm.order > 45, `expected order > 45, got ${uunpm.order}`);
});

test('the egress hole opens with the feature, not by hand', () => {
  assert.deepEqual(uunpm.egressPresets({}), []);
  assert.deepEqual(uunpm.egressPresets({ uunpm: 'on' }), ['uunpm']);
  assert.deepEqual(uunpm.egressPresets({ uunpm: 'alias' }), ['uunpm']);
});

test('collectPresets unions plugin-contributed presets with the policy, deduped', () => {
  const plugins = [
    { name: 'uunpm', egressPresets: (cfg) => (cfg.uunpm ? ['uunpm'] : []) },
    { name: 'other' },                                     // no hook at all
    { name: 'dup', egressPresets: () => ['anthropic'] },    // already in policy
  ];
  assert.deepEqual(collectPresets({ uunpm: 'on' }, ['anthropic'], plugins),
    ['anthropic', 'uunpm']);
  assert.deepEqual(collectPresets({}, ['anthropic'], plugins), ['anthropic']);
  // no policy at all still gets whatever the features themselves need
  assert.deepEqual(collectPresets({ uunpm: 'on' }, [], plugins), ['uunpm', 'anthropic']);
});
