// CRC-32 (ISO-HDLC, zlib's crc32) of the folder zip (docs/FOLDER-ZIP.md §3.1, §7): the pre-pass over every file and
// the check of an encrypted folder's parts before completing, both run by jobs.js. It lives under /e2ee/ because every
// module the part worker loads does (the upload and download pages' policies name that path); it handles no key.

// Slicing by 8: table k holds the CRC of a byte followed by k zero bytes, so eight bytes take eight lookups.
const T = new Uint32Array(8 * 256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c;
}
for (let k = 1; k < 8; k++) for (let n = 0; n < 256; n++) T[k * 256 + n] = (T[(k - 1) * 256 + n] >>> 8) ^ T[T[(k - 1) * 256 + n] & 0xFF];

/** The CRC-32 of `bytes` (a Uint8Array) continuing `crc`, the CRC of what came before (0 at the start). */
export function crc32(bytes, crc = 0) {
  let c = ~crc, i = 0;
  const n = bytes.length, whole = n - (n & 7);
  for (; i < whole; i += 8) {
    const a = c ^ (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24);
    c = T[1792 + (a & 0xFF)] ^ T[1536 + ((a >>> 8) & 0xFF)] ^ T[1280 + ((a >>> 16) & 0xFF)] ^ T[1024 + (a >>> 24)]
      ^ T[768 + bytes[i + 4]] ^ T[512 + bytes[i + 5]] ^ T[256 + bytes[i + 6]] ^ T[bytes[i + 7]];
  }
  for (; i < n; i++) c = T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

// zlib's crc32_combine: multiplying by the GF(2) matrix of "append n zero bits", squared up from one bit.
const times = (matrix, vector) => {
  let sum = 0;
  for (let i = 0; vector; vector >>>= 1, i++) if (vector & 1) sum ^= matrix[i];
  return sum >>> 0;
};
const square = matrix => Array.from({length: 32}, (_, n) => times(matrix, matrix[n]));

/** The CRC-32 of A‖B from crc(A), crc(B) and B's length in bytes (any safe integer, so beyond 4 GiB too). */
export function crc32Combine(crc1, crc2, length2) {
  if (!(length2 > 0)) return crc1 >>> 0;
  let odd = [0xEDB88320, ...Array.from({length: 31}, (_, n) => 2 ** n)], even = square(odd);
  odd = square(even);
  for (;;) {
    even = square(odd);
    if (length2 % 2) crc1 = times(even, crc1);
    length2 = Math.floor(length2 / 2);
    if (!length2) break;
    odd = square(even);
    if (length2 % 2) crc1 = times(odd, crc1);
    length2 = Math.floor(length2 / 2);
    if (!length2) break;
  }
  return (crc1 ^ crc2) >>> 0;
}
