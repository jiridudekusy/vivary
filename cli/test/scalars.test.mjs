// memory/cpus are sticky: `--memory 20g` once must keep meaning 20g. Before
// this, a flagless `up` fell back to the global default — and because the
// persistent container's snapshot records the size, that surfaced as `up`
// REFUSING to start ("memory: 20g -> 8g"), not as a quiet downgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScalars } from '../core/lifecycle.mjs';

test('a CLI flag wins over everything', () => {
  const f = resolveScalars({ memory: '20g' }, { memory: '6g' }, { memory: '12g' }, { memory: '8g' });
  assert.equal(f.memory, '20g');
});

test('the sticky value survives a flagless run', () => {
  const f = resolveScalars({}, undefined, { memory: '20g', cpus: '6' }, {});
  assert.equal(f.memory, '20g');
  assert.equal(f.cpus, '6');
});

test('the sticky value BEATS the global default — the whole point', () => {
  // ~/.vivary/vivary.json says 8g; this sandbox was explicitly given 20g.
  const f = resolveScalars({}, undefined, { memory: '20g' }, { memory: '8g' });
  assert.equal(f.memory, '20g');
});

test('a project .vivary.json still outranks the sticky value', () => {
  const f = resolveScalars({}, { memory: '6g' }, { memory: '20g' }, { memory: '8g' });
  assert.equal(f.memory, '6g');
});

test('the global default applies when the sandbox said nothing', () => {
  assert.equal(resolveScalars({}, undefined, {}, { memory: '8g' }).memory, '8g');
});

test('nothing anywhere leaves it undefined for buildRunSpec to default', () => {
  assert.equal(resolveScalars({}, undefined, {}, {}).memory, undefined);
});

test('agent skips the sticky tier (cmdStart reads it from sandbox.json)', () => {
  const f = resolveScalars({}, undefined, { agent: 'codex' }, { agent: 'claude' });
  assert.equal(f.agent, 'claude');
});

test('memory and cpus resolve independently', () => {
  const f = resolveScalars({ cpus: '2' }, undefined, { memory: '20g', cpus: '6' }, {});
  assert.equal(f.cpus, '2');
  assert.equal(f.memory, '20g');
});
