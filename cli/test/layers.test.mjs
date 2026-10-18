// How CLI, .vivary.json, the sandbox's own settings, profiles and the default
// file stack (core/layers.mjs), and that sandbox.json never absorbs what only a
// layer said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-layers-'));
process.env.SANDBOXES_DIR = STATE;
const {
  creationSeeds, mergeDockerd, normalizeFlag, profileNames, resolveLayers, stickySet,
} = await import('../core/layers.mjs');
const { applyResolvedFlags, saveSandbox } = await import('../core/sandbox.mjs');

const DEFS = {
  headed: { type: 'boolean', sticky: true },
  sudo: { type: 'boolean', sticky: true },
  'host-open': { type: 'boolean', sticky: true, cfgKey: 'hostOpen' },
  publish: { type: 'list', sticky: true, normalize: (v) => ([].concat(v).length ? [].concat(v) : false) },
  editor: { type: 'string' }, // not sticky: never resolved
};
const prof = (name, config) => ({ name, config });
const flag = (r, f) => r.flags[f];

test('without a project file: sandbox > profiles (last wins) > default', () => {
  const r = resolveLayers({
    defs: DEFS,
    sticky: { headed: false },
    global: { flags: { sudo: true, headed: false } },
    profiles: [prof('a', { flags: { headed: true } }), prof('b', { flags: { headed: false } })],
  });
  assert.deepEqual(flag(r, 'headed'), { key: 'headed', value: false, source: 'profile:b' });
  assert.deepEqual(flag(r, 'sudo'), { key: 'sudo', value: true, source: 'default' });
  assert.ok(!('editor' in r.flags));
});

test('a project file drops the default entirely — but not the profiles', () => {
  const r = resolveLayers({
    defs: DEFS,
    project: { flags: {} },
    global: { memory: '32g', flags: { sudo: true } },
    profiles: [prof('web', { flags: { headed: true } })],
  });
  assert.equal(flag(r, 'sudo').value, undefined);
  assert.equal(flag(r, 'sudo').source, 'built-in');
  assert.equal(r.memory.value, undefined);
  assert.deepEqual(flag(r, 'headed'), { key: 'headed', value: true, source: 'profile:web' });
});

test("the sandbox's own setting beats a profile; a stored false is not a setting", () => {
  const profiles = [prof('p', { flags: { headed: false, 'host-open': true } })];
  const r = resolveLayers({ defs: DEFS, sticky: { headed: true, hostOpen: false }, profiles });
  assert.equal(flag(r, 'headed').source, 'sandbox');
  assert.equal(flag(r, 'headed').value, true);
  // hostOpen false = never mentioned (createSandbox writes false for all)
  assert.deepEqual(flag(r, 'host-open'), { key: 'hostOpen', value: true, source: 'profile:p' });
});

test('an explicit off on the sandbox (flagsOff) beats a profile turning it on', () => {
  const sticky = { headed: false, flagsOff: ['headed'] };
  assert.ok(stickySet(sticky, 'headed'));
  const r = resolveLayers({ defs: DEFS, sticky, profiles: [prof('p', { flags: { headed: true } })] });
  assert.deepEqual(flag(r, 'headed'), { key: 'headed', value: false, source: 'sandbox' });
});

test('project > sandbox, CLI > everything; a project false turns a profile flag off', () => {
  const profiles = [prof('p', { flags: { headed: true, sudo: true } })];
  const r = resolveLayers({
    defs: DEFS, cliFlags: { sudo: 'off' }, project: { flags: { headed: false } }, sticky: { headed: true }, profiles,
  });
  assert.deepEqual(flag(r, 'headed'), { key: 'headed', value: false, source: 'project' });
  assert.deepEqual(flag(r, 'sudo'), { key: 'sudo', value: false, source: 'cli' });
});

test('lists from profiles and the default add to the winning list', () => {
  const r = resolveLayers({
    defs: DEFS,
    sticky: { publish: ['8080'] },
    global: { flags: { publish: '9000' } },
    profiles: [prof('p', { flags: { publish: ['3000', '8080'] } })],
  });
  assert.deepEqual(flag(r, 'publish').value, ['8080', '9000', '3000']);
  assert.equal(flag(r, 'publish').source, 'sandbox + default + profile:p');
  const only = resolveLayers({ defs: DEFS, profiles: [prof('p', { flags: { publish: '3000' } })] });
  assert.deepEqual(flag(only, 'publish'), { key: 'publish', value: ['3000'], source: 'profile:p' });
});

test('dockerd merges key by key across default/profiles/project, arrays as a union', () => {
  assert.deepEqual(
    mergeDockerd({ a: [1], b: { x: 1 }, c: 1 }, { a: [1, 2], b: { y: 2 }, c: 2 }),
    { a: [1, 2], b: { x: 1, y: 2 }, c: 2 },
  );
  const r = resolveLayers({
    defs: DEFS,
    project: { dockerd: { 'insecure-registries': ['b:5000'], debug: true } },
    global: { dockerd: { 'insecure-registries': ['g:5000'] } }, // dropped: project file exists
    profiles: [prof('reg', { dockerd: { 'insecure-registries': ['a:5000'], debug: false } })],
  });
  assert.deepEqual(r.dockerd.value, { 'insecure-registries': ['a:5000', 'b:5000'], debug: true });
  assert.deepEqual(r.dockerd.sources, ['profile:reg', 'project']);
  assert.deepEqual(resolveLayers({ defs: DEFS }).dockerd, { value: {}, sources: [] });
});

test('egress policy unions profiles and the project file; none anywhere is null', () => {
  const r = resolveLayers({
    defs: DEFS,
    project: { egress: { presets: ['anthropic'], allow: ['x.com'] } },
    profiles: [prof('p', { egress: { presets: ['openai', 'anthropic'] } })],
  });
  assert.deepEqual(r.egress, { presets: ['openai', 'anthropic'], allow: ['x.com'] });
  assert.equal(resolveLayers({ defs: DEFS }).egress, null);
});

test('agent/runtime of a NEW sandbox: CLI > last profile > default (no project file)', () => {
  const profiles = [prof('a', { runtime: 'docker' }), prof('b', { agent: 'codex' })];
  assert.deepEqual(creationSeeds({ profiles, global: { agent: 'claude', runtime: 'container' } }),
    { agent: 'codex', runtime: 'docker' });
  assert.deepEqual(creationSeeds({ cliFlags: { runtime: 'tart' }, profiles }), { agent: 'codex', runtime: 'tart' });
  assert.deepEqual(creationSeeds({ project: {}, global: { agent: 'cursor' } }), { agent: undefined, runtime: undefined });
});

test('booleans take on/off from the command line (--headed=off used to mean ON)', () => {
  const def = { type: 'boolean' };
  assert.equal(normalizeFlag(def, 'off'), false);
  assert.equal(normalizeFlag(def, 'false'), false);
  assert.equal(normalizeFlag(def, '0'), false);
  assert.equal(normalizeFlag(def, 'on'), true);
  assert.equal(normalizeFlag(def, true), true);
  assert.equal(normalizeFlag(def, undefined), undefined);
});

test('profile lists: the sandbox\'s own first, then the project\'s, each name once', () => {
  assert.deepEqual(profileNames(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(profileNames(undefined, undefined), []);
});

test('sandbox.json keeps the sandbox\'s own values, not what a layer said', () => {
  fs.mkdirSync(path.join(STATE, 'sb'), { recursive: true });
  const cfg = { name: 'sb', headed: false, hostOpen: true, publish: ['8080'] };
  applyResolvedFlags(cfg, {
    flags: {
      headed: { key: 'headed', value: true, source: 'profile:p' },
      'host-open': { key: 'hostOpen', value: true, source: 'sandbox' },
      publish: { key: 'publish', value: ['8080', '3000'], source: 'sandbox + profile:p' },
      sudo: { key: 'sudo', value: true, source: 'default' },
    },
  });
  assert.equal(cfg.headed, true); // what plugins read this run
  cfg.desiredRunning = true; // an unrelated save
  saveSandbox(cfg);
  const saved = JSON.parse(fs.readFileSync(path.join(STATE, 'sb', 'sandbox.json'), 'utf8'));
  assert.deepEqual(saved, { name: 'sb', headed: false, hostOpen: true, publish: ['8080'], desiredRunning: true });
  // a plugin changing an overlaid key after the overlay is the sandbox's own decision
  cfg.sudo = false;
  saveSandbox(cfg);
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, 'sb', 'sandbox.json'), 'utf8')).sudo, false);
});
