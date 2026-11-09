// The metadata plaintext (docs/E2EE.md §5) and its name rules, which are the server's rules for raw names.
import { equal, toBase64 } from './encoding.js';
import { E2EEError } from './errors.js';
import { sha256 } from './primitives.js';

// Path separators, controls (C0, C1), lone surrogates, and the bidi controls and line separators that can disguise an
// extension. Identical to the Worker's init check.
const FORBIDDEN = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069/\\]/u;
const FORBIDDEN_ALL = new RegExp(FORBIDDEN.source, 'gu');
const MAX_NAME = 1024, BLOCK = 512, MAX_PLAINTEXT = 2560;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Length = text => encoder.encode(text).length;
const corrupt = () => new E2EEError('corrupt');

export const validName = name => typeof name === 'string' && name.length > 0 && !/^\.+$/.test(name) && !FORBIDDEN.test(name)
  && utf8Length(name) <= MAX_NAME;

/**
 * The sender's name normalisation (§7 step 1): forbidden code points and lone surrogates become "_", a name of only dots
 * becomes "_", and a name over 1024 UTF-8 bytes loses whole code points before its extension.
 */
export function normalizeName(name) {
  let out = String(name).replace(FORBIDDEN_ALL, '_');
  if (utf8Length(out) > MAX_NAME) {
    const dot = out.lastIndexOf('.');
    let ext = dot > 0 ? out.slice(dot) : '';
    if (utf8Length(ext) >= MAX_NAME) ext = '';
    const points = [...out.slice(0, out.length - ext.length)];
    let size = utf8Length(out);
    while (size > MAX_NAME) size -= utf8Length(points.pop());
    out = points.join('') + ext;
  }
  return out && !/^\.+$/.test(out) ? out : '_';
}

const headSum = async head => toBase64(await sha256(head), true);

/** §5.1: canonical JSON padded with spaces to the next multiple of 512 bytes. */
export async function metaPlaintext(name, size, head) {
  if (!validName(name)) throw new RangeError('Normalise the name first.');
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid size.');
  const text = encoder.encode(JSON.stringify({ v: 1, name, size, headSha256: await headSum(head) }));
  const out = new Uint8Array(Math.ceil(text.length / BLOCK) * BLOCK).fill(0x20);
  out.set(text);
  return out;
}

// §5.3 step 3 is a byte check, so that JS and Rust agree on what counts as another version.
function otherVersion(text) {
  if (text.length < 6 || !equal(text.subarray(0, 5), encoder.encode('{"v":'))) return false;
  let end = 5;
  while (end < text.length && text[end] >= 0x30 && text[end] <= 0x39) end++;
  return end > 5 && (text[end] === 0x2c || text[end] === 0x7d) && !(end === 6 && text[5] === 0x31);
}

/** §5.3 on the decrypted metadata; `plaintextSize` is P(C) of the content object, null where C has none. */
export async function checkMeta(plaintext, head, plaintextSize) {
  if (plaintext.length % BLOCK || plaintext.length > MAX_PLAINTEXT) throw corrupt();
  let end = plaintext.length;
  while (end > 0 && plaintext[end - 1] === 0x20) end--;
  if (plaintext.length - end >= BLOCK) throw corrupt();
  const text = plaintext.subarray(0, end);
  if (otherVersion(text)) throw new E2EEError('unsupported');
  let value;
  try { value = JSON.parse(decoder.decode(text)); } catch { throw corrupt(); }
  // Only \" may occur, which keeps out \ud800 (JSON.parse takes it, serde_json refuses it).
  for (let i = 0; i < text.length; i++) if (text[i] === 0x5c && text[i + 1] !== 0x22) throw corrupt();
  const { name, size } = value ?? {};
  if (typeof value !== 'object' || !validName(name) || !Number.isInteger(size)) throw corrupt();
  if (!equal(encoder.encode(JSON.stringify({ v: 1, name, size, headSha256: await headSum(head) })), text)) throw corrupt();
  if (size !== plaintextSize) throw corrupt();
  return { name, size };
}
