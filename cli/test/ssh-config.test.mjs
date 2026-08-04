import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sshConfigBlock, managedHostName, managedHostEntry, knownHostsTarget, withoutKnownHostsTarget,
  removeBlock, upsertBlock, extractManagedBlocks, withIncludeDirective,
} from '../plugins/ssh/plugin.mjs';

const block = (name, host = '10.0.0.1', tool = 'vivary') => [
  `# >>> claude-sandbox:${name} (managed by ${tool}) >>>`,
  `Host claude-sandbox-${name}`,
  `    HostName ${host}`,
  `# <<< claude-sandbox:${name} <<<`,
  '',
].join('\n');

test('sshConfigBlock renders a marker-delimited Host block (container default: hostAlias claude-sandbox-<name>, user agent)', () => {
  const block = sshConfigBlock({
    name: 'demo', hostAlias: 'claude-sandbox-demo', host: '192.168.65.2', user: 'agent', port: '22',
    identityFile: '/s/demo/ssh/id_ed25519', knownHosts: '/h/.ssh/known_hosts',
  });
  assert.match(block, /^# >>> claude-sandbox:demo \(managed by vivary\) >>>$/m);
  assert.match(block, /^Host claude-sandbox-demo$/m);
  assert.match(block, /^ {4}HostName 192\.168\.65\.2$/m);
  assert.match(block, /^ {4}User agent$/m);
  assert.match(block, /^ {4}Port 22$/m);
  assert.match(block, /^ {4}IdentityFile \/s\/demo\/ssh\/id_ed25519$/m);
  assert.match(block, /^ {4}IdentitiesOnly yes$/m);
  assert.match(block, /^# <<< claude-sandbox:demo <<<$/m);
});

test('sshConfigBlock renders a custom hostAlias (tart instance name) and user (admin)', () => {
  const block = sshConfigBlock({
    name: 'demo', hostAlias: 'vivary-demo', host: '192.168.65.5', user: 'admin', port: '22',
    identityFile: '/s/demo/ssh/id_ed25519', knownHosts: '/h/.ssh/known_hosts',
  });
  // Markers stay keyed by `name`, not `hostAlias`, so purge (removeSshArtifacts)
  // keeps working the same way regardless of runtime.
  assert.match(block, /^# >>> claude-sandbox:demo \(managed by vivary\) >>>$/m);
  assert.match(block, /^Host vivary-demo$/m);
  assert.match(block, /^ {4}HostName 192\.168\.65\.5$/m);
  assert.match(block, /^ {4}User admin$/m);
  assert.match(block, /^ {4}Port 22$/m);
  assert.match(block, /^ {4}IdentityFile \/s\/demo\/ssh\/id_ed25519$/m);
  assert.match(block, /^ {4}IdentitiesOnly yes$/m);
  assert.match(block, /^ {4}UserKnownHostsFile \/h\/\.ssh\/known_hosts$/m);
  assert.match(block, /^# <<< claude-sandbox:demo <<<$/m);
});

test('managedHostName extracts the HostName from the managed block', () => {
  const cfg = [
    '# >>> claude-sandbox:demo (managed by vivary) >>>',
    'Host vivary-demo',
    '    HostName 192.168.65.2',
    '    User admin',
    '# <<< claude-sandbox:demo <<<',
    '',
  ].join('\n');
  assert.equal(managedHostName(cfg, 'demo'), '192.168.65.2');
  assert.equal(managedHostName(cfg, 'other'), null);
  assert.equal(managedHostName('', 'demo'), null);
});

test('removeBlock drops only the named block, any tool generation', () => {
  const text = `HEADER\n\n${block('demo')}\n${block('other')}\n${block('old', '10.0.0.9', 'sandbox.sh')}`;
  const kept = removeBlock(text, 'demo');
  assert.ok(!kept.includes('claude-sandbox:demo'));
  assert.ok(kept.includes('claude-sandbox:other'));
  assert.ok(kept.includes('HEADER'));
  assert.ok(!removeBlock(text, 'old').includes('claude-sandbox:old'));
  assert.equal(removeBlock(text, 'nope'), text);
  // No blank-line pile-up where the block used to be.
  assert.ok(!kept.includes('\n\n\n'));
  assert.ok(!removeBlock(`${block('demo')}\n${block('other')}`, 'demo').startsWith('\n'));
});

test('removeBlock terminates on an unterminated block', () => {
  const text = '# >>> claude-sandbox:demo (managed by vivary) >>>\nHost claude-sandbox-demo\n';
  assert.ok(!removeBlock(text, 'demo').includes('>>>'));
});

test('upsertBlock replaces an existing block and keeps header + siblings', () => {
  const text = `# header\n\n${block('demo', '10.0.0.1')}\n${block('other', '10.0.0.2')}`;
  const next = upsertBlock(text, 'demo', block('demo', '127.0.0.1'));
  assert.ok(next.includes('# header'));
  assert.ok(next.includes('claude-sandbox:other'));
  assert.match(next, /HostName 127\.0\.0\.1/);
  assert.ok(!next.includes('HostName 10.0.0.1'));
  assert.equal(next.match(/claude-sandbox:demo \(managed/g).length, 1);
});

test('upsertBlock appends into an empty file without leading blank lines', () => {
  assert.equal(upsertBlock('', 'demo', block('demo')), block('demo'));
});

test('extractManagedBlocks returns each managed block verbatim, skipping unterminated ones', () => {
  const text = `Host mine\n    User me\n\n${block('demo')}\n${block('old', '10.0.0.9', 'sbx')}\n`
    + '# >>> claude-sandbox:broken (managed by vivary) >>>\nHost broken\n';
  const found = extractManagedBlocks(text);
  assert.deepEqual(found.map((f) => f.name), ['demo', 'old']);
  assert.equal(found[0].block, block('demo'));
  assert.ok(found[1].block.includes('managed by sbx'));
});

test('withIncludeDirective prepends the Include block and is idempotent', () => {
  const user = 'Host *\n    UserKnownHostsFile /dev/null\n';
  const once = withIncludeDirective(user, '/s/ssh/config');
  assert.match(once, /^# >>> vivary ssh include \(managed by vivary\) >>>\nInclude \/s\/ssh\/config\n# <<< vivary ssh include <<<\n/);
  assert.ok(once.includes(user));
  assert.equal(withIncludeDirective(once, '/s/ssh/config'), once);
});

test('withIncludeDirective moves an existing block back to the top and retargets it', () => {
  const stale = `Host mine\n# >>> vivary ssh include (managed by vivary) >>>\nInclude /old/ssh/config\n# <<< vivary ssh include <<<\nHost other\n`;
  const next = withIncludeDirective(stale, '/new/ssh/config');
  assert.ok(next.startsWith('# >>> vivary ssh include'));
  assert.ok(!next.includes('/old/ssh/config'));
  assert.equal(next.match(/vivary ssh include \(managed/g).length, 1);
  assert.ok(next.includes('Host mine') && next.includes('Host other'));
});

test('managedHostEntry reads HostName + Port (defaulting to 22) from the block', () => {
  const cfg = sshConfigBlock({
    name: 'demo', hostAlias: 'claude-sandbox-demo', host: 'localhost', user: 'agent', port: '2222',
    identityFile: '/s/demo/ssh/id_ed25519', knownHosts: '/h/.ssh/known_hosts',
  });
  assert.deepEqual(managedHostEntry(cfg, 'demo'), { host: 'localhost', port: '2222' });
  assert.equal(managedHostEntry(cfg, 'other'), null);
  // Port line missing (hand-edited block) — ssh's own default applies.
  const noPort = cfg.split('\n').filter((l) => !l.startsWith('    Port')).join('\n');
  assert.deepEqual(managedHostEntry(noPort, 'demo'), { host: 'localhost', port: '22' });
});

test('knownHostsTarget matches how ssh keys the entry', () => {
  assert.equal(knownHostsTarget('claude-sandbox-demo.local', '22'), 'claude-sandbox-demo.local');
  assert.equal(knownHostsTarget('localhost', 2222), '[localhost]:2222');
});

test('withoutKnownHostsTarget drops only the line keyed by the given target', () => {
  const kh = [
    '192.168.65.2 ssh-ed25519 AAAAother',
    'claude-sandbox-demo.vivary.local ssh-ed25519 AAAAcname',
    '192.168.65.9 ssh-ed25519 AAAAkeep',
  ].join('\n');
  const kept = withoutKnownHostsTarget(kh, '192.168.65.2');
  assert.ok(!kept.includes('192.168.65.2'));
  assert.ok(kept.includes('claude-sandbox-demo.vivary.local'));
  assert.ok(kept.includes('192.168.65.9'));
});
