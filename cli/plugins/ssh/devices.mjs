// Device keys: ONE keypair per client device (iPad, phone, another laptop)
// instead of one per sandbox.
//
// The per-sandbox keypair stays — on the Mac it is invisible plumbing, wired up
// by the managed ssh_config `IdentityFile`. The pain it causes is off-host: an
// iPad had to import a separate private key for every single sandbox. A device
// key is registered once and merged into EVERY sandbox's authorized_keys, so a
// new sandbox is reachable from that device with no extra enrolment.
//
// Registry: ~/.vivary/devices/<name>.pub — public keys only, one per file.
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOXES_DIR, die, sanitizeName } from '../../core/util.mjs';

export const DEVICES_DIR = path.join(SANDBOXES_DIR, 'devices');

// Key types OpenSSH accepts in authorized_keys. sk-* are FIDO2/hardware keys.
const KEY_TYPES = [
  'ssh-ed25519', 'ssh-rsa', 'ssh-dss',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
];

// Validate ONE authorized_keys line. Returns the normalized line.
// THROWS rather than die()s: die() exits the process, which makes the rule set
// untestable — the caller turns the message into a loud death.
// Pasting a PRIVATE key here is the classic mistake (the file next to the .pub
// one), so that gets its own message rather than a generic parse error — and it
// must never be written into a registry that is copied into every sandbox.
export function parsePublicKey(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('empty key');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) {
    throw new Error('that is a PRIVATE key — register the .pub file instead '
      + '(never share the private half)');
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`expected exactly one public key, got ${lines.length} lines`);

  const parts = lines[0].split(/\s+/);
  // An authorized_keys line may carry leading options (from="…",no-pty,…).
  // We refuse them: options are a policy surface we would be copying into every
  // sandbox unreviewed, and nothing in this flow needs them.
  if (!KEY_TYPES.includes(parts[0])) {
    throw new Error(`unsupported key type '${parts[0]}' (expected one of: ${KEY_TYPES.join(', ')})`
      + '\n    Note: authorized_keys options (from=..., command=...) are not accepted here.');
  }
  if (!parts[1] || !/^[A-Za-z0-9+/]+=*$/.test(parts[1])) throw new Error('malformed key body (not base64)');
  return parts.slice(0, 3).join(' ');   // type, body, optional comment
}

export function deviceFile(name) {
  const safe = sanitizeName(name);
  if (!safe) die(`invalid device name '${name}'`);
  return path.join(DEVICES_DIR, `${safe}.pub`);
}

export function listDevices() {
  if (!fs.existsSync(DEVICES_DIR)) return [];
  return fs.readdirSync(DEVICES_DIR)
    .filter((f) => f.endsWith('.pub'))
    .sort()
    .map((f) => ({
      name: f.slice(0, -4),
      key: fs.readFileSync(path.join(DEVICES_DIR, f), 'utf8').trim(),
    }))
    .filter((d) => d.key);
}

// authorized_keys content for one sandbox: its own key first (that is what the
// Mac's ssh_config points at), then every device key. Deduped by the key BODY,
// not the whole line: the same key registered under two names, or with a
// different trailing comment, must not authorize twice.
export function mergeAuthorizedKeys(sandboxPubkey, devices = listDevices()) {
  const lines = [];
  const seen = new Set();
  const add = (line, label) => {
    const body = line.split(/\s+/)[1];
    if (!body || seen.has(body)) return;
    seen.add(body);
    lines.push(`${line}${label ? ` ${label}` : ''}`);
  };
  if (sandboxPubkey) add(sandboxPubkey.trim(), '');
  for (const d of devices) add(d.key, `vivary-device:${d.name}`);
  return `${lines.join('\n')}\n`;
}
