// Unit tests for pinning network installs into the image build: an unpinned
// `curl install.sh | bash` lives in a cached layer and silently keeps whatever
// version was current when that layer was first built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeVersion, resolveClaudeVersion } from '../plugins/agent-claude/plugin.mjs';
import { collectBuildArgs } from '../core/build.mjs';

const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('parseClaudeVersion accepts versions and rejects noise', () => {
  assert.equal(parseClaudeVersion('2.1.220\n'), '2.1.220');
  assert.equal(parseClaudeVersion('2.1.220-beta.1'), '2.1.220-beta.1');
  assert.equal(parseClaudeVersion('<html>404</html>'), null);
  assert.equal(parseClaudeVersion(''), null);
  assert.equal(parseClaudeVersion(undefined), null);
});

test('a channel is resolved to the concrete version it points at', () => {
  let asked = null;
  const fetchText = (url) => { asked = url; return { status: 0, stdout: '2.1.220\n', stderr: '' }; };
  assert.equal(resolveClaudeVersion('latest', fetchText), '2.1.220');
  assert.match(asked, /claude-code-releases\/latest$/);
  assert.equal(resolveClaudeVersion('stable', ok('2.1.212')), '2.1.212');
});

test('an exact version is passed through without a network probe', () => {
  let called = false;
  const fetchText = () => { called = true; return { status: 1, stdout: '', stderr: '' }; };
  assert.equal(resolveClaudeVersion('2.0.9', fetchText), '2.0.9');
  assert.equal(called, false);
});

test('a failed probe warns and degrades to the channel name, never fails the build', () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(resolveClaudeVersion('latest', () => ({ status: 7, stdout: '', stderr: 'no net' })), 'latest');
    // an HTML error page must not be mistaken for a version
    assert.equal(resolveClaudeVersion('latest', ok('<html>oops</html>')), 'latest');
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 2);
  assert.match(errs[0], /could not resolve the Claude Code 'latest' version/);
});

test('collectBuildArgs renders every plugin contribution as --build-arg', () => {
  const plugins = [
    { name: 'a', buildArgs: () => ({ FOO: '1', BAR: 'x' }) },
    { name: 'b' }, // no hook
    { name: 'c', buildArgs: () => ({}) },
  ];
  assert.deepEqual(collectBuildArgs(plugins),
    ['--build-arg', 'FOO=1', '--build-arg', 'BAR=x']);
});

test('collectBuildArgs is empty when no plugin pins anything', () => {
  assert.deepEqual(collectBuildArgs([{ name: 'a' }]), []);
});
