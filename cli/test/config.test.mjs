// Unit tests for the pure config functions (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWriteBack, configHash, parseConfig, resolveEffectiveConfig,
  unifiedDiff, validateConfig,
} from '../core/config.mjs';

const KNOWN_FLAGS = {
  egress: 'boolean', sudo: 'boolean', 'host-open': 'boolean', 'own-modules': 'optional',
};

// --- validateConfig -------------------------------------------------------------

test('validateConfig accepts the documented schema', () => {
  validateConfig({
    agent: 'claude', runtime: 'container', memory: '8g', cpus: '6',
    flags: { egress: true, sudo: false, 'own-modules': 6 },
    egress: { presets: ['anthropic'], allow: ['https://registry.npmjs.org/*'] },
  }, { knownFlags: KNOWN_FLAGS });
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

// --- resolveEffectiveConfig -----------------------------------------------------

test('precedence: CLI flags > project file', () => {
  const eff = resolveEffectiveConfig({
    cliFlags: { memory: '16g', sudo: true },
    project: { memory: '8g', cpus: '6', flags: { egress: true, sudo: false } },
  });
  assert.equal(eff.memory, '16g');
  assert.equal(eff.cpus, '6');
  assert.deepEqual(eff.flags, { egress: true, sudo: true });
});

test('precedence: project file completely replaces global defaults (no merging)', () => {
  const eff = resolveEffectiveConfig({
    project: { memory: '8g' },
    global: { memory: '32g', cpus: '10', agent: 'codex', flags: { sudo: true } },
  });
  assert.equal(eff.memory, '8g');
  assert.equal(eff.cpus, undefined); // NOT 10 — global layer is fully replaced
  assert.equal(eff.agent, undefined);
  assert.deepEqual(eff.flags, {}); // global sudo does not leak through
});

test('precedence: global defaults apply only without a project file', () => {
  const eff = resolveEffectiveConfig({
    global: { memory: '32g', flags: { egress: true } },
  });
  assert.equal(eff.memory, '32g');
  assert.deepEqual(eff.flags, { egress: true });
  assert.equal(eff.egress, null); // egress policy is project-scoped
});

test('egress policy comes only from the project file', () => {
  const eff = resolveEffectiveConfig({
    project: { egress: { presets: ['anthropic'], allow: ['x'] } },
  });
  assert.deepEqual(eff.egress, { presets: ['anthropic'], allow: ['x'] });
});

test('no files, no CLI -> everything undefined (built-in defaults apply)', () => {
  const eff = resolveEffectiveConfig({});
  assert.equal(eff.memory, undefined);
  assert.deepEqual(eff.flags, {});
  assert.equal(eff.egress, null);
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

const STICKY = ['egress', 'sudo', 'host-open', 'own-modules'];

test('write-back adds a newly enabled CLI flag (union)', () => {
  const { config, changed } = computeWriteBack(
    { flags: { egress: true } }, { sudo: true }, STICKY);
  assert.equal(changed, true);
  assert.deepEqual(config.flags, { egress: true, sudo: true });
});

test('write-back never removes or downgrades (falsy CLI values skipped)', () => {
  const { config, changed } = computeWriteBack(
    { flags: { egress: true, sudo: true } }, { egress: false, 'own-modules': 0 }, STICKY);
  assert.equal(changed, false);
  assert.deepEqual(config.flags, { egress: true, sudo: true });
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
