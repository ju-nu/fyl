// MD5 (RFC 1321) of part buffers for their pins and Content-MD5 (docs/E2EE.md §7 step 4, §8). It only detects that
// bytes changed between attempts; nothing relies on its collision resistance. WebCrypto has no MD5.
import { toBase64 } from './encoding.js';

// Straight-line code: TurboFan's inlining budget doesn't stretch to 64 calls of step helpers, which halves the speed.
// The constants are RFC 1321's sine table as signed 32-bit values.
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

// Blocks [0, end) of data; words are read in place where the platform and alignment allow it.
function blocks(state, data, end) {
  const aligned = LITTLE_ENDIAN && data.byteOffset % 4 === 0;
  const w = aligned ? new Int32Array(data.buffer, data.byteOffset, end >> 2) : new Int32Array(16);
  let [a, b, c, d] = state;
  for (let at = 0; at < end; at += 64) {
    let o = at >> 2;
    if (!aligned) {
      o = 0;
      for (let j = 0, p = at; j < 16; j++, p += 4) w[j] = data[p] | data[p + 1] << 8 | data[p + 2] << 16 | data[p + 3] << 24;
    }
    const a0 = a, b0 = b, c0 = c, d0 = d;
    a = (a + ((b & c) | (~b & d)) + w[o + 0] - 0x28955b88) | 0; a = (a << 7 | a >>> 25) + b | 0;
    d = (d + ((a & b) | (~a & c)) + w[o + 1] - 0x173848aa) | 0; d = (d << 12 | d >>> 20) + a | 0;
    c = (c + ((d & a) | (~d & b)) + w[o + 2] + 0x242070db) | 0; c = (c << 17 | c >>> 15) + d | 0;
    b = (b + ((c & d) | (~c & a)) + w[o + 3] - 0x3e423112) | 0; b = (b << 22 | b >>> 10) + c | 0;
    a = (a + ((b & c) | (~b & d)) + w[o + 4] - 0x0a83f051) | 0; a = (a << 7 | a >>> 25) + b | 0;
    d = (d + ((a & b) | (~a & c)) + w[o + 5] + 0x4787c62a) | 0; d = (d << 12 | d >>> 20) + a | 0;
    c = (c + ((d & a) | (~d & b)) + w[o + 6] - 0x57cfb9ed) | 0; c = (c << 17 | c >>> 15) + d | 0;
    b = (b + ((c & d) | (~c & a)) + w[o + 7] - 0x02b96aff) | 0; b = (b << 22 | b >>> 10) + c | 0;
    a = (a + ((b & c) | (~b & d)) + w[o + 8] + 0x698098d8) | 0; a = (a << 7 | a >>> 25) + b | 0;
    d = (d + ((a & b) | (~a & c)) + w[o + 9] - 0x74bb0851) | 0; d = (d << 12 | d >>> 20) + a | 0;
    c = (c + ((d & a) | (~d & b)) + w[o + 10] - 0x0000a44f) | 0; c = (c << 17 | c >>> 15) + d | 0;
    b = (b + ((c & d) | (~c & a)) + w[o + 11] - 0x76a32842) | 0; b = (b << 22 | b >>> 10) + c | 0;
    a = (a + ((b & c) | (~b & d)) + w[o + 12] + 0x6b901122) | 0; a = (a << 7 | a >>> 25) + b | 0;
    d = (d + ((a & b) | (~a & c)) + w[o + 13] - 0x02678e6d) | 0; d = (d << 12 | d >>> 20) + a | 0;
    c = (c + ((d & a) | (~d & b)) + w[o + 14] - 0x5986bc72) | 0; c = (c << 17 | c >>> 15) + d | 0;
    b = (b + ((c & d) | (~c & a)) + w[o + 15] + 0x49b40821) | 0; b = (b << 22 | b >>> 10) + c | 0;
    a = (a + ((b & d) | (c & ~d)) + w[o + 1] - 0x09e1da9e) | 0; a = (a << 5 | a >>> 27) + b | 0;
    d = (d + ((a & c) | (b & ~c)) + w[o + 6] - 0x3fbf4cc0) | 0; d = (d << 9 | d >>> 23) + a | 0;
    c = (c + ((d & b) | (a & ~b)) + w[o + 11] + 0x265e5a51) | 0; c = (c << 14 | c >>> 18) + d | 0;
    b = (b + ((c & a) | (d & ~a)) + w[o + 0] - 0x16493856) | 0; b = (b << 20 | b >>> 12) + c | 0;
    a = (a + ((b & d) | (c & ~d)) + w[o + 5] - 0x29d0efa3) | 0; a = (a << 5 | a >>> 27) + b | 0;
    d = (d + ((a & c) | (b & ~c)) + w[o + 10] + 0x02441453) | 0; d = (d << 9 | d >>> 23) + a | 0;
    c = (c + ((d & b) | (a & ~b)) + w[o + 15] - 0x275e197f) | 0; c = (c << 14 | c >>> 18) + d | 0;
    b = (b + ((c & a) | (d & ~a)) + w[o + 4] - 0x182c0438) | 0; b = (b << 20 | b >>> 12) + c | 0;
    a = (a + ((b & d) | (c & ~d)) + w[o + 9] + 0x21e1cde6) | 0; a = (a << 5 | a >>> 27) + b | 0;
    d = (d + ((a & c) | (b & ~c)) + w[o + 14] - 0x3cc8f82a) | 0; d = (d << 9 | d >>> 23) + a | 0;
    c = (c + ((d & b) | (a & ~b)) + w[o + 3] - 0x0b2af279) | 0; c = (c << 14 | c >>> 18) + d | 0;
    b = (b + ((c & a) | (d & ~a)) + w[o + 8] + 0x455a14ed) | 0; b = (b << 20 | b >>> 12) + c | 0;
    a = (a + ((b & d) | (c & ~d)) + w[o + 13] - 0x561c16fb) | 0; a = (a << 5 | a >>> 27) + b | 0;
    d = (d + ((a & c) | (b & ~c)) + w[o + 2] - 0x03105c08) | 0; d = (d << 9 | d >>> 23) + a | 0;
    c = (c + ((d & b) | (a & ~b)) + w[o + 7] + 0x676f02d9) | 0; c = (c << 14 | c >>> 18) + d | 0;
    b = (b + ((c & a) | (d & ~a)) + w[o + 12] - 0x72d5b376) | 0; b = (b << 20 | b >>> 12) + c | 0;
    a = (a + (b ^ c ^ d) + w[o + 5] - 0x0005c6be) | 0; a = (a << 4 | a >>> 28) + b | 0;
    d = (d + (a ^ b ^ c) + w[o + 8] - 0x788e097f) | 0; d = (d << 11 | d >>> 21) + a | 0;
    c = (c + (d ^ a ^ b) + w[o + 11] + 0x6d9d6122) | 0; c = (c << 16 | c >>> 16) + d | 0;
    b = (b + (c ^ d ^ a) + w[o + 14] - 0x021ac7f4) | 0; b = (b << 23 | b >>> 9) + c | 0;
    a = (a + (b ^ c ^ d) + w[o + 1] - 0x5b4115bc) | 0; a = (a << 4 | a >>> 28) + b | 0;
    d = (d + (a ^ b ^ c) + w[o + 4] + 0x4bdecfa9) | 0; d = (d << 11 | d >>> 21) + a | 0;
    c = (c + (d ^ a ^ b) + w[o + 7] - 0x0944b4a0) | 0; c = (c << 16 | c >>> 16) + d | 0;
    b = (b + (c ^ d ^ a) + w[o + 10] - 0x41404390) | 0; b = (b << 23 | b >>> 9) + c | 0;
    a = (a + (b ^ c ^ d) + w[o + 13] + 0x289b7ec6) | 0; a = (a << 4 | a >>> 28) + b | 0;
    d = (d + (a ^ b ^ c) + w[o + 0] - 0x155ed806) | 0; d = (d << 11 | d >>> 21) + a | 0;
    c = (c + (d ^ a ^ b) + w[o + 3] - 0x2b10cf7b) | 0; c = (c << 16 | c >>> 16) + d | 0;
    b = (b + (c ^ d ^ a) + w[o + 6] + 0x04881d05) | 0; b = (b << 23 | b >>> 9) + c | 0;
    a = (a + (b ^ c ^ d) + w[o + 9] - 0x262b2fc7) | 0; a = (a << 4 | a >>> 28) + b | 0;
    d = (d + (a ^ b ^ c) + w[o + 12] - 0x1924661b) | 0; d = (d << 11 | d >>> 21) + a | 0;
    c = (c + (d ^ a ^ b) + w[o + 15] + 0x1fa27cf8) | 0; c = (c << 16 | c >>> 16) + d | 0;
    b = (b + (c ^ d ^ a) + w[o + 2] - 0x3b53a99b) | 0; b = (b << 23 | b >>> 9) + c | 0;
    a = (a + (c ^ (b | ~d)) + w[o + 0] - 0x0bd6ddbc) | 0; a = (a << 6 | a >>> 26) + b | 0;
    d = (d + (b ^ (a | ~c)) + w[o + 7] + 0x432aff97) | 0; d = (d << 10 | d >>> 22) + a | 0;
    c = (c + (a ^ (d | ~b)) + w[o + 14] - 0x546bdc59) | 0; c = (c << 15 | c >>> 17) + d | 0;
    b = (b + (d ^ (c | ~a)) + w[o + 5] - 0x036c5fc7) | 0; b = (b << 21 | b >>> 11) + c | 0;
    a = (a + (c ^ (b | ~d)) + w[o + 12] + 0x655b59c3) | 0; a = (a << 6 | a >>> 26) + b | 0;
    d = (d + (b ^ (a | ~c)) + w[o + 3] - 0x70f3336e) | 0; d = (d << 10 | d >>> 22) + a | 0;
    c = (c + (a ^ (d | ~b)) + w[o + 10] - 0x00100b83) | 0; c = (c << 15 | c >>> 17) + d | 0;
    b = (b + (d ^ (c | ~a)) + w[o + 1] - 0x7a7ba22f) | 0; b = (b << 21 | b >>> 11) + c | 0;
    a = (a + (c ^ (b | ~d)) + w[o + 8] + 0x6fa87e4f) | 0; a = (a << 6 | a >>> 26) + b | 0;
    d = (d + (b ^ (a | ~c)) + w[o + 15] - 0x01d31920) | 0; d = (d << 10 | d >>> 22) + a | 0;
    c = (c + (a ^ (d | ~b)) + w[o + 6] - 0x5cfebcec) | 0; c = (c << 15 | c >>> 17) + d | 0;
    b = (b + (d ^ (c | ~a)) + w[o + 13] + 0x4e0811a1) | 0; b = (b << 21 | b >>> 11) + c | 0;
    a = (a + (c ^ (b | ~d)) + w[o + 4] - 0x08ac817e) | 0; a = (a << 6 | a >>> 26) + b | 0;
    d = (d + (b ^ (a | ~c)) + w[o + 11] - 0x42c50dcb) | 0; d = (d << 10 | d >>> 22) + a | 0;
    c = (c + (a ^ (d | ~b)) + w[o + 2] + 0x2ad7d2bb) | 0; c = (c << 15 | c >>> 17) + d | 0;
    b = (b + (d ^ (c | ~a)) + w[o + 9] - 0x14792c6f) | 0; b = (b << 21 | b >>> 11) + c | 0;
    a = (a + a0) | 0; b = (b + b0) | 0; c = (c + c0) | 0; d = (d + d0) | 0;
  }
  state.set([a, b, c, d]);
}

export function md5(data) {
  const state = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476), n = data.length, full = n - n % 64;
  blocks(state, data, full);
  const tail = new Uint8Array(n % 64 < 56 ? 64 : 128), view = new DataView(tail.buffer);
  tail.set(data.subarray(full));
  tail[n % 64] = 0x80;
  view.setUint32(tail.length - 8, n % 0x20000000 * 8, true);
  view.setUint32(tail.length - 4, Math.floor(n / 0x20000000), true);
  blocks(state, tail, tail.length);
  const out = new Uint8Array(16), result = new DataView(out.buffer);
  state.forEach((word, i) => result.setInt32(4 * i, word, true));
  return out;
}

export const md5Hex = data => Array.from(md5(data), byte => byte.toString(16).padStart(2, '0')).join('');
/** RFC 1864 Content-MD5: standard base64 with padding, 24 characters. */
export const contentMd5 = data => toBase64(md5(data)) + '==';
