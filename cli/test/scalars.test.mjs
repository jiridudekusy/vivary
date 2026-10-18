// memory/cpus are sticky: `--memory 20g` once must keep meaning 20g. Before
// this, a flagless `up` fell back to the global default — and because the
// persistent container's snapshot records the size, that surfaced as `up`
// REFUSING to start ("memory: 20g -> 8g"), not as a quiet downgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../core/lifecycle.mjs';
import { resolveLayers } from '../core/layers.mjs';

const scalars = (cliFlags, project, sticky, global, profiles = []) => {
  const r = resolveLayers({ cliFlags, project: project ?? null, sticky, global, profiles });
  return { memory: r.memory.value, cpus: r.cpus.value, agent: r.agent.value };
};

test('a CLI flag wins over everything', () => {
  assert.equal(scalars({ memory: '20g' }, { memory: '6g' }, { memory: '12g' }, { memory: '8g' }).memory, '20g');
});

test('the sticky value survives a flagless run', () => {
  const f = scalars({}, undefined, { memory: '20g', cpus: '6' }, {});
  assert.equal(f.memory, '20g');
  assert.equal(f.cpus, '6');
});

test('the sticky value BEATS the global default — the whole point', () => {
  // ~/.vivary/vivary.json says 8g; this sandbox was explicitly given 20g.
  assert.equal(scalars({}, undefined, { memory: '20g' }, { memory: '8g' }).memory, '20g');
});

test('a project .vivary.json still outranks the sticky value', () => {
  assert.equal(scalars({}, { memory: '6g' }, { memory: '20g' }, { memory: '8g' }).memory, '6g');
});

test('the global default applies when the sandbox said nothing', () => {
  assert.equal(scalars({}, undefined, {}, { memory: '8g' }).memory, '8g');
});

test('nothing anywhere leaves it undefined for buildRunSpec to default', () => {
  assert.equal(scalars({}, undefined, {}, null).memory, undefined);
});

test("the sandbox's own agent beats the global default", () => {
  // findmy: created with --agent=codex, global file says claude
  assert.equal(scalars({}, undefined, { agent: 'codex' }, { agent: 'claude' }).agent, 'codex');
  assert.equal(scalars({ agent: 'cursor' }, undefined, { agent: 'codex' }, {}).agent, 'cursor');
  assert.equal(scalars({}, { agent: 'claude' }, { agent: 'codex' }, {}).agent, 'claude');
});

test("runtime: CLI > project file > the sandbox's own; the global default is not a tier", () => {
  assert.equal(startRuntime({}, undefined, { runtime: 'docker' }), 'docker');
  assert.equal(startRuntime({}, { runtime: 'container' }, { runtime: 'docker' }), 'container');
  assert.equal(startRuntime({ runtime: 'tart' }, { runtime: 'container' }, { runtime: 'docker' }), 'tart');
});

test('memory and cpus resolve independently', () => {
  const f = scalars({ cpus: '2' }, undefined, { memory: '20g', cpus: '6' }, {});
  assert.equal(f.cpus, '2');
  assert.equal(f.memory, '20g');
});

test('a profile sizes a sandbox that said nothing, and loses to one that did', () => {
  const profiles = [{ name: 'big', config: { memory: '16g', cpus: '8' } }];
  assert.equal(scalars({}, undefined, {}, { memory: '8g' }, profiles).memory, '16g');
  assert.equal(scalars({}, undefined, { memory: '20g' }, { memory: '8g' }, profiles).memory, '20g');
  assert.equal(scalars({}, { memory: '6g' }, {}, null, profiles).memory, '6g');
});
