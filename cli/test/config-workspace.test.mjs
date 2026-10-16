// Which workspace's .vivary.json applies. It used to be the current directory,
// so `vivary resume` (which runs `up --name <each>` from wherever it was
// started) skipped every sandbox's own file and fell back to the global
// defaults — agent-sandbox ran on 8g/6 while its approved file said 4g/4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configWorkspace } from '../core/lifecycle.mjs';

const existing = { name: 'agent-sandbox', workspace: '/Users/x/work/agent-sandbox' };

test('an existing sandbox uses its own workspace, wherever the command runs', () => {
  assert.equal(configWorkspace({ cwd: '/Users/x', existing }), '/Users/x/work/agent-sandbox');
  assert.equal(configWorkspace({ cwd: '/Users/x/work/other-project', existing }), '/Users/x/work/agent-sandbox');
});

test('a matching --workspace is fine; a different one is an error', () => {
  assert.equal(configWorkspace({ cliWorkspace: '/Users/x/work/agent-sandbox/', cwd: '/', existing }),
    '/Users/x/work/agent-sandbox');
  assert.throws(() => configWorkspace({ cliWorkspace: '/Users/x/work/other', cwd: '/', existing }),
    /'agent-sandbox' belongs to \/Users\/x\/work\/agent-sandbox, not \/Users\/x\/work\/other/);
});

test('a new sandbox takes --workspace, else the current directory', () => {
  assert.equal(configWorkspace({ cliWorkspace: '/w/new', cwd: '/elsewhere', existing: null }), '/w/new');
  assert.equal(configWorkspace({ cwd: '/w/here', existing: null }), '/w/here');
});
