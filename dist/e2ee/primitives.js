// The primitives of docs/E2EE.md §4.1: WebCrypto for SHA-256, HMAC, HKDF and X25519, the vendored @noble/ciphers
// for ChaCha20-Poly1305, which WebCrypto doesn't offer.
import { chacha20poly1305 } from '../vendor/noble-ciphers-2.4.0/chacha.js';
import { concat } from './encoding.js';
import { E2EEError } from './errors.js';

const subtle = globalThis.crypto?.subtle;
// Outside a secure context there is no crypto.subtle at all.
const api = () => {
  if (!subtle) throw new E2EEError('platform');
  return subtle;
};
const encoder = new TextEncoder();
const X25519 = { name: 'X25519' };
// WebCrypto imports a private X25519 key only as PKCS #8 or JWK; this is the fixed RFC 8410 prefix for 32 raw bytes.
const PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);
const BASEPOINT = Uint8Array.of(9, ...new Uint8Array(31));
const fromHex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));

async function multiply(scalar, point) {
  const own = await subtle.importKey('pkcs8', concat(PKCS8, scalar), X25519, false, ['deriveBits']);
  const peer = await subtle.importKey('raw', point, X25519, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, own, 256));
}

let probe;
/** Resolves to whether this platform can encrypt and decrypt (secure context, WebCrypto X25519 per RFC 7748 §6.1). */
export function supported() {
  probe ??= (async () => {
    try {
      const alice = await multiply(fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'), BASEPOINT);
      return equalTime(alice, fromHex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'));
    } catch {
      return false;
    }
  })();
  return probe;
}

/** X25519(scalar, point), or null where the platform refuses the point or the result is all zeros (§4.2 step 5). */
export async function x25519(scalar, point) {
  if (!await supported()) throw new E2EEError('platform');
  let shared;
  try { shared = await multiply(scalar, point); } catch { return null; }
  return shared.some(byte => byte) ? shared : null;
}

export async function publicKey(scalar) {
  const point = await x25519(scalar, BASEPOINT);
  if (!point) throw new E2EEError('corrupt');
  return point;
}

export async function hkdf(ikm, salt, info) {
  const key = await api().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await api().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, key, 256));
}

export async function hmac(key, data) {
  const handle = await api().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await api().sign('HMAC', handle, data));
}

/** Compares without an early exit, so the time doesn't depend on where two MACs differ. */
export function equalTime(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const sha256 = async data => new Uint8Array(await api().digest('SHA-256', data));
export const random = length => crypto.getRandomValues(new Uint8Array(length));
export const seal = (key, nonce, plaintext, output) => chacha20poly1305(key, nonce).encrypt(plaintext, output);

/** ChaCha20-Poly1305 decryption; null when the tag doesn't verify. */
export function open(key, nonce, ciphertext) {
  try {
    return chacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch (error) {
    if (error?.message === 'invalid tag') return null;
    throw error;
  }
}
