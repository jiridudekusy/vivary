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

// --- vivary exec: session names and its own option ---
import { sessionName, takeSessionOption } from '../core/lifecycle.mjs';
import { renderExecArgs } from '../core/runtimes/container-cli.mjs';

test('session names come from --session or the program (not its interpreter), socket-safe', () => {
  assert.equal(sessionName(undefined, ['./bin/My Service']), 'my-service');
  assert.equal(sessionName(undefined, ['python3', 'svc.py']), 'svc');
  assert.equal(sessionName(undefined, ['node', '--inspect', 'server.mjs', '--port', '8080']), 'server');
  assert.equal(sessionName(undefined, ['bash']), 'bash');
  assert.equal(sessionName('vault', ['./x']), 'vault');
  assert.equal(sessionName(undefined, []), 'session');
  assert.equal(sessionName('../../etc', ['x']), 'etc');
});

test('--session is taken out before `--`, never after it', () => {
  assert.deepEqual(takeSessionOption(['svc', '--session', 'v', '--publish', '8080', '--', 'run', '--session', 'x']),
    { session: 'v', argv: ['svc', '--publish', '8080', '--', 'run', '--session', 'x'] });
  assert.deepEqual(takeSessionOption(['--session=v', '--', 'a']), { session: 'v', argv: ['--', 'a'] });
});

test('exec modes: terminal (-it), pipe (-i, no tty), none', () => {
  assert.deepEqual(renderExecArgs('c', ['x'], { interactive: true }), ['exec', '-it', 'c', 'x']);
  assert.deepEqual(renderExecArgs('c', ['x'], { stdin: true }), ['exec', '-i', 'c', 'x']);
  assert.deepEqual(renderExecArgs('c', ['x']), ['exec', 'c', 'x']);
});
