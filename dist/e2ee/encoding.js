// Byte helpers and the encodings of docs/E2EE.md: canonical unpadded base64 (Notation), KEY (§3.1) and the age
// identity string (§3.2, Bech32 with the BIP 173 checksum).
import { E2EEError } from './errors.js';

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL = STD.slice(0, 62) + '-_';
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const IDENTITY_HRP = 'age-secret-key-';

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toBase64(bytes, url = false) {
  const table = url ? URL : STD, n = bytes.length;
  let out = '';
  for (let i = 0; i < n; i += 3) {
    const v = bytes[i] << 16 | (i + 1 < n ? bytes[i + 1] << 8 : 0) | (i + 2 < n ? bytes[i + 2] : 0);
    out += table[v >> 18] + table[v >> 12 & 63] + (i + 1 < n ? table[v >> 6 & 63] : '') + (i + 2 < n ? table[v & 63] : '');
  }
  return out;
}

// Canonical only: no padding, no other characters, zero trailing bits; null otherwise. With `length` the text must
// encode exactly that many bytes.
export function fromBase64(text, url = false, length = undefined) {
  if (typeof text !== 'string' || text.length % 4 === 1) return null;
  if (length !== undefined && text.length !== Math.ceil(length * 4 / 3)) return null;
  const table = url ? URL : STD, out = new Uint8Array(text.length * 3 >> 2);
  let acc = 0, bits = 0, at = 0;
  for (let i = 0; i < text.length; i++) {
    const v = table.indexOf(text[i]);
    if (v < 0) return null;
    acc = (acc << 6 | v) & 0xfff; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = acc >> bits & 255; }
  }
  return acc & (1 << bits) - 1 ? null : out;
}

function isIdentity(identity) {
  if (!(identity instanceof Uint8Array) || identity.length !== 32) throw new TypeError('Expected a 32-byte identity.');
  return identity;
}

export const encodeKey = identity => toBase64(isIdentity(identity), true);

export function decodeKey(key) {
  const identity = fromBase64(key, true, 32);
  if (!identity) throw new E2EEError('key_invalid');
  return identity;
}

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = (chk & 0x1ffffff) << 5 ^ v;
    for (let i = 0; i < 5; i++) if (top >> i & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

const expand = hrp => {
  const codes = [...hrp].map(c => c.charCodeAt(0));
  return [...codes.map(c => c >> 5), 0, ...codes.map(c => c & 31)];
};

function regroup(data, from, to, pad) {
  const out = [], mask = (1 << to) - 1;
  let acc = 0, bits = 0;
  for (const v of data) {
    acc = acc << from | v; bits += from;
    while (bits >= to) { bits -= to; out.push(acc >> bits & mask); }
    acc &= (1 << bits) - 1;
  }
  if (pad) { if (bits) out.push(acc << to - bits & mask); }
  else if (bits >= from || acc << to - bits & mask) return null;
  return out;
}

export function bech32(hrp, data) {
  const words = regroup(data, 8, 5, true), check = polymod([...expand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  let out = hrp + '1';
  for (const w of words) out += CHARSET[w];
  for (let i = 0; i < 6; i++) out += CHARSET[check >> 5 * (5 - i) & 31];
  return out;
}

export const encodeAgeIdentity = identity => bech32(IDENTITY_HRP, isIdentity(identity)).toUpperCase();

// BIP 173 limits the string to printable ASCII, so no Unicode case mapping can turn another character into the HRP.
export function decodeAgeIdentity(text) {
  if (typeof text !== 'string' || !/^[!-~]+$/.test(text) || (text !== text.toUpperCase() && text !== text.toLowerCase()))
    throw new E2EEError('key_invalid');
  const lower = text.toLowerCase(), at = lower.lastIndexOf('1');
  if (at < 1 || lower.length - at < 7 || lower.slice(0, at) !== IDENTITY_HRP) throw new E2EEError('key_invalid');
  const words = [...lower.slice(at + 1)].map(c => CHARSET.indexOf(c));
  if (words.includes(-1) || polymod([...expand(IDENTITY_HRP), ...words]) !== 1) throw new E2EEError('key_invalid');
  const data = regroup(words.slice(0, -6), 5, 8, false);
  if (data?.length !== 32) throw new E2EEError('key_invalid');
  return new Uint8Array(data);
}
