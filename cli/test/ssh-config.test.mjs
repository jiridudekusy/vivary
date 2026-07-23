import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshConfigBlock, managedHostName, withoutIpKnownHosts } from '../plugins/ssh/plugin.mjs';

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

test('withoutIpKnownHosts drops only the line keyed by the given IP', () => {
  const kh = [
    '192.168.65.2 ssh-ed25519 AAAAother',
    'claude-sandbox-demo.vivary.local ssh-ed25519 AAAAcname',
    '192.168.65.9 ssh-ed25519 AAAAkeep',
  ].join('\n');
  const kept = withoutIpKnownHosts(kh, '192.168.65.2');
  assert.ok(!kept.includes('192.168.65.2'));
  assert.ok(kept.includes('claude-sandbox-demo.vivary.local'));
  assert.ok(kept.includes('192.168.65.9'));
});
