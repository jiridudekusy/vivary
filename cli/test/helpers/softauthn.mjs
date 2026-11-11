// A software WebAuthn authenticator for tests: a real P-256 key, real CBOR,
// real signatures, so @simplewebauthn's own checks run against it.
import crypto from 'node:crypto';

export const TEST_ORIGIN = 'https://mac.tail0.ts.net:8737';
const b64u = (b) => Buffer.from(b).toString('base64url');

export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export class SoftAuthenticator {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    this.credId = crypto.randomBytes(16);
    this.id = b64u(this.credId);
  }

  authData(rpId, flags, attested) {
    const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.alloc(4)];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, this.cose);
    }
    return Buffer.concat(parts);
  }

  create(options, { origin = TEST_ORIGIN, uv = true } = {}) {
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40; // UP, UV, AT
    const attestation = cbor({ fmt: 'none', attStmt: {}, authData: this.authData(options.rp.id, flags, true) });
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation), transports: ['internal'] },
    };
  }

  get(options, { origin = TEST_ORIGIN, uv = true } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const ad = this.authData(options.rpId, 0x01 | (uv ? 0x04 : 0), false);
    const sig = crypto.sign('sha256', Buffer.concat([ad, crypto.createHash('sha256').update(clientData).digest()]), this.key);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig) },
    };
  }
}
