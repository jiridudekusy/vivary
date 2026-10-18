// Unit tests for the pure config functions (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWriteBack, configHash, parseConfig, unifiedDiff, validateConfig,
} from '../core/config.mjs';

// Entries are either a bare type string (as before) or a full plugin flag def —
// validateConfig accepts both, and only a def can declare `list`.
const KNOWN_FLAGS = {
  egress: 'boolean',
  sudo: 'boolean',
  'host-open': 'boolean',
  'node-modules': { type: 'optional', list: true },
  publish: { type: 'list' },
};

// --- validateConfig -------------------------------------------------------------

test('validateConfig accepts the documented schema', () => {
  validateConfig({
    agent: 'claude', runtime: 'container', memory: '8g', cpus: '6',
    flags: { egress: true, sudo: false, 'node-modules': 6 },
    egress: { presets: ['anthropic'], allow: ['https://registry.npmjs.org/*'] },
  }, { knownFlags: KNOWN_FLAGS });
});

test('validateConfig accepts a list flag as an array or a single string', () => {
  validateConfig({ flags: { publish: ['8080:80', '3000'] } }, { knownFlags: KNOWN_FLAGS });
  validateConfig({ flags: { publish: '8080:80' } }, { knownFlags: KNOWN_FLAGS });
  assert.throws(() => validateConfig({ flags: { publish: [8080] } }, { knownFlags: KNOWN_FLAGS }),
    /flag 'publish' has invalid value \[8080\] \(expected a string or an array of strings\)/);
});

test('validateConfig accepts an array of dirs for node-modules (list: true)', () => {
  validateConfig({ flags: { 'node-modules': ['.', 'apps/web'] } }, { knownFlags: KNOWN_FLAGS });
  // ...but a list is NOT allowed for a flag that did not opt in
  assert.throws(() => validateConfig({ flags: { sudo: ['x'] } }, { knownFlags: KNOWN_FLAGS }),
    /flag 'sudo' has invalid value/);
});

test('validateConfig names the new flag when an old (renamed) one is used', () => {
  assert.throws(() => validateConfig({ flags: { 'own-modules': 4 } }, { knownFlags: KNOWN_FLAGS }),
    /flag 'own-modules' was renamed to 'node-modules'/);
});

test('validateConfig dies loudly on unknown top-level key (typo protection)', () => {
  assert.throws(() => validateConfig({ agnet: 'claude' }, { knownFlags: KNOWN_FLAGS }),
    /unknown key 'agnet'/);
});

test('validateConfig dies loudly on unknown flag name', () => {
  assert.throws(() => validateConfig({ flags: { egerss: true } }, { knownFlags: KNOWN_FLAGS }),
    /unknown flag 'egerss'/);
});

test('validateConfig rejects egress in the global file', () => {
  assert.throws(
    () => validateConfig({ egress: { allow: [] } }, { scope: 'global', knownFlags: KNOWN_FLAGS }),
    /unknown key 'egress'/);
});

test('validateConfig rejects wrong types', () => {
  assert.throws(() => validateConfig({ memory: 8 }, { knownFlags: KNOWN_FLAGS }), /'memory' must be a string/);
  assert.throws(() => validateConfig({ flags: { egress: 'yes' } }, { knownFlags: KNOWN_FLAGS }),
    /flag 'egress' has invalid value/);
  assert.throws(() => validateConfig({ flags: [] }, { knownFlags: KNOWN_FLAGS }), /'flags' must be an object/);
  assert.throws(() => validateConfig({ egress: { presets: 'anthropic' } }, { knownFlags: KNOWN_FLAGS }),
    /'egress.presets' must be an array of strings/);
  assert.throws(() => validateConfig({ egress: { deny: [] } }, { knownFlags: KNOWN_FLAGS }),
    /unknown key 'egress.deny'/);
  assert.throws(() => validateConfig([], { knownFlags: KNOWN_FLAGS }), /must be a JSON object/);
});

test('parseConfig reports invalid JSON with the file name', () => {
  assert.throws(() => parseConfig('{oops', { file: '/ws/.vivary.json', knownFlags: KNOWN_FLAGS }),
    /\/ws\/\.vivary\.json: invalid JSON/);
});

// --- dockerd / profiles / scopes ------------------------------------------------

test('validateConfig accepts dockerd (daemon.json) in project, global and profile files', () => {
  const dockerd = { 'insecure-registries': ['registry.local:5000'], 'registry-mirrors': ['https://m'] };
  for (const scope of ['project', 'global', 'profile']) {
    assert.doesNotThrow(() => validateConfig({ dockerd }, { scope, knownFlags: KNOWN_FLAGS }));
  }
});

test('validateConfig refuses dockerd.hosts — it would put the Docker API on the network', () => {
  assert.throws(() => validateConfig({ dockerd: { hosts: ['tcp://0.0.0.0:2375'] } }, { knownFlags: KNOWN_FLAGS }),
    /dockerd\.hosts' is not allowed/);
  assert.throws(() => validateConfig({ dockerd: ['x'] }, { knownFlags: KNOWN_FLAGS }), /'dockerd' must be an object/);
});

test('only a project file names profiles, and only by safe names', () => {
  assert.doesNotThrow(() => validateConfig({ profiles: ['base', 'web-1.x'] }, { knownFlags: KNOWN_FLAGS }));
  assert.throws(() => validateConfig({ profiles: ['../etc'] }, { knownFlags: KNOWN_FLAGS }), /profile names/);
  assert.throws(() => validateConfig({ profiles: ['a'] }, { scope: 'profile', knownFlags: KNOWN_FLAGS }),
    /unknown key 'profiles'/);
  assert.throws(() => validateConfig({ profiles: ['a'] }, { scope: 'global', knownFlags: KNOWN_FLAGS }),
    /unknown key 'profiles'/);
});

test('a profile may carry egress policy but not the memory budget', () => {
  assert.doesNotThrow(() => validateConfig({ egress: { presets: ['anthropic'] } }, { scope: 'profile', knownFlags: KNOWN_FLAGS }));
  assert.throws(() => validateConfig({ memoryBudget: '50%' }, { scope: 'profile', knownFlags: KNOWN_FLAGS }), /host policy/);
});

// --- configHash + unifiedDiff ---------------------------------------------------

test('configHash is a sha256 over the raw bytes', () => {
  assert.equal(configHash('{}'),
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.notEqual(configHash('{} '), configHash('{}')); // byte-exact
});

test('unifiedDiff shows additions, removals and context', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc', 'old', 'new');
  assert.match(d, /^--- old\n\+\+\+ new\n/);
  assert.match(d, /\n {2}a\n- b\n\+ B\n {2}c$/);
});

test('unifiedDiff against empty shows the whole file as added', () => {
  const d = unifiedDiff('', 'x\ny');
  assert.match(d, /\n\+ x\n\+ y$/);
  assert.doesNotMatch(d, /\n- /);
});

// --- computeWriteBack -----------------------------------------------------------

const STICKY = ['egress', 'sudo', 'host-open', 'node-modules', 'publish'];

test('write-back adds a newly enabled CLI flag (union)', () => {
  const { config, changed } = computeWriteBack(
    { flags: { egress: true } }, { sudo: true }, STICKY);
  assert.equal(changed, true);
  assert.deepEqual(config.flags, { egress: true, sudo: true });
});

test('write-back never removes or downgrades (falsy CLI values skipped)', () => {
  const { config, changed } = computeWriteBack(
    { flags: { egress: true, sudo: true } }, { egress: false, 'node-modules': 0 }, STICKY);
  assert.equal(changed, false);
  assert.deepEqual(config.flags, { egress: true, sudo: true });
});

test('write-back unions list flags item-wise instead of replacing them', () => {
  const { config, changed } = computeWriteBack(
    { flags: { publish: ['8080:80'] } }, { publish: ['3000:3000'] }, STICKY);
  assert.equal(changed, true);
  assert.deepEqual(config.flags.publish, ['8080:80', '3000:3000']);
});

test('write-back is a no-op when every CLI list item is already in the file', () => {
  const { changed } = computeWriteBack(
    { flags: { publish: ['8080:80', '3000'] } }, { publish: ['3000'] }, STICKY);
  assert.equal(changed, false); // reference compare would rewrite the file here
});

test('write-back promotes a single-string list value to an array on merge', () => {
  const { config } = computeWriteBack(
    { flags: { publish: '8080:80' } }, { publish: ['3000'] }, STICKY);
  assert.deepEqual(config.flags.publish, ['8080:80', '3000']);
});

test('write-back updates differing memory/cpus/agent from CLI', () => {
  const { config, changed } = computeWriteBack(
    { agent: 'claude', memory: '4g' }, { memory: '8g', cpus: '6' }, STICKY);
  assert.equal(changed, true);
  assert.equal(config.memory, '8g');
  assert.equal(config.cpus, '6');
  assert.equal(config.agent, 'claude');
});

test('write-back is a no-op when the file already has everything', () => {
  const { changed } = computeWriteBack(
    { memory: '8g', flags: { egress: true } }, { memory: '8g', egress: true }, STICKY);
  assert.equal(changed, false);
});

test('write-back does not touch the egress policy section', () => {
  const { config } = computeWriteBack(
    { egress: { presets: ['anthropic'], allow: [] } }, { sudo: true }, STICKY);
  assert.deepEqual(config.egress, { presets: ['anthropic'], allow: [] });
});
