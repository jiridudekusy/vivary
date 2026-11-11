// navigator.credentials with the JSON shapes @simplewebauthn/server speaks
// (base64url strings instead of ArrayBuffers). Hand-written instead of
// vendoring @simplewebauthn/browser: the page has no build step.

const toBuf = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (buf) => {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const creds = (list) => (list || []).map((c) => ({ ...c, id: toBuf(c.id) }));

export const passkeysAvailable = () => window.isSecureContext && 'PublicKeyCredential' in window;

export async function createPasskey(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuf(options.challenge),
      user: { ...options.user, id: toBuf(options.user.id) },
      excludeCredentials: creds(options.excludeCredentials),
    },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      attestationObject: toB64u(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

export async function getPasskey(options) {
  const cred = await navigator.credentials.get({
    publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: creds(options.allowCredentials) },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
    },
  };
}

// A cancelled or timed-out prompt is not an error worth shouting about.
export const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';
