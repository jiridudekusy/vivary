// Readable passwords for the Paseo daemon.
//
// This one is typed by a HUMAN, on a phone, from a screen on another device —
// so a base64 blob is the wrong shape: slow to read, easy to mistype, and
// impossible to dictate. Syllables (consonant+vowel) are pronounceable by
// construction and survive being read aloud.
//
// No composition rules (an uppercase, a digit): those exist to compensate for
// HUMANS choosing badly, and current guidance (NIST SP 800-63B) tells verifiers
// not to impose them. This password comes from a CSPRNG with known entropy, so
// a rule about its shape adds nothing while costing the readability that is the
// whole point. Paseo itself imposes none — `hashDaemonPassword` bcrypts
// whatever it is given.
import { randomInt } from 'node:crypto';

// Picked for unambiguity, not size: no `l` (confusable with 1 and I), none of
// `c q w x y` (read differently in Czech and English), no digits at all.
const CONSONANTS = 'bdfghjkmnprstvz';
const VOWELS = 'aeiou';
const SYLLABLES = CONSONANTS.length * VOWELS.length;   // 75 => 6.23 bits each

// 4 groups of 3 = 74.7 bits in 27 characters. Comparable to a 12-character
// upper/lower/digit/symbol password, and far quicker to type once per device.
export function makeReadablePassword({ groups = 4, syllablesPerGroup = 3, rand = randomInt } = {}) {
  const out = [];
  for (let g = 0; g < groups; g += 1) {
    let word = '';
    for (let s = 0; s < syllablesPerGroup; s += 1) {
      word += CONSONANTS[rand(CONSONANTS.length)] + VOWELS[rand(VOWELS.length)];
    }
    out.push(word);
  }
  return out.join('-');
}

export function passwordEntropyBits({ groups = 4, syllablesPerGroup = 3 } = {}) {
  return Math.log2(SYLLABLES) * groups * syllablesPerGroup;
}

export const PASSWORD_ALPHABET = { CONSONANTS, VOWELS, SYLLABLES };
