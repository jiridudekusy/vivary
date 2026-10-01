// Unit tests for persistent containers: the config snapshot that guards a
// restart against silently-ignored flag changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerConfigSnapshot, diffContainerConfig, formatConfigChanges,
} from '../core/sandbox.mjs';

const PLUGINS = [
  { name: 'docker', flags: { docker: { type: 'boolean', sticky: true, cfgKey: 'docker' } } },
  { name: 'uunpm', flags: { uunpm: { type: 'optional', sticky: true, cfgKey: 'uunpm' } } },
  { name: 'mounts', flags: { volume: { type: 'list', sticky: true, cfgKey: 'volumes' } } },
  // not sticky -> not part of the container's identity
  { name: 'transient', flags: { editor: { type: 'string' } } },
];

test('the snapshot covers sticky flags plus the sizing knobs', () => {
  const cfg = {
    runtime: 'container', workspace: '/w', docker: true, uunpm: 'on', volumes: ['/a:/a'],
  };
  const snap = containerConfigSnapshot(cfg, { memory: '8g', cpus: '6' }, PLUGINS);
  assert.deepEqual(snap, {
    memory: '8g', cpus: '6', runtime: 'container', workspace: '/w',
    docker: true, uunpm: 'on', volumes: ['/a:/a'],
  });
  assert.ok(!('editor' in snap), 'non-sticky flags must not enter the snapshot');
});

test('unset sticky flags normalize to false, so absent and off compare equal', () => {
  const a = containerConfigSnapshot({ runtime: 'container', workspace: '/w' }, {}, PLUGINS);
  const b = containerConfigSnapshot(
    { runtime: 'container', workspace: '/w', docker: false, uunpm: false, volumes: false },
    {}, PLUGINS,
  );
  assert.deepEqual(diffContainerConfig(a, b), []);
});

test('defaults match what buildRunSpec would use', () => {
  const snap = containerConfigSnapshot({ runtime: 'docker', workspace: '/w' }, {}, []);
  assert.equal(snap.memory, '4g');
  assert.equal(snap.cpus, '4');
});

test('a changed flag is reported with both sides', () => {
  const saved = { memory: '4g', docker: false };
  const current = { memory: '8g', docker: true };
  assert.deepEqual(diffContainerConfig(saved, current), [
    { key: 'docker', from: false, to: true },
    { key: 'memory', from: '4g', to: '8g' },
  ]);
});

test('list-valued flags compare by content, not identity', () => {
  assert.deepEqual(diffContainerConfig({ volumes: ['/a'] }, { volumes: ['/a'] }), []);
  assert.equal(diffContainerConfig({ volumes: ['/a'] }, { volumes: ['/a', '/b'] }).length, 1);
});

test('a container from before snapshots existed makes no claim', () => {
  // No saved snapshot -> no diff, so an older kept container still restarts
  // instead of being declared "changed" on the strength of missing data.
  assert.deepEqual(diffContainerConfig(undefined, { docker: true }), []);
  assert.deepEqual(diffContainerConfig(null, { docker: true }), []);
});

test('the change report names the flag and both values', () => {
  const out = formatConfigChanges(diffContainerConfig({ docker: false }, { docker: true }));
  assert.match(out, /docker: false -> true/);
});
