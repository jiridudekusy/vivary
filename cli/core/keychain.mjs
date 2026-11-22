// vivary's own long-lived secrets in the macOS login Keychain (service
// "vivary", one account per secret) instead of files under ~/.vivary.
//
// What this buys, and what not (decided with the user 2026-11-21): encrypted
// at rest, out of backups and disk images, out of reach of every sandbox (they
// cannot talk to the Mac's Keychain). NOT a wall against a process running as
// the user on an unlocked Mac: `security` reads these items without a prompt
// for anyone who asks — macOS gives per-app protection only to signed apps.
//
// Values go in on stdin (never argv, which `ps` shows): `security
// add-generic-password -w` as the LAST option reads the password twice from
// stdin. That read is a password prompt with a 128-byte buffer: a longer value
// was stored CUT OFF without any error (found 2026-11-21 when a JSON blob of
// three keys came back truncated). So values are one line of at most 127
// bytes, and every write is read back before the caller may rely on it.
export const KEYCHAIN_MAX = 127;
import { capture } from './util.mjs';

export const KEYCHAIN_SERVICE = 'vivary';

function check(account, value) {
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(account)) throw new Error(`bad keychain account '${account}'`);
  if (value !== undefined && (/[\r\n]/.test(value) || !value.length)) {
    throw new Error(`keychain value for '${account}' must be one non-empty line`);
  }
  if (value !== undefined && Buffer.byteLength(value) > KEYCHAIN_MAX) {
    throw new Error(`keychain value for '${account}' is longer than ${KEYCHAIN_MAX} bytes`);
  }
}

// The value, or null when there is no such item.
export function keychainGet(account, { run = capture } = {}) {
  check(account);
  const r = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
  if (r.status === 0) return r.stdout.replace(/\n$/, '');
  if (r.status === 44 || /could not be found/.test(r.stderr)) return null; // errSecItemNotFound
  throw new Error(`cannot read '${account}' from the Keychain: ${(r.stderr || r.stdout).trim()}`);
}

export function keychainSet(account, value, { run = capture } = {}) {
  check(account, value);
  const r = run('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account,
    '-l', `vivary: ${account}`, '-w'], { input: `${value}\n${value}\n` });
  if (r.status !== 0) throw new Error(`cannot store '${account}' in the Keychain: ${(r.stderr || r.stdout).trim()}`);
  if (keychainGet(account, { run }) !== value) {
    throw new Error(`the Keychain did not keep '${account}' intact (read back differs)`);
  }
}

export function keychainDelete(account, { run = capture } = {}) {
  check(account);
  run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
}
