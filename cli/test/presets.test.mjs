// Unit tests for egress preset expansion (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, expandPresets } from '../plugins/egress/presets.mjs';

test('expandPresets flattens known presets in order', () => {
  const names = Object.keys(PRESETS);
  assert.deepEqual(expandPresets(names), names.flatMap((n) => PRESETS[n]));
  assert.deepEqual(expandPresets([]), []);
  assert.deepEqual(expandPresets(), []);
});

test('expandPresets dies loudly on an unknown preset name', () => {
  assert.throws(() => expandPresets(['anthropc']),
    /unknown egress preset 'anthropc'.*anthropic/);
});

test('built-in presets are anthropic, openai, cursor', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['anthropic', 'cursor', 'openai']);
});
