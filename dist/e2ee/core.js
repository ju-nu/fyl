// Profile fyl-e2ee-1 (docs/E2EE.md): age v1 with exactly one X25519 stanza and a STREAM payload. Every file key,
// ephemeral secret and nonce comes from the CSPRNG inside this module; no export takes them as arguments (the tests pin
// bytes by replacing crypto.getRandomValues, §4.1).
import { concat, decodeKey, equal, fromBase64, toBase64 } from './encoding.js';
import { E2EEError } from './errors.js';
import { checkMeta, metaPlaintext } from './meta.js';
import { equalTime, hkdf, hmac, open, publicKey, random, seal, x25519 } from './primitives.js';

export const H = 184, CHUNK = 65536, TAG = 16, S = CHUNK + TAG, PART = 52428800, MAX_FILE_BYTES = 50 * 1024 ** 3;
const MACED = 123, HEADER = 168;
const STANZA_INFO = 'age-encryption.org/v1/X25519';
const encoder = new TextEncoder();
const ascii = text => encoder.encode(text);
const latin1 = bytes => String.fromCharCode(...bytes);
const fail = code => new E2EEError(code);
const ZERO_NONCE = new Uint8Array(12), EMPTY = new Uint8Array(0);
const PREFIX = ascii('age-encryption.org/v1\n-> X25519 '), VERSION = ascii('age-encryption.org/v1'), FAMILY = ascii('age-encryption.org/');
const X25519 = ascii('X25519'), MARKER = ascii('--- ');
const SCAN = Symbol('scan');

// §6 layout.
export const chunkCount = P => Math.max(1, Math.ceil(P / CHUNK));
export const ciphertextSize = P => H + P + TAG * chunkCount(P);
export const chunkOffset = i => H + S * i;

/** P(C), or null where no plaintext size gives C (an empty last chunk after others, or one under 17 bytes). */
export function plaintextSize(C) {
  if (!Number.isSafeInteger(C) || C - H < TAG) return null;
  const rest = C - H, n = Math.max(1, Math.ceil(rest / S)), P = rest - TAG * n;
  return n >= 2 && P <= CHUNK * (n - 1) ? null : P;
}

/** The largest P with C(P) <= limit (P_max for the server's maxFileBytes), -1 if not even an empty file fits. */
export function maxPlaintextSize(limit = MAX_FILE_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < H + TAG) return -1;
  let lo = 0, hi = limit;
  while (lo < hi) {
    // Not (lo + hi) / 2: above 2^53 that sum rounds, and the loop would stop moving.
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (ciphertextSize(mid) <= limit) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export const partCount = (C, partSize = PART) => Math.ceil(C / partSize);

/** Part p's byte range of the stored object and the chunks it touches (§6); partSize is a test-only parameter. */
export function partRange(C, part, partSize = PART) {
  const P = plaintextSize(C);
  if (P === null || !Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(part) || part < 1
    || part > partCount(C, partSize)) throw new RangeError('No such part.');
  const start = partSize * (part - 1), end = Math.min(partSize * part, C);
  return {
    part, start, end,
    firstChunk: part === 1 ? 0 : Math.max(0, Math.floor((start - H) / S)),
    lastChunk: Math.min(chunkCount(P) - 1, Math.floor((end - 1 - H) / S)),
  };
}

function chunkNonce(i, final) {
  const nonce = new Uint8Array(12);
  for (let at = 10, v = i; v > 0; at--, v = Math.floor(v / 256)) nonce[at] = v % 256;
  nonce[11] = final ? 1 : 0;
  return nonce;
}

// The payload key stays out of the object, so logging, JSON or postMessage of a content key never carries it. P is
// bound to the key: one payload key never seals two plaintext sizes, whose last chunks would share a nonce.
const payloadKeys = new WeakMap();
function contentKey(head, pkey, size) {
  const key = Object.freeze({ head: head.slice(), size });
  payloadKeys.set(key, pkey);
  return key;
}
function plaintextSizeOf(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid plaintext size.');
  return size;
}
function payloadKeyOf(content) {
  const pkey = payloadKeys.get(content);
  if (!pkey) throw new TypeError('Expected a content key.');
  return pkey;
}

export function toIdentity(key) {
  if (typeof key === 'string') return decodeKey(key);
  if (key instanceof Uint8Array && key.length === 32) return key;
  throw new TypeError('Expected a KEY or a 32-byte identity.');
}

// §4.1: one age header (184 bytes with the payload nonce) and its payload key, from fresh file key, ephemeral secret and
// nonce, drawn in this order.
async function sealHead(identity) {
  const fileKey = random(16), eph = random(32), nonce = random(16);
  const recipient = await publicKey(identity), share = await publicKey(eph);
  const shared = await x25519(eph, recipient);
  if (!shared) throw fail('corrupt');
  const wrap = await hkdf(shared, concat(share, recipient), STANZA_INFO);
  const hdr = ascii('age-encryption.org/v1\n-> X25519 ' + toBase64(share) + '\n' + toBase64(seal(wrap, ZERO_NONCE, fileKey)) + '\n---');
  const mac = await hmac(await hkdf(fileKey, EMPTY, 'header'), hdr);
  return { head: concat(hdr, ascii(' ' + toBase64(mac) + '\n'), nonce), pkey: await hkdf(fileKey, nonce, 'payload') };
}

/**
 * The content key of a new transfer to `identity` for a file of `size` (P) bytes, with a fresh head; every later
 * ciphertext byte follows from it and the plaintext. Generated once per transfer (§4.1).
 */
export async function sealContent(identity, size) {
  plaintextSizeOf(size);
  const { head, pkey } = await sealHead(toIdentity(identity));
  return contentKey(head, pkey, size);
}

/** The metadata blob (§5.2) for a normalised name, P and the content head: a separate age file to the same identity. */
export async function sealMeta(identity, name, size, head) {
  const plaintext = await metaPlaintext(name, size, head);
  const sealed = await sealHead(toIdentity(identity)), out = [sealed.head], n = chunkCount(plaintext.length);
  for (let i = 0; i < n; i++) out.push(seal(sealed.pkey, chunkNonce(i, i === n - 1), plaintext.subarray(CHUNK * i, CHUNK * (i + 1))));
  return concat(...out);
}

// §4.2 steps 1-4. `data` is the whole input, or (ended false) the first H bytes of a longer one. Returns the fields, or
// SCAN when the stanza type isn't ended within the bytes at hand: whether it ends later (unsupported) or never
// (truncated) decides the code.
function shape(data, ended = true) {
  const lf = data.subarray(0, H).indexOf(0x0a);
  if (lf < 0) throw fail(data.length < H ? 'truncated' : 'corrupt');
  const version = data.subarray(0, lf);
  if (lf <= FAMILY.length || !equal(version.subarray(0, FAMILY.length), FAMILY)
    || version.subarray(FAMILY.length).some(byte => byte < 0x21 || byte > 0x7e)) throw fail('corrupt');
  if (!equal(version, VERSION)) throw fail('unsupported');
  const rest = data.subarray(lf + 1);
  if (rest.length < 3 || rest[0] !== 0x2d || rest[1] !== 0x3e || rest[2] !== 0x20)
    throw fail(rest.length < 3 && equal(rest, PREFIX.subarray(22, 22 + rest.length)) ? 'truncated' : 'corrupt');
  let end = 3;
  while (end < rest.length && rest[end] !== 0x20 && rest[end] !== 0x0a) end++;
  if (end === rest.length) {
    if (ended) throw fail('truncated');
    return SCAN;
  }
  // Bytes, not a string: the type can be as long as the input, too long to spread into String.fromCharCode.
  if (end !== 9 || !equal(rest.subarray(3, 9), X25519)) throw fail('unsupported');
  if (data.length < H) throw fail('truncated');
  if (!equal(data.subarray(0, 32), PREFIX) || data[75] !== 0x0a || data[119] !== 0x0a || !equal(data.subarray(120, 124), MARKER)
    || data[167] !== 0x0a) throw fail('corrupt');
  const share = fromBase64(latin1(data.subarray(32, 75)), false, 32), body = fromBase64(latin1(data.subarray(76, 119)), false, 32);
  const mac = fromBase64(latin1(data.subarray(124, 167)), false, 32);
  if (!share || !body || !mac) throw fail('corrupt');
  return { share, body, mac };
}

// Step 5.
async function agree(identity, fields) {
  const shared = await x25519(identity, fields.share);
  if (!shared) throw fail('corrupt');
  return shared;
}

// Step 6: the file key, or null when the stanza doesn't open with this identity.
async function unwrap(identity, shared, fields) {
  return open(await hkdf(shared, concat(fields.share, await publicKey(identity)), STANZA_INFO), ZERO_NONCE, fields.body);
}

// Step 7.
async function verifyMac(fileKey, data, mac) {
  if (!equalTime(await hmac(await hkdf(fileKey, EMPTY, 'header'), data.subarray(0, MACED)), mac)) throw fail('corrupt');
}

const payloadKey = (fileKey, data) => hkdf(fileKey, data.subarray(HEADER, H), 'payload');

/**
 * Steps 1-7 on a stored head alone, for a file of `size` (P) bytes (a worker given KEY, head and the P that checkKey
 * or prepareUpload established); a failing unwrap is key_wrong. A stored head is exactly H bytes, else corrupt.
 */
export async function openContent(identity, head, size) {
  identity = toIdentity(identity);
  plaintextSizeOf(size);
  const fields = shape(head);
  if (head.length !== H) throw fail('corrupt');
  const fileKey = await unwrap(identity, await agree(identity, fields), fields);
  if (!fileKey) throw fail('key_wrong');
  await verifyMac(fileKey, head, fields.mac);
  return contentKey(head, await payloadKey(fileKey, head), size);
}

// Step 8 for one chunk: a full one opens as non-final, else as final; a shorter one only as final.
function openChunk(pkey, i, ciphertext) {
  if (ciphertext.length < TAG) throw fail('corrupt');
  if (ciphertext.length === S) {
    const plaintext = open(pkey, chunkNonce(i, false), ciphertext);
    if (plaintext) return { plaintext, final: false };
  }
  const plaintext = open(pkey, chunkNonce(i, true), ciphertext);
  if (!plaintext || (!plaintext.length && i > 0)) throw fail('corrupt');
  return { plaintext, final: true };
}

function openPayload(pkey, data) {
  const out = [];
  for (let at = H, i = 0; ; i++) {
    const ciphertext = data.subarray(at, at + S);
    at += ciphertext.length;
    if (!ciphertext.length) throw fail('truncated');
    const { plaintext, final } = openChunk(pkey, i, ciphertext);
    out.push(plaintext);
    if (final) {
      if (at < data.length) throw fail('trailing_data');
      return concat(...out);
    }
  }
}

// §12.1 step 6: meta's ephemeral share, stanza body and payload nonce each differ from head's. Equal shares mean one wrap
// key for two file keys; an equal nonce with an equal file key means one payload key, so meta's chunk 0 would reuse
// the keystream and Poly1305 key of a small file's only chunk. Honest files collide with probability 2^-128.
const REUSE = [[32, 75], [76, 119], [HEADER, H]];
const reused = (head, meta) => REUSE.some(([from, to]) => equal(head.subarray(from, to), meta.subarray(from, to)));

/**
 * The key check (§9.1) on the stored head and meta of a content object of C bytes, before anything is downloaded:
 * steps 1-5 on head (exactly H bytes), then on meta; step 6 on both (both failing key_wrong, one failing corrupt);
 * step 7 on head, then meta; no randomness shared between them; then meta's payload and §5.3. Returns the decrypted
 * name, P and the content key, bound to that P, for decryption or resume.
 */
export async function checkKey(identity, head, meta, ciphertextSize) {
  identity = toIdentity(identity);
  const headFields = shape(head);
  if (head.length !== H) throw fail('corrupt');
  const headShared = await agree(identity, headFields);
  const metaFields = shape(meta), metaShared = await agree(identity, metaFields);
  const headKey = await unwrap(identity, headShared, headFields), metaKey = await unwrap(identity, metaShared, metaFields);
  if (!headKey && !metaKey) throw fail('key_wrong');
  if (!headKey || !metaKey) throw fail('corrupt');
  await verifyMac(headKey, head, headFields.mac);
  await verifyMac(metaKey, meta, metaFields.mac);
  if (reused(head, meta)) throw fail('corrupt');
  const { name, size } = await checkMeta(openPayload(await payloadKey(metaKey, meta), meta), head, plaintextSize(ciphertextSize));
  return { name, size, content: contentKey(head, await payloadKey(headKey, head), size) };
}

/**
 * Part p of the stored object (§6, §7 step 4) for the content key's P, computed on its own from the plaintext of the
 * chunks it touches, so parts can be built in any order and in parallel and a retry yields the same bytes. `source` is
 * a Blob (File), a Uint8Array or an async (start, end) => bytes reader; it is read in pieces of at most 1 MiB. A short
 * read means the file changed (file_changed); a File that changed on disk rejects with the browser's NotReadableError.
 */
export async function encryptPart(content, source, part, { partSize = PART } = {}) {
  const pkey = payloadKeyOf(content), read = reader(source), plaintextSize = content.size, n = chunkCount(plaintextSize);
  const { start, end, firstChunk, lastChunk } = partRange(ciphertextSize(plaintextSize), part, partSize);
  const out = new Uint8Array(end - start);
  if (start < H) out.set(content.head.subarray(start, Math.min(H, end)));
  for (let i = firstChunk; i <= lastChunk;) {
    const stop = Math.min(lastChunk + 1, i + 16), from = CHUNK * i, to = Math.min(CHUNK * stop, plaintextSize);
    const plaintext = await read(from, to);
    if (plaintext.length !== to - from) throw fail('file_changed');
    for (; i < stop; i++) {
      const a = CHUNK * i - from, b = Math.min(a + CHUNK, plaintext.length), at = H + S * i, after = at + b - a + TAG;
      const nonce = chunkNonce(i, i === n - 1);
      if (at >= start && after <= end) seal(pkey, nonce, plaintext.subarray(a, b), out.subarray(at - start, after - start));
      else {
        const sealed = seal(pkey, nonce, plaintext.subarray(a, b)), lo = Math.max(at, start), hi = Math.min(after, end);
        out.set(sealed.subarray(lo - at, hi - at), lo - start);
      }
    }
  }
  return out;
}

function reader(source) {
  if (source instanceof Uint8Array) return async (from, to) => source.subarray(from, to);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return async (from, to) => new Uint8Array(await source.slice(from, to).arrayBuffer());
  if (typeof source === 'function') return async (from, to) => bytes(await source(from, to));
  throw new TypeError('Expected a Blob, a Uint8Array or a reader function.');
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Expected bytes.');
}

/**
 * §4.2 as a push decoder: push() ciphertext in pieces of any size, then end(). `emit` receives each chunk's plaintext
 * (a fresh Uint8Array) as soon as that chunk verified; it is complete only once end() resolves. Any violation throws an
 * E2EEError, after emitting what verified before it, and every later call throws it again.
 *
 * `key` is either the content key from checkKey()/openContent(): the stream must then start with exactly that verified
 * head and decrypt to exactly its P bytes; or an identity/KEY for a whole age file, optionally with the `verifiedHead`
 * its first 184 bytes must equal (§9.2, §10 step 7). After a source failure, restart() and push again from `offset`:
 * a resume continues this instance, which alone knows how much verified (§9.2, §10 step 8).
 */
export class Decryptor {
  #identity = null; #expect = null; #pkey = null; #size = null; #i = 0; #emitted = 0; #endOffset = 0;
  #state = 'head'; #error = null; #busy = false;
  #held = []; #heldLength = 0; #pending = new Uint8Array(S); #pendingLength = 0;

  constructor(key, { verifiedHead = undefined } = {}) {
    const pkey = payloadKeys.get(key);
    if (pkey) { this.#pkey = pkey; this.#expect = key.head; this.#size = key.size; }
    else { this.#identity = toIdentity(key); this.#expect = verifiedHead ?? null; }
  }

  /** True once the final chunk verified and nothing followed it so far. */
  get done() { return this.#state === 'done'; }

  /** The ciphertext offset of the first byte not yet verified: 0 before the head, 184 + 65552·i before chunk i, C once done. */
  get offset() {
    if (this.#state === 'done') return this.#endOffset;
    return this.#state === 'payload' ? chunkOffset(this.#i) : 0;
  }

  /** Plaintext emitted so far, all of it verified. */
  get verified() { return this.#emitted; }

  /** Drops the bytes of an unfinished chunk (or head) after a source failure; push() continues from `offset`. */
  restart() {
    if (this.#error) throw this.#error;
    if (this.#busy) throw new Error('Await each push() before the next.');
    if (this.#state === 'scan') this.#state = 'head';
    this.#held = []; this.#heldLength = 0; this.#pendingLength = 0;
  }

  push(input, emit) { return this.#run(() => this.#push(bytes(input), emit)); }
  end(emit) { return this.#run(() => this.#end(emit)); }

  async #run(step) {
    if (this.#error) throw this.#error;
    if (this.#busy) throw new Error('Await each push() before the next.');
    this.#busy = true;
    try {
      await step();
    } catch (error) {
      this.#error = error; this.#state = 'failed';
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #push(input, emit) {
    if (this.#state === 'done') { if (input.length) throw fail('trailing_data'); return; }
    if (this.#state === 'scan') { if (input.includes(0x20) || input.includes(0x0a)) throw fail('unsupported'); return; }
    if (this.#state === 'payload') { this.#payload(input, emit); return; }
    this.#held.push(input);
    this.#heldLength += input.length;
    if (this.#heldLength >= H) await this.#header(false, emit);
    else this.#held[this.#held.length - 1] = input.slice();
  }

  async #end(emit) {
    if (this.#state === 'scan') throw fail('truncated');
    if (this.#state === 'head') await this.#header(true, emit);
    if (this.#state !== 'payload') return;
    if (!this.#pendingLength) throw fail('truncated');
    this.#chunk(this.#pending.subarray(0, this.#pendingLength), emit);
  }

  // Parses only the first H bytes held (#push calls this as soon as there are H, so only the last piece reaches past
  // them); the rest of that piece goes on to the payload without a copy.
  async #header(ended, emit) {
    const head = new Uint8Array(Math.min(H, this.#heldLength));
    let at = 0, rest = EMPTY;
    for (const piece of this.#held) {
      const take = Math.min(piece.length, head.length - at);
      head.set(piece.subarray(0, take), at);
      at += take;
      if (take < piece.length) rest = piece.subarray(take);
    }
    this.#held = []; this.#heldLength = 0;
    if (this.#expect && !equal(head, this.#expect)) throw fail('corrupt');
    if (!this.#pkey) {
      const fields = shape(head, ended);
      if (fields === SCAN) {
        // The stanza type runs past H bytes: unsupported once something ends it (#push goes on looking).
        if (rest.includes(0x20) || rest.includes(0x0a)) throw fail('unsupported');
        this.#state = 'scan';
        return;
      }
      const fileKey = await unwrap(this.#identity, await agree(this.#identity, fields), fields);
      if (!fileKey) throw fail('key_wrong');
      await verifyMac(fileKey, head, fields.mac);
      this.#pkey = await payloadKey(fileKey, head);
    }
    this.#state = 'payload';
    this.#payload(rest, emit);
  }

  #payload(input, emit) {
    let at = 0;
    if (this.#pendingLength) {
      at = Math.min(S - this.#pendingLength, input.length);
      this.#pending.set(input.subarray(0, at), this.#pendingLength);
      this.#pendingLength += at;
      if (this.#pendingLength < S) return;
      this.#pendingLength = 0;
      this.#chunk(this.#pending, emit);
    }
    for (; this.#state === 'payload' && input.length - at >= S; at += S) this.#chunk(input.subarray(at, at + S), emit);
    if (this.#state === 'done') { if (at < input.length) throw fail('trailing_data'); return; }
    this.#pending.set(input.subarray(at));
    this.#pendingLength = input.length - at;
  }

  #chunk(ciphertext, emit) {
    const { plaintext, final } = openChunk(this.#pkey, this.#i, ciphertext);
    if (final) {
      // A content key knows P: an authentic file of another size isn't the one the metadata describes.
      if (this.#size !== null && this.#emitted + plaintext.length !== this.#size) throw fail('corrupt');
      this.#state = 'done';
      this.#endOffset = chunkOffset(this.#i) + ciphertext.length;
    } else this.#i++;
    this.#emitted += plaintext.length;
    if (plaintext.length) emit(plaintext);
  }
}

/**
 * A ReadableStream of the plaintext of `source` (ciphertext). Every verified chunk is delivered before the stream errors
 * with the E2EEError of a violation, and it closes only after the final chunk verified and the source ended, so a
 * consumer that sees close() has the complete, authentic file. Nothing is read from the source before the consumer
 * reads. `source` is a ReadableStream, whose errors (the network) pass through unchanged; or `open(offset, error)`,
 * which returns (a promise of) a ReadableStream of the ciphertext from `offset`: called with (0, null), and after each
 * source error with the decryptor's offset and that error, so the caller's retry policy resumes it with Range, or gives
 * up by throwing, which errors the stream.
 */
export function decryptReadable(source, key, options = {}) {
  const decryptor = new Decryptor(key, options), queue = [], open = typeof source === 'function' ? source : null;
  const emit = plaintext => queue.push(plaintext);
  let reader = open ? null : source.getReader(), retry = null, failure = null, finished = false;
  return new ReadableStream({
    async pull(controller) {
      while (!queue.length && !failure && !finished) {
        let result;
        try {
          reader ??= (await open(decryptor.offset, retry)).getReader();
          result = await reader.read();
        } catch (error) {
          if (!open || !reader) { failure = error; break; }
          reader = null; retry = error;
          decryptor.restart();
          continue;
        }
        try {
          if (result.done) { await decryptor.end(emit); finished = true; }
          else await decryptor.push(result.value, emit);
        } catch (error) {
          failure = error;
          reader.cancel(error).catch(() => {});
        }
      }
      if (queue.length) controller.enqueue(queue.shift());
      else if (failure) controller.error(failure);
      else controller.close();
    },
    cancel(reason) { return reader?.cancel(reason); },
  }, { highWaterMark: 0 });
}

/** A {writable, readable} pair for pipeThrough(): ciphertext in, verified plaintext out (see decryptReadable). */
export function decryptStream(key, options = {}) {
  const { readable, writable } = new TransformStream();
  return { writable, readable: decryptReadable(readable, key, options) };
}

/** Decrypts a whole age file held in memory, into one buffer: the plaintext is shorter than the payload. */
export async function decryptBytes(key, data, options = {}) {
  data = bytes(data);
  const decryptor = new Decryptor(key, options), out = new Uint8Array(Math.max(0, data.length - H));
  let length = 0;
  const emit = plaintext => { out.set(plaintext, length); length += plaintext.length; };
  await decryptor.push(data, emit);
  await decryptor.end(emit);
  return out.subarray(0, length);
}
