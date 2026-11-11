// `vivary set`: what it refuses (layers above the sandbox's own, host-access
// flags) and what it says a change takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEffect, effectOf, planSet, settable } from '../core/settings-cmd.mjs';

const defs = {
  headed: { type: 'boolean', sticky: true, snapshot: false },
  docker: { type: 'boolean', sticky: true },
  uunpm: { type: 'optional', sticky: true },
  publish: { type: 'list', sticky: true },
  volume: { type: 'list', sticky: true },
};
const resolved = (over = {}) => ({
  memory: { value: '8g', source: 'default' },
  cpus: { value: undefined, source: 'built-in' },
  flags: {
    headed: { value: true, source: 'sandbox' },
    docker: { value: true, source: 'project' },
    uunpm: { value: false, source: 'built-in' },
  },
  ...over,
});

test('settable: sticky flags that are not lists (no host ports or paths)', () => {
  assert.deepEqual(Object.keys(defs).filter((k) => settable(defs[k])), ['headed', 'docker', 'uunpm']);
});

test('set refuses what the project file decides, list flags and bad values', () => {
  assert.deepEqual(planSet({ headed: 'off', uunpm: true, memory: '12g', cpus: '6' }, { defs, resolved: resolved() }), []);
  const errs = planSet({ docker: 'off', publish: ['1:1'], nope: true, memory: 'lots', cpus: '0' }, { defs, resolved: resolved() });
  assert.equal(errs.length, 5);
  assert.match(errs.join('\n'), /--docker is set by \.vivary\.json — change it there/);
  assert.match(errs.join('\n'), /--publish is not settable here/);
  assert.match(errs.join('\n'), /unknown setting 'nope'/);
  assert.match(errs.join('\n'), /memory: 'lots' is not a valid size/);
  assert.match(errs.join('\n'), /cpus: '0' is not a valid CPU count/);
  const fromFile = resolved({ memory: { value: '4g', source: 'project' } });
  assert.match(planSet({ memory: '8g' }, { defs, resolved: fromFile })[0], /memory is set by \.vivary\.json/);
});

test('what a change takes: nothing, the next start, a restart, or a rebuild', () => {
  const drift = [{ key: 'memory', from: '4g', to: '8g' }];
  assert.equal(effectOf({ changed: false, drift, exists: true, running: true }), 'none');
  assert.equal(effectOf({ changed: true, drift, exists: false, running: false }), 'next-start');
  assert.equal(effectOf({ changed: true, drift, exists: true, running: false }), 'recreate');
  assert.equal(effectOf({ changed: true, drift: [], exists: true, running: true }), 'restart');
  assert.equal(effectOf({ changed: true, drift: [], exists: true, running: false }), 'next-start');
  assert.match(describeEffect('x', 'recreate', drift), /memory: 4g -> 8g[\s\S]*vivary up x --recreate/);
  assert.match(describeEffect('x', 'restart', []), /vivary down x && vivary up x/);
});
