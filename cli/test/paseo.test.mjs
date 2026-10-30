// Paseo plugin: the readable password, and the wiring that must not regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import paseo from '../plugins/paseo/plugin.mjs';
import {
  PASSWORD_ALPHABET, makeReadablePassword, passwordEntropyBits,
} from '../plugins/paseo/password.mjs';

test('the password is typeable: only unambiguous letters and dashes', () => {
  for (let i = 0; i < 200; i += 1) {
    const pw = makeReadablePassword();
    assert.match(pw, /^[bdfghjkmnprstvz aeiou-]+$/.source.replace(' ', '') && /^[a-z-]+$/);
    // The confusable set must never appear: l/1/I/0/O, and letters that are
    // read differently in Czech and English.
    assert.ok(!/[lcqwxy0-9]/.test(pw), `confusable character in ${pw}`);
    assert.ok(!/[A-Z]/.test(pw), 'no mixed case — it costs readability and buys ~0 bits');
  }
});

test('every syllable is consonant+vowel, so it can be pronounced and dictated', () => {
  for (const group of makeReadablePassword().split('-')) {
    assert.match(group, /^(?:[bdfghjkmnprstvz][aeiou]){3}$/);
  }
});

test('default shape is 4 groups of 3 syllables', () => {
  const groups = makeReadablePassword().split('-');
  assert.equal(groups.length, 4);
  assert.equal(groups[0].length, 6);
});

test('entropy is stated, not assumed', () => {
  assert.equal(PASSWORD_ALPHABET.SYLLABLES, 75);
  assert.ok(passwordEntropyBits() > 74, `expected >74 bits, got ${passwordEntropyBits()}`);
  // Comparable to a 12-char upper/lower/digit/symbol password (~78.8 bits),
  // which is the point: same strength, far easier to type.
  assert.ok(passwordEntropyBits({ groups: 3 }) > 55);
});

test('the generator consumes randomness rather than a fixed pattern', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(makeReadablePassword());
  assert.equal(seen.size, 50, 'every generated password must differ');
});

test('an injected RNG makes it deterministic for tests', () => {
  const pw = makeReadablePassword({ rand: () => 0 });
  assert.equal(pw, 'bababa-bababa-bababa-bababa');
});

test('paseo counts as a way into the sandbox', () => {
  assert.equal(paseo.inferReachable({ paseo: true }), true);
  assert.equal(paseo.inferReachable({}), false);
});

test('the flag is sticky, so the choice is made once', () => {
  assert.equal(paseo.flags.paseo.sticky, true);
  assert.equal(paseo.flags.paseo.cfgKey, 'paseo');
});

test('it runs after ssh/tailscale, whose ports and tailnet name it needs', () => {
  assert.ok(paseo.order > 35, `expected order > 35 (tailscale), got ${paseo.order}`);
});

test('--paseo turns --tailscale on instead of failing on an implied flag', () => {
  const cfg = { name: 'x', paseo: true };
  const logged = [];
  paseo.preUp({ cfg, log: (m) => logged.push(m) }, () => {});
  assert.equal(cfg.tailscale, true);
  assert.match(logged.join('\n'), /enabling --tailscale/);
});

test('nothing happens without the flag', () => {
  const cfg = { name: 'x' };
  paseo.preUp({ cfg, log: () => {} }, () => { throw new Error('must not save'); });
  assert.equal(cfg.tailscale, undefined);
  assert.deepEqual(paseo.postUp({ cfg, log: () => {} }), undefined);
});
