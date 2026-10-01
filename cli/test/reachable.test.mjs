// `vivary up` must leave something to attach to. Before ssh became a flag it
// was always on — including the host-side ssh_config/known_hosts edits — which
// broke "no flag -> no feature"; these cover the gate and the migration that
// keeps pre-flag sandboxes working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireReachable } from '../core/lifecycle.mjs';
import ssh, { inferLegacySsh } from '../plugins/ssh/plugin.mjs';

const noPlugins = [];

test('tailscale alone is enough', () => {
  assert.doesNotThrow(() => requireReachable({ name: 'a', tailscale: true }, noPlugins));
});

test('ssh alone is enough', () => {
  assert.doesNotThrow(() => requireReachable({ name: 'a', ssh: true }, noPlugins));
});

test('both together are fine', () => {
  assert.doesNotThrow(() => requireReachable({ name: 'a', ssh: true, tailscale: true }, noPlugins));
});

test('a sandbox nothing can reach is refused, and the message says how to fix it', () => {
  const errs = [];
  const orig = console.error;
  const exit = process.exit;
  console.error = (m) => errs.push(m);
  process.exit = () => { throw new Error('exited'); };
  try {
    assert.throws(() => requireReachable({ name: 'lonely' }, noPlugins), /exited/);
  } finally {
    console.error = orig;
    process.exit = exit;
  }
  const msg = errs.join('\n');
  assert.match(msg, /no way in/);
  assert.match(msg, /--ssh/);
  assert.match(msg, /--tailscale/);
  assert.match(msg, /vivary shell/);   // the escape hatch must be offered too
});

test('a pre-flag sandbox is inferred from its existing keypair, not refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-ssh-'));
  fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ssh/id_ed25519'), 'x');
  const cfg = { name: 'legacy' };
  const saved = [];
  assert.equal(inferLegacySsh(cfg, dir, (c) => saved.push(c.ssh)), true);
  assert.equal(cfg.ssh, true, 'the inference must be persisted, not re-derived every start');
  assert.deepEqual(saved, [true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh sandbox infers nothing — the choice stays explicit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-ssh-'));
  const cfg = { name: 'fresh' };
  assert.equal(inferLegacySsh(cfg, dir, () => {}), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit value is never overwritten by inference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-ssh-'));
  fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ssh/id_ed25519'), 'x');
  let saves = 0;
  // Turned off on purpose: the keypair is still on disk, and must not resurrect it.
  assert.equal(inferLegacySsh({ name: 'x', ssh: false }, dir, () => { saves += 1; }), false);
  assert.equal(saves, 0, 'nothing changed, so nothing should be written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ssh is a sticky flag so the choice is made once', () => {
  assert.equal(ssh.flags.ssh.sticky, true);
  assert.equal(ssh.flags.ssh.cfgKey, 'ssh');
});
