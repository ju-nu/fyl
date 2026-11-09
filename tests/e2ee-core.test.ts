import { describe, expect, inject, it, vi } from 'vitest';
// @ts-expect-error: dist/e2ee is plain browser ES modules without type declarations; Age below describes the API.
import * as ageModule from '../dist/e2ee/age.js';

// The browser E2EE core (dist/e2ee, docs/E2EE.md) against every shared vector in tests/vectors/e2ee: exact bytes for
// the positive ones, the exact §13 code for the negative ones; then random round trips, part order and stream chunking.

declare global {
  interface ImportMeta { glob(pattern: string, options: { eager: true; import: 'default'; query?: string }): Record<string, unknown> }
}

type Bytes = Uint8Array;
type Key = Bytes | string | ContentKey;
interface ContentKey { readonly head: Bytes; readonly size: number }
interface CodedError extends Error { code: string }
interface Range { part: number; start: number; end: number; firstChunk: number; lastChunk: number }
interface DecryptOptions { verifiedHead?: Bytes }
interface Decryptor {
  push(input: Bytes, emit: (plaintext: Bytes) => void): Promise<void>; end(emit: (plaintext: Bytes) => void): Promise<void>;
  restart(): void; readonly done: boolean; readonly offset: number; readonly verified: number;
}
type Open = (offset: number, error: unknown) => ReadableStream<Bytes> | Promise<ReadableStream<Bytes>>;
interface Upload { identity: Bytes; key: string; name: string; size: number; ciphertextSize: number; head: Bytes; meta: Bytes; content: ContentKey }
interface Random { fileKey: Bytes; eph: Bytes; nonce: Bytes }
interface Age {
  H: number; CHUNK: number; S: number; TAG: number; PART: number; MAX_FILE_BYTES: number;
  E2EEError: new (code: string) => CodedError;
  supported(): Promise<boolean>;
  generateIdentity(): Bytes; encodeKey(identity: Bytes): string; decodeKey(key: string): Bytes;
  encodeAgeIdentity(identity: Bytes): string; decodeAgeIdentity(text: string): Bytes; ageRecipient(identity: Bytes | string): Promise<string>;
  parseLink(link: string, origin: string): { id: string; key: string | null; exposed: boolean };
  parseKeyEntry(input: string, id: string, origin: string): string;
  shareLink(origin: string, id: string, url: string, key: string): string;
  encodeBlob(data: Bytes): string; decodeBlob(text: string): Bytes;
  normalizeName(name: string): string; validName(name: unknown): boolean;
  chunkCount(P: number): number; ciphertextSize(P: number): number; plaintextSize(C: number): number | null; maxPlaintextSize(limit?: number): number;
  partCount(C: number, partSize?: number): number; partRange(C: number, part: number, partSize?: number): Range; chunkOffset(i: number): number;
  prepareUpload(name: string, size: number, options?: { maxFileBytes?: number }): Promise<Upload>;
  createContent(identity: Bytes | string, size: number): Promise<ContentKey>;
  createMeta(identity: Bytes | string, name: string, size: number, head: Bytes): Promise<Bytes>;
  openContent(identity: Bytes | string, head: Bytes, size: number): Promise<ContentKey>;
  encryptPart(content: ContentKey, source: Bytes | Blob | ((start: number, end: number) => Promise<Bytes>), part: number, options?: { partSize?: number }): Promise<Bytes>;
  md5(data: Bytes): Bytes; md5Hex(data: Bytes): string; contentMd5(data: Bytes): string;
  checkKey(identity: Bytes | string, head: Bytes, meta: Bytes, ciphertextSize: number): Promise<{ name: string; size: number; content: ContentKey }>;
  Decryptor: new (key: Key, options?: DecryptOptions) => Decryptor;
  decryptStream(key: Key, options?: DecryptOptions): { writable: WritableStream<Bytes>; readable: ReadableStream<Bytes> };
  decryptReadable(source: ReadableStream<Bytes> | Open, key: Key, options?: DecryptOptions): ReadableStream<Bytes>;
  decryptBytes(key: Key, data: Bytes, options?: DecryptOptions): Promise<Bytes>;
}
const age = ageModule as Age;

interface Part { part: number; start: number; end: number; firstChunk: number; lastChunk: number; sha256: string; md5: string; contentMd5: string }
interface Boundary { offset: number; chunk: number; within: number; inTag: boolean }
interface FileDetails { fileKey: string; eph: string; nonce: string; head: string; headSha256: string; payloadKey: string }
interface ContentDoc {
  identity: string; key: string; file: FileDetails;
  vectors: { name: string; plaintextSize: number; ciphertextSize: number; chunks: number; lastChunkPlaintext: number; sha256: string; tags?: string[]; ciphertext?: string; parts: Part[]; boundaries?: Boundary[] }[];
  slices: { name: string; plaintextSize: number; partSize: number; sha256: string; parts: Part[]; boundaries: Boundary[] }[];
}
type Segment = { hex: string } | { repeat: string; count: number } | { content: number; start?: number; end?: number };
interface DecryptDoc {
  vectors: { why: string; identity: string; input: Segment[]; inputSize: number; inputSha256: string; verifiedHead?: string; plaintextSize?: number; result: string; released: number; releasedSha256: string }[];
}
interface MetaDoc {
  identity: string; head: string; headSha256: string; file: FileDetails;
  valid: { name: string; plaintextSize: number; ciphertextSize: number; text: string; paddedLength: number; meta: string }[];
  invalid: { why: string; text?: string; textHex?: string; paddedLength: number; ciphertextSize: number; meta: string; result: string }[];
}
interface KeycheckDoc {
  vectors: { why: string; identity: string; head: string; meta: string; ciphertextSize: number; result: string; name?: string; plaintextSize?: number }[];
  heads: { why: string; identity: string; head: string; result: string }[];
}
interface KeysDoc {
  valid: { why: string; identity: string; key: string; ageIdentity: string; recipient: string }[];
  invalidKeys: { why: string; key: string }[]; invalidAgeIdentities: { why: string; ageIdentity: string }[];
}
interface LinksDoc {
  id: string;
  link: { link: string; why: string; id?: string; key?: string | null; exposed?: boolean; exit?: number; code?: string }[];
  entry: { input: string; why: string; key?: string; code?: string; otherTransfer?: boolean }[];
  share: { why: string; origin: string; id: string; url: string; key: string; link?: string; code?: string }[];
}
interface NamesDoc { vectors: { why: string; input?: string; utf16?: number[]; name: string }[] }
interface LayoutDoc {
  constants: { H: number; CHUNK: number; S: number; PART: number; MAX_FILE_BYTES: number; maxPlaintextSize: number };
  sizes: { plaintextSize: number; ciphertextSize: number; chunks: number; lastChunkPlaintext: number; parts: number; uploadable: boolean }[];
  invalidCiphertextSizes: number[];
  partChunks: { ciphertextSize: number; part: number; start: number; end: number; firstChunk: number; lastChunk: number }[];
  maxPlaintext: { limit: number; maxPlaintextSize: number }[];
}
interface CctvDoc { commit: string; vectors: { file: string; sha256: string; compressed: boolean; identity: string; expect: string; result: string; released: number; releasedSha256: string }[] }

const docs = import.meta.glob('./vectors/e2ee/**/*.json', { eager: true, import: 'default' });
const doc = <T>(name: string) => docs[`./vectors/e2ee/${name}.json`] as T;
const content = doc<ContentDoc>('content'), decrypts = doc<DecryptDoc>('decrypt'), metas = doc<MetaDoc>('meta');
const keychecks = doc<KeycheckDoc>('keycheck'), keys = doc<KeysDoc>('keys'), links = doc<LinksDoc>('links');
const names = doc<NamesDoc>('names'), layout = doc<LayoutDoc>('layout'), cctv = doc<CctvDoc>('cctv/manifest');
// Binary files as data: URLs, so bytes survive exactly (?raw would decode them as UTF-8).
const cctvFiles = import.meta.glob('./vectors/e2ee/cctv/*', { eager: true, import: 'default', query: '?url&inline' }) as Record<string, string>;
const vendored = import.meta.glob('../dist/vendor/noble-ciphers-*/*', { eager: true, import: 'default', query: '?url&inline' }) as Record<string, string>;

const ORIGIN = 'https://fyl.at';
const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16));
const toHex = (data: Bytes) => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Bytes) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
const fromDataUrl = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), c => c.charCodeAt(0));
const concat = (parts: Bytes[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const same = (a: Bytes, b: Bytes) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const fixed = (file: FileDetails): Random => ({ fileKey: hex(file.fileKey), eph: hex(file.eph), nonce: hex(file.nonce) });

/**
 * The test-only injection of §4.1: runs `action` while crypto.getRandomValues hands out file key, ephemeral secret and
 * nonce, in the order the core draws them, and fails on any other request.
 */
async function withRandom<T>(random: Random, action: () => Promise<T>): Promise<T> {
  const queue = [random.fileKey, random.eph, random.nonce];
  const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    const next = queue.shift();
    if (!next || !(array instanceof Uint8Array) || next.length !== array.length) throw new Error('Unexpected randomness request.');
    array.set(next);
    return array;
  }) as never);
  try {
    const result = await action();
    expect(queue.length).toBe(0);
    return result;
  } finally {
    spy.mockRestore();
  }
}

/** Plaintext of the vectors: byte i is i mod 251. */
function pattern(size: number) {
  const out = new Uint8Array(size);
  for (let i = 0; i < Math.min(251, size); i++) out[i] = i;
  for (let have = 251; have < size; have *= 2) out.copyWithin(have, 0, Math.min(have, size - have));
  return out;
}

function randomBytes(size: number) {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(out.subarray(at, at + 65536));
  return out;
}

/** mulberry32: reproducible choices from a seed printed with any failure. */
function prng(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit | 0;
  };
}

function shuffle<T>(items: T[], next: (limit: number) => number) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Splits data at the given offsets (sorted, duplicates give empty pieces). */
function split(data: Bytes, offsets: number[]) {
  const pieces: Bytes[] = [];
  let last = 0;
  for (const at of offsets) { const cut = Math.min(Math.max(at, last), data.length); pieces.push(data.subarray(last, cut)); last = cut; }
  pieces.push(data.subarray(last));
  return pieces;
}

function streamOf(pieces: Bytes[]) {
  let i = 0;
  return new ReadableStream<Bytes>({
    pull(controller) {
      if (i < pieces.length) controller.enqueue(pieces[i++].slice());
      else controller.close();
    },
  }, { highWaterMark: 0 });
}

/** Everything a stream delivers, and the error it ends with (null when it closed). */
async function drain(stream: ReadableStream<Bytes>) {
  const reader = stream.getReader(), out: Bytes[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { out: concat(out), error: null as CodedError | null };
      out.push(value);
    }
  } catch (error) {
    return { out: concat(out), error: error as CodedError };
  }
}

/** The push decoder on pieces: the plaintext emitted and the code it stopped with ('success' when end() resolved). */
async function run(key: Key, pieces: Bytes[], options: DecryptOptions = {}) {
  const decryptor = new age.Decryptor(key, options), out: Bytes[] = [], emit = (plaintext: Bytes) => out.push(plaintext);
  try {
    for (const piece of pieces) await decryptor.push(piece, emit);
    await decryptor.end(emit);
    return { result: 'success', out: concat(out), done: decryptor.done };
  } catch (error) {
    expect(error).toBeInstanceOf(age.E2EEError);
    return { result: (error as CodedError).code, out: concat(out), done: decryptor.done };
  }
}

function code(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(age.E2EEError);
    return (error as CodedError).code;
  }
  return 'success';
}

async function asyncCode(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(age.E2EEError);
    return (error as CodedError).code;
  }
  return 'success';
}

const identity = hex(content.identity);
const contentKeys = new Map<number, Promise<ContentKey>>();
/** content.json's content key for P plaintext bytes: the same head for every P. */
const fixedContent = (P: number) => {
  let key = contentKeys.get(P);
  if (!key) {
    key = withRandom(fixed(content.file), () => age.createContent(identity, P));
    contentKeys.set(P, key);
  }
  return key;
};
const files = new Map<number, Promise<Bytes>>();
/** content.json's age file over P plaintext bytes, as one part covering the whole object. */
const contentFile = (P: number) => {
  let file = files.get(P);
  if (!file) {
    file = fixedContent(P).then(key => age.encryptPart(key, pattern(P), 1, { partSize: age.ciphertextSize(P) }));
    files.set(P, file);
  }
  return file;
};
async function assemble(segments: Segment[]) {
  const out: Bytes[] = [];
  for (const segment of segments) {
    if ('hex' in segment) out.push(hex(segment.hex));
    else if ('repeat' in segment) out.push(new Uint8Array(segment.count).fill(parseInt(segment.repeat, 16)));
    else { const file = await contentFile(segment.content); out.push(file.subarray(segment.start ?? 0, segment.end ?? file.length)); }
  }
  return concat(out);
}

describe('vendored @noble/ciphers', () => {
  // SHA-256 of the files in ciphers-2.4.0.tgz, whose integrity matched the npm registry's
  // sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw== when vendored.
  const pinned: Record<string, string> = {
    'LICENSE': 'f36671a5487c9c5050efacb58011c37c24c55a889803cb036cf9d9a6347c1e2d',
    '_arx.js': 'ead142ba410404c0698bb80e0d6f77780799bb77a9e3b098cf0f9fca1c486e37',
    '_poly1305.js': '5d2afd73b40dbafb7b6740c6e6388e7123c79a4e57306861b28c5734925fa84d',
    'chacha.js': '5f1c00575e227b75163f4bac50b79442dec50ee3047c46c18887808ba8af0a69',
    'utils.js': 'a443ec1f60d1aaa25d1b7d8c102d33c0e8e6d683ada1ad17be9c32e69170ff95',
  };
  it('holds exactly the imported files of version 2.4.0, unchanged', async () => {
    const found: Record<string, string> = {};
    for (const [path, url] of Object.entries(vendored)) {
      expect(path.startsWith('../dist/vendor/noble-ciphers-2.4.0/')).toBe(true);
      found[path.slice(path.lastIndexOf('/') + 1)] = await sha256(fromDataUrl(url));
    }
    expect(found).toEqual(pinned);
  });
});

describe('E2EE keys and links', () => {
  it('runs on this platform', async () => {
    expect(await age.supported()).toBe(true);
  });

  it('encodes and decodes KEY, the age identity string and the recipient (keys.json)', async () => {
    for (const v of keys.valid) {
      const raw = hex(v.identity);
      expect(age.encodeKey(raw), v.why).toBe(v.key);
      expect(toHex(age.decodeKey(v.key)), v.why).toBe(v.identity);
      expect(age.encodeAgeIdentity(raw), v.why).toBe(v.ageIdentity);
      expect(toHex(age.decodeAgeIdentity(v.ageIdentity)), v.why).toBe(v.identity);
      expect(toHex(age.decodeAgeIdentity(v.ageIdentity.toLowerCase())), v.why).toBe(v.identity);
      expect(await age.ageRecipient(raw), v.why).toBe(v.recipient);
      expect(await age.ageRecipient(v.key), v.why).toBe(v.recipient);
    }
    for (const v of keys.invalidKeys) expect(code(() => age.decodeKey(v.key)), v.why).toBe('key_invalid');
    for (const v of keys.invalidAgeIdentities) expect(code(() => age.decodeAgeIdentity(v.ageIdentity)), v.why).toBe('key_invalid');
    const fresh = age.generateIdentity();
    expect(fresh.length).toBe(32);
    expect(toHex(age.decodeKey(age.encodeKey(fresh)))).toBe(toHex(fresh));
    expect(toHex(age.generateIdentity())).not.toBe(toHex(fresh));
  });

  it('parses links and key entry (links.json)', () => {
    for (const v of links.link) {
      if (v.exit) expect(code(() => age.parseLink(v.link, ORIGIN)), v.why).toBe(v.code ?? 'link_invalid');
      else expect(age.parseLink(v.link, ORIGIN), v.why).toEqual({ id: v.id, key: v.key, exposed: v.exposed });
    }
    for (const v of links.entry) {
      const want = v.key !== undefined ? 'success' : v.otherTransfer ? 'other_transfer' : v.code;
      expect(code(() => age.parseKeyEntry(v.input, links.id, ORIGIN)), v.why).toBe(want);
      if (v.key) expect(age.parseKeyEntry(v.input, links.id, ORIGIN), v.why).toBe(v.key);
    }
  });

  it('builds keyed links only on the client origin and for the server url it expects (links.json)', () => {
    expect(links.share.length).toBeGreaterThan(20);
    for (const v of links.share) {
      expect(code(() => age.shareLink(v.origin, v.id, v.url, v.key)), v.why).toBe(v.code ?? 'success');
      if (v.link) expect(age.shareLink(v.origin, v.id, v.url, v.key), v.why).toBe(v.link);
    }
  });

  it('normalises sender names (names.json)', () => {
    for (const v of names.vectors) {
      const input = v.input ?? String.fromCharCode(...(v.utf16 ?? []));
      expect(age.normalizeName(input), v.why).toBe(v.name);
      expect(age.validName(v.name), v.why).toBe(true);
    }
    expect(age.normalizeName('')).toBe('_');
    expect(age.validName('a\u202eb')).toBe(false);
  });

  it('carries head and meta as canonical b64url', () => {
    const head = hex(content.file.head);
    expect(toHex(age.decodeBlob(age.encodeBlob(head)))).toBe(content.file.head);
    for (const bad of ['', 'a', 'ab=', 'a+b/', age.encodeBlob(head).slice(0, -1) + 'B']) {
      if (bad === '') expect(age.decodeBlob(bad).length).toBe(0);
      else expect(code(() => age.decodeBlob(bad)), bad).toBe('corrupt');
    }
  });
});

describe('E2EE layout (layout.json)', () => {
  it('computes sizes, P(C), parts and P_max', () => {
    const { constants } = layout;
    expect([age.H, age.CHUNK, age.S, age.PART, age.MAX_FILE_BYTES]).toEqual([constants.H, constants.CHUNK, constants.S, constants.PART, constants.MAX_FILE_BYTES]);
    expect(age.maxPlaintextSize()).toBe(constants.maxPlaintextSize);
    expect(age.maxPlaintextSize(constants.MAX_FILE_BYTES)).toBe(constants.maxPlaintextSize);
    // Up to 2^53 - 1, where a floating-point midpoint (lo + hi) / 2 stopped moving and never returned.
    for (const v of layout.maxPlaintext) expect(age.maxPlaintextSize(v.limit), String(v.limit)).toBe(v.maxPlaintextSize);
    expect(age.maxPlaintextSize(2 ** 53)).toBe(-1);
    for (const v of layout.sizes) {
      expect(age.ciphertextSize(v.plaintextSize)).toBe(v.ciphertextSize);
      expect(age.plaintextSize(v.ciphertextSize)).toBe(v.plaintextSize);
      expect(age.chunkCount(v.plaintextSize)).toBe(v.chunks);
      expect(v.plaintextSize - age.CHUNK * (v.chunks - 1)).toBe(v.lastChunkPlaintext);
      expect(age.partCount(v.ciphertextSize)).toBe(v.parts);
      expect(v.plaintextSize >= 1 && v.plaintextSize <= age.maxPlaintextSize()).toBe(v.uploadable);
    }
    for (const C of layout.invalidCiphertextSizes) expect(age.plaintextSize(C), String(C)).toBeNull();
    for (const v of layout.partChunks) {
      expect(age.partRange(v.ciphertextSize, v.part)).toEqual({ part: v.part, start: v.start, end: v.end, firstChunk: v.firstChunk, lastChunk: v.lastChunk });
    }
    const roundTrip: number[] = [];
    for (let C = 0; C < 200_000; C++) {
      const P = age.plaintextSize(C);
      if (P !== null && age.ciphertextSize(P) !== C) roundTrip.push(C);
    }
    expect(roundTrip).toEqual([]);
    expect(() => age.partRange(201, 2)).toThrow(RangeError);
    expect(() => age.partRange(65737, 1)).toThrow(RangeError);
    expect(age.chunkOffset(799)).toBe(52376232);
  });
});

describe('E2EE content encryption (content.json)', () => {
  it('rebuilds the fixed head and opens it again', async () => {
    const key = await fixedContent(1);
    expect([toHex(key.head), key.size]).toEqual([content.file.head, 1]);
    const reopened = await age.openContent(content.key, key.head, 1);
    expect([toHex(reopened.head), reopened.size]).toEqual([content.file.head, 1]);
    const tampered = key.head.slice();
    tampered[130] ^= 1;
    expect(await asyncCode(() => age.openContent(identity, tampered, 1))).toBe('corrupt');
    for (const v of keychecks.heads) expect(await asyncCode(() => age.openContent(hex(v.identity), hex(v.head), 1)), v.why).toBe(v.result);
    await expect(age.openContent(identity, key.head, -1)).rejects.toThrow(RangeError);
    await expect(age.createContent(identity, 2 ** 53)).rejects.toThrow(RangeError);
  });

  for (const v of content.vectors) {
    it(`encrypts ${v.name} part by part, in any order, to the exact bytes`, async () => {
      const key = await fixedContent(v.plaintextSize), plaintext = pattern(v.plaintextSize), C = age.ciphertextSize(v.plaintextSize);
      expect(C).toBe(v.ciphertextSize);
      // The big vectors read from a Blob, as the page reads a File.
      const source = v.plaintextSize > 1_000_000 ? new Blob([plaintext]) : plaintext;
      const order = [...v.parts].reverse();
      const parts = new Map<number, Bytes>();
      for (const p of order) {
        expect(age.partRange(C, p.part)).toEqual({ part: p.part, start: p.start, end: p.end, firstChunk: p.firstChunk, lastChunk: p.lastChunk });
        const data = await age.encryptPart(key, source, p.part);
        expect(data.length).toBe(p.end - p.start);
        expect(await sha256(data), `${v.name} part ${p.part}`).toBe(p.sha256);
        expect(age.md5Hex(data)).toBe(p.md5);
        expect(age.contentMd5(data)).toBe(p.contentMd5);
        parts.set(p.part, data);
      }
      const file = concat(v.parts.map(p => parts.get(p.part) as Bytes));
      expect(await sha256(file)).toBe(v.sha256);
      if (v.ciphertext) expect(toHex(file)).toBe(v.ciphertext);
      v.tags?.forEach((tag, i) => {
        const end = Math.min(age.chunkOffset(i + 1), file.length);
        expect(toHex(file.subarray(end - age.TAG, end)), `tag ${i}`).toBe(tag);
      });
      for (const b of v.boundaries ?? []) expect(age.chunkOffset(b.chunk) + b.within).toBe(b.offset);
    });
  }

  it('builds every slice part on its own with a small partSize', async () => {
    for (const v of content.slices) {
      const key = await fixedContent(v.plaintextSize), plaintext = pattern(v.plaintextSize), C = age.ciphertextSize(v.plaintextSize), seen: Bytes[] = [];
      expect(age.partCount(C, v.partSize)).toBe(v.parts.length);
      // In parallel and in reverse, against a reader that hands out exactly what was asked for.
      const reads: [number, number][] = [];
      const read = async (start: number, end: number) => { reads.push([start, end]); return plaintext.slice(start, end); };
      const built = await Promise.all([...v.parts].reverse().map(p => age.encryptPart(key, read, p.part, { partSize: v.partSize })));
      seen.push(...built.reverse());
      for (const [i, p] of v.parts.entries()) {
        expect(age.partRange(C, p.part, v.partSize), v.name).toEqual({ part: p.part, start: p.start, end: p.end, firstChunk: p.firstChunk, lastChunk: p.lastChunk });
        expect(await sha256(seen[i]), `${v.name} part ${p.part}`).toBe(p.sha256);
        expect(age.md5Hex(seen[i])).toBe(p.md5);
        expect(age.contentMd5(seen[i])).toBe(p.contentMd5);
      }
      expect(await sha256(concat(seen)), v.name).toBe(v.sha256);
      for (const [start, end] of reads) expect(end - start).toBeLessThanOrEqual(1 << 20);
    }
  });

  it('gives the same bytes for a part however often and in whatever order it is built', async () => {
    const P = 196608, key = await fixedContent(P), plaintext = pattern(P), partSize = 30000, next = prng(7);
    const count = age.partCount(age.ciphertextSize(P), partSize);
    const sequential: string[] = [];
    for (let p = 1; p <= count; p++) sequential.push(toHex(await age.encryptPart(key, plaintext, p, { partSize })));
    for (let round = 0; round < 3; round++) {
      const order = shuffle(Array.from({ length: count }, (_, i) => i + 1), next);
      const built = await Promise.all(order.map(p => age.encryptPart(key, plaintext, p, { partSize })));
      order.forEach((p, i) => expect(toHex(built[i]), `part ${p}`).toBe(sequential[p - 1]));
    }
    const reopened = await age.openContent(content.key, key.head, P);
    expect(toHex(await age.encryptPart(reopened, plaintext, 3, { partSize }))).toBe(sequential[2]);
  });

  it('reports a source that ends early as a changed file', async () => {
    const key = await fixedContent(65537), plaintext = pattern(65537);
    expect(await asyncCode(() => age.encryptPart(key, plaintext.subarray(0, 65536), 1))).toBe('file_changed');
    expect(await asyncCode(() => age.encryptPart(key, new Blob([plaintext.subarray(0, 100)]), 1))).toBe('file_changed');
    await expect(age.encryptPart({ head: key.head, size: 65537 }, plaintext, 1)).rejects.toThrow(TypeError);
  });

  it('binds P to the content key, so one payload key never seals two sizes', async () => {
    // Two sizes in one last chunk would seal different messages under nonce (n-1, final): the key carries P instead.
    const small = await fixedContent(999), large = await fixedContent(1000), plaintext = pattern(1000);
    expect(toHex(small.head)).toBe(toHex(large.head));
    const [a, b] = [await age.encryptPart(small, plaintext, 1), await age.encryptPart(large, plaintext, 1)];
    expect([a.length, b.length]).toEqual([age.ciphertextSize(999), age.ciphertextSize(1000)]);
    // A download through a content key needs exactly its P.
    expect((await run(small, [b])).result).toBe('corrupt');
    expect((await run(large, [b])).result).toBe('success');
  });
});

describe('E2EE decryption (decrypt.json)', () => {
  for (const v of decrypts.vectors) {
    it(`${v.result}: ${v.why}`, async () => {
      const data = await assemble(v.input), key = hex(v.identity);
      expect(data.length).toBe(v.inputSize);
      expect(await sha256(data)).toBe(v.inputSha256);
      const options = v.verifiedHead ? { verifiedHead: hex(v.verifiedHead) } : {};
      const whole = await run(key, [data], options);
      expect(whole.result).toBe(v.result);
      expect(whole.out.length).toBe(v.released);
      expect(await sha256(whole.out)).toBe(v.releasedSha256);
      expect(whole.done).toBe(v.result === 'success');
      if (v.verifiedHead) {
        // As a download does: the content key of the verified head and P (openContent, as checkKey gives it).
        const content = await run(await age.openContent(key, hex(v.verifiedHead), v.plaintextSize ?? -1), [data]);
        expect([content.result, content.out.length], v.why).toEqual([v.result, v.released]);
      }
      // The same through the stream, cut at awkward places: every verified chunk arrives before the error.
      const cuts = [[1, 21, 22, 25, 31, 32, 75, 123, 167, 168, 183, 184, 185, 199, 200, 201],
        [age.H + age.S - 1, age.H + age.S, age.H + age.S + 1, age.H + 2 * age.S, data.length - 1],
        data.length <= 1024 ? Array.from({ length: data.length }, (_, i) => i) : [age.H, age.H, age.H + 1]];
      for (const offsets of cuts) {
        const { out, error } = await drain(age.decryptReadable(streamOf(split(data, offsets)), key, options));
        expect(error?.code ?? 'success', `cut at ${offsets.slice(0, 4)}`).toBe(v.result);
        expect(await sha256(out)).toBe(v.releasedSha256);
      }
      const bytes = await asyncCode(() => age.decryptBytes(key, data, options));
      expect(bytes).toBe(v.result);
    });
  }
});

describe('E2EE CCTV age vectors (cctv/manifest.json)', () => {
  it('pins the vendored files', () => {
    expect(cctv.commit).toBe('50a8ecf2a220f4c8bdc4f085789b8e85c26829e7');
    expect(cctv.vectors.length).toBe(67);
  });
  for (const v of cctv.vectors) {
    it(`${v.file}: ${v.result}`, async () => {
      const raw = fromDataUrl(cctvFiles[`./vectors/e2ee/cctv/${v.file}`]);
      expect(await sha256(raw)).toBe(v.sha256);
      let at = 0;
      while (!(raw[at] === 0x0a && raw[at + 1] === 0x0a)) at++;
      const header = new TextDecoder().decode(raw.subarray(0, at)).split('\n');
      expect(header).toContain(`identity: ${v.identity}`);
      expect(header.includes('compressed: zlib')).toBe(v.compressed);
      let body = raw.subarray(at + 2);
      if (v.compressed) body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
      const { result, out } = await run(age.decodeAgeIdentity(v.identity), [body]);
      expect(result).toBe(v.result);
      expect(out.length).toBe(v.released);
      expect(await sha256(out)).toBe(v.releasedSha256);
    });
  }
});

describe('E2EE metadata and key check (meta.json, keycheck.json)', () => {
  const head = hex(metas.head);

  it('seals each valid name to the exact blob and reads it back', async () => {
    expect(metas.identity).toBe(content.identity);
    expect(metas.head).toBe(content.file.head);
    for (const v of metas.valid) {
      const meta = await withRandom(fixed(metas.file), () => age.createMeta(identity, v.name, v.plaintextSize, head));
      expect(toHex(meta), v.name).toBe(v.meta);
      const text = new TextEncoder().encode(v.text), padded = concat([text, new Uint8Array(v.paddedLength - text.length).fill(0x20)]);
      expect(toHex(await age.decryptBytes(identity, meta))).toBe(toHex(padded));
      const checked = await age.checkKey(identity, head, meta, v.ciphertextSize);
      expect([checked.name, checked.size], v.name).toEqual([v.name, v.plaintextSize]);
      expect(toHex(checked.content.head)).toBe(metas.head);
    }
    await expect(age.createMeta(identity, 'a/b', 1, head)).rejects.toThrow(RangeError);
  });

  it('refuses metadata that breaks §5.3 with the exact code', async () => {
    for (const v of metas.invalid) {
      const text = v.textHex !== undefined ? hex(v.textHex) : new TextEncoder().encode(v.text);
      const padded = concat([text, new Uint8Array(v.paddedLength - text.length).fill(0x20)]);
      expect(toHex(await age.decryptBytes(identity, hex(v.meta))), v.why).toBe(toHex(padded));
      expect(await asyncCode(() => age.checkKey(identity, head, hex(v.meta), v.ciphertextSize)), v.why).toBe(v.result);
    }
  });

  it('checks a key against head and meta, the first failure winning', async () => {
    for (const v of keychecks.vectors) {
      const check = () => age.checkKey(hex(v.identity), hex(v.head), hex(v.meta), v.ciphertextSize);
      expect(await asyncCode(check), v.why).toBe(v.result);
      if (v.result === 'success') {
        const checked = await check();
        expect([checked.name, checked.size, checked.content.size], v.why).toEqual([v.name, v.plaintextSize, v.plaintextSize]);
      }
    }
  });
});

describe('E2EE round trips', () => {
  const seed = (Date.now() ^ (Math.random() * 2 ** 32)) >>> 0;

  it('uploads and downloads random files of random sizes through parts and streams', async () => {
    const next = prng(seed);
    const sizes = [1, 15, 16, 17, 65535, 65536, 65537, 131072, 131073, 200_000 + next(300_000), 1 + next(2_000_000)];
    for (const P of sizes) {
      const why = `seed ${seed}, P ${P}`;
      const plaintext = randomBytes(P), name = `file ${next(1000)} ✓.bin`;
      const upload = await age.prepareUpload(name, P);
      expect(upload.name, why).toBe(name);
      expect(upload.key, why).toBe(age.encodeKey(upload.identity));
      expect(upload.ciphertextSize, why).toBe(age.ciphertextSize(P));
      expect(upload.head.length).toBe(age.H);
      expect([712, 1224, 1736, 2248, 2760]).toContain(upload.meta.length);
      // Parts of a random small size, built in a random order and in parallel.
      const partSize = Math.max(200 + next(150_000), Math.ceil(upload.ciphertextSize / 40)), count = age.partCount(upload.ciphertextSize, partSize);
      const order = shuffle(Array.from({ length: count }, (_, i) => i + 1), next);
      const built = await Promise.all(order.map(p => age.encryptPart(upload.content, plaintext, p, { partSize })));
      const parts: Bytes[] = [];
      order.forEach((p, i) => { parts[p - 1] = built[i]; });
      const file = concat(parts);
      expect(file.length, why).toBe(upload.ciphertextSize);
      expect(same(file, await age.encryptPart(upload.content, plaintext, 1, { partSize: file.length })), why).toBe(true);
      // The recipient: key check from KEY, then the stream in random pieces, with the verified head.
      const checked = await age.checkKey(upload.key, upload.head, upload.meta, file.length);
      expect([checked.name, checked.size], why).toEqual([name, P]);
      const offsets = Array.from({ length: 1 + next(40) }, () => next(file.length + 1)).sort((a, b) => a - b);
      const { out, error } = await drain(streamOf(split(file, offsets)).pipeThrough(age.decryptStream(checked.content)));
      expect(error, why).toBeNull();
      expect(same(out, plaintext), why).toBe(true);
      expect(same(await age.decryptBytes(upload.identity, file), plaintext), why).toBe(true);
      // A resuming sender recovers the same content key from the stored head and meta, a part worker from KEY, head and P.
      const p = 1 + next(count);
      expect(same(await age.encryptPart(checked.content, plaintext, p, { partSize }), parts[p - 1]), why).toBe(true);
      const reopened = await age.openContent(upload.key, upload.head, P);
      expect(same(await age.encryptPart(reopened, plaintext, p, { partSize }), parts[p - 1]), why).toBe(true);
    }
  });

  it('draws fresh randomness for every age file', async () => {
    const id = age.generateIdentity();
    const [a, b] = [await age.createContent(id, 1), await age.createContent(id, 1)];
    expect(toHex(a.head)).not.toBe(toHex(b.head));
    const meta = await age.createMeta(id, 'a.txt', 1, a.head);
    expect(toHex(meta.subarray(32, 75))).not.toBe(toHex(a.head.subarray(32, 75)));
    expect(toHex(meta.subarray(168, 184))).not.toBe(toHex(a.head.subarray(168, 184)));
    expect((await age.checkKey(id, a.head, meta, 201)).name).toBe('a.txt');
    expect(await asyncCode(() => age.checkKey(id, b.head, meta, 201))).toBe('corrupt');
  });

  it('normalises the name and refuses sizes the server would refuse', async () => {
    expect((await age.prepareUpload('a/b\u202e.txt', 5)).name).toBe('a_b_.txt');
    await expect(age.prepareUpload('a', 0)).rejects.toThrow(RangeError);
    await expect(age.prepareUpload('a', layout.constants.maxPlaintextSize + 1)).rejects.toThrow(RangeError);
    await expect(age.prepareUpload('a', 1000, { maxFileBytes: 1000 })).rejects.toThrow(RangeError);
    expect((await age.prepareUpload('a', 1000 - 200, { maxFileBytes: 1000 })).ciphertextSize).toBe(1000);
  });
});

describe('E2EE stream edge cases', () => {
  it('decrypts whatever the piece sizes, empty pieces included', async () => {
    for (const P of [0, 1, 65536, 65537, 196608]) {
      const key = await fixedContent(P), file = await contentFile(P), plaintext = pattern(P), { H, S } = age;
      const cuts = [
        [0, 0, 1, 1, 183, 184, 184, 185, H + S - 16, H + S - 1, H + S, H + S, H + S + 1, H + 2 * S - 1, H + 2 * S, file.length - 17, file.length - 16, file.length - 1, file.length],
        Array.from({ length: Math.min(file.length, 400) }, (_, i) => i),
        Array.from({ length: Math.floor(file.length / 4096) }, (_, i) => 4096 * (i + 1)),
      ];
      for (const offsets of cuts) {
        for (const decryptKey of [identity, key] as Key[]) {
          const { out, error } = await drain(age.decryptReadable(streamOf(split(file, offsets)), decryptKey));
          expect(error, `P ${P}`).toBeNull();
          expect(same(out, plaintext), `P ${P}`).toBe(true);
        }
      }
    }
    // One byte at a time through a whole two-chunk file.
    const file = await contentFile(65537);
    const { result, out } = await run(identity, Array.from({ length: file.length }, (_, i) => file.subarray(i, i + 1)));
    expect(result).toBe('success');
    expect(same(out, pattern(65537))).toBe(true);
  });

  it('finds damage however the stream is cut', async () => {
    const file = await contentFile(196608), next = prng(11);
    const cases: [string, Bytes][] = [
      ['trailing_data', concat([file, new Uint8Array(1)])], ['truncated', file.subarray(0, age.H + 2 * age.S)],
      ['corrupt', file.subarray(0, file.length - 1)], ['corrupt', concat([file.subarray(0, 300), Uint8Array.of(file[300] ^ 1), file.subarray(301)])],
      ['trailing_data', concat([file, file.subarray(age.H)])], ['truncated', file.subarray(0, 100)],
      // A stanza type running past the first 184 bytes: whether it ends later or never decides (§4.2 step 2).
      ['unsupported', concat([new TextEncoder().encode('age-encryption.org/v1\n-> ' + 'A'.repeat(300) + ' x\n'), file.subarray(0, 500)])],
      ['truncated', new TextEncoder().encode('age-encryption.org/v1\n-> ' + 'A'.repeat(300))],
    ];
    for (const [want, data] of cases) {
      for (let round = 0; round < 4; round++) {
        const offsets = Array.from({ length: 1 + next(8) }, () => next(data.length + 1)).sort((a, b) => a - b);
        const piecewise = await run(identity, split(data, offsets)), whole = await run(identity, [data]);
        expect(piecewise.result, `${want} at ${offsets}`).toBe(want);
        expect(toHex(piecewise.out)).toBe(toHex(whole.out));
        const { error } = await drain(age.decryptReadable(streamOf(split(data, offsets)), identity));
        expect(error?.code).toBe(want);
      }
    }
  });

  it('decides a stanza type that runs past the first 184 bytes from what follows', async () => {
    const long = new TextEncoder().encode('age-encryption.org/v1\n-> ' + 'A'.repeat(300) + ' x\n'), unended = long.subarray(0, 300);
    const head = await contentFile(1).then(file => file.subarray(0, age.H)), meta = hex(metas.valid[0].meta);
    for (const [want, data] of [['unsupported', long], ['truncated', unended]] as const) {
      for (const cuts of [[age.H], [age.H, age.H + 1], [age.H - 1, age.H + 1], [100, age.H, 250]]) {
        expect((await run(identity, split(data, cuts))).result, `${want} cut at ${cuts}`).toBe(want);
        expect((await drain(age.decryptReadable(streamOf(split(data, cuts)), identity))).error?.code, `${want} cut at ${cuts}`).toBe(want);
      }
    }
    // A type far longer than the call stack takes as arguments: compared as bytes, never spread into a string.
    const huge = concat([long.subarray(0, 25), new Uint8Array(200_000).fill(0x41), long.subarray(-3)]);
    expect(await asyncCode(() => age.decryptBytes(identity, huge))).toBe('unsupported');
    expect(await asyncCode(() => age.checkKey(identity, huge, meta, 201))).toBe('unsupported');
    expect(await asyncCode(() => age.checkKey(identity, head, huge, 201))).toBe('unsupported');
    expect(await asyncCode(() => age.openContent(identity, huge, 1))).toBe('unsupported');
  });

  it('reads nothing before the consumer does, and one source piece per chunk delivered', async () => {
    const P = 196608, file = await contentFile(P), pieces = [file.subarray(0, age.chunkOffset(1)), file.subarray(age.chunkOffset(1), age.chunkOffset(2)), file.subarray(age.chunkOffset(2))];
    let reads = 0;
    const source = new ReadableStream<Bytes>({
      pull(controller) {
        if (reads < pieces.length) controller.enqueue(pieces[reads].slice());
        else controller.close();
        reads++;
      },
    }, { highWaterMark: 0 });
    const reader = age.decryptReadable(source, await fixedContent(P)).getReader();
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    await settle();
    expect(reads).toBe(0);
    for (let chunk = 1; chunk <= 3; chunk++) {
      expect((await reader.read()).value?.length).toBe(age.CHUNK);
      await settle();
      expect(reads, `after chunk ${chunk}`).toBe(chunk);
    }
    expect((await reader.read()).done).toBe(true);
  });

  it('resumes on the same decryptor from its offset and checks the served head', async () => {
    const P = 196608, key = await fixedContent(P), file = await contentFile(P), plaintext = pattern(P);
    for (const decryptKey of [key, identity] as Key[]) {
      for (const cut of [0, 100, age.H, age.H + 5, age.chunkOffset(1) - 1, age.chunkOffset(1), age.chunkOffset(2) + 7, file.length - 1, file.length]) {
        // A source fails after `cut` bytes; restart() drops the unfinished chunk and the rest comes from offset.
        const decryptor = new age.Decryptor(decryptKey), out: Bytes[] = [], emit = (plaintext: Bytes) => out.push(plaintext);
        await decryptor.push(file.subarray(0, cut), emit);
        decryptor.restart();
        const verified = age.CHUNK * Math.max(0, Math.floor((cut - age.H) / age.S)), offset = cut < age.H ? 0 : age.chunkOffset(verified / age.CHUNK);
        if (cut < file.length) expect([decryptor.offset, decryptor.verified, decryptor.done], `cut ${cut}`).toEqual([offset, verified, false]);
        else expect([decryptor.offset, decryptor.verified, decryptor.done]).toEqual([file.length, P, true]);
        await decryptor.push(file.subarray(decryptor.offset), emit);
        await decryptor.end(emit);
        expect(same(concat(out), plaintext), `cut ${cut}`).toBe(true);
      }
    }
    // A resume can't skip or repeat chunks: the next bytes must be the chunk at offset.
    const skipping = new age.Decryptor(key);
    await skipping.push(file.subarray(0, age.chunkOffset(1)), () => {});
    expect(await asyncCode(() => skipping.push(file.subarray(age.chunkOffset(2)), () => {}))).toBe('corrupt');
    expect(() => skipping.restart()).toThrow(age.E2EEError);
    const other = await withRandom({ ...fixed(content.file), nonce: new Uint8Array(16) }, () => age.createContent(identity, P));
    expect((await run(other, [file])).result).toBe('corrupt');
    expect((await run(key, [file.subarray(0, 100)])).result).toBe('corrupt');
  });

  it('retries a failing source through open(offset) and gives up when open throws', async () => {
    const P = 196608, key = await fixedContent(P), file = await contentFile(P), plaintext = pattern(P);
    const offsets: number[] = [], failAt = [70, age.chunkOffset(1) + 3, age.chunkOffset(2) + 1000];
    // Each attempt delivers 1000-byte pieces from the offset asked for and breaks once at the next failure point.
    const open: Open = offset => {
      offsets.push(offset);
      const stop = failAt.find(at => at > offset) ?? Infinity;
      let at = offset;
      return new ReadableStream<Bytes>({
        pull(controller) {
          if (at >= stop) { failAt.splice(failAt.indexOf(stop), 1); controller.error(new TypeError('network down')); return; }
          if (at >= file.length) { controller.close(); return; }
          const end = Math.min(at + 1000, stop, file.length);
          controller.enqueue(file.slice(at, end));
          at = end;
        },
      }, { highWaterMark: 0 });
    };
    const { out, error } = await drain(age.decryptReadable(open, key));
    expect(error).toBeNull();
    expect(same(out, plaintext)).toBe(true);
    expect(offsets).toEqual([0, 0, age.chunkOffset(1), age.chunkOffset(2)]);
    let attempts = 0;
    const giveUp: Open = (offset, failure) => {
      if (attempts++) throw failure;
      let sent = false;
      return new ReadableStream<Bytes>({
        pull(controller) {
          if (sent) controller.error(new TypeError('reset'));
          else { sent = true; controller.enqueue(file.slice(offset, age.chunkOffset(1) + 5)); }
        },
      }, { highWaterMark: 0 });
    };
    const stopped = await drain(age.decryptReadable(giveUp, key));
    expect([stopped.error?.message, stopped.out.length]).toEqual(['reset', age.CHUNK]);
  });

  it('stops at the first error and keeps reporting it', async () => {
    // A full final chunk verifies on push; a short one waits for end(), which alone knows the input is over.
    const file = await contentFile(65536), decryptor = new age.Decryptor(identity), out: Bytes[] = [];
    await decryptor.push(file, plaintext => out.push(plaintext));
    expect(decryptor.done).toBe(true);
    expect(out.length).toBe(1);
    await expect(decryptor.push(new Uint8Array(1), () => {})).rejects.toMatchObject({ code: 'trailing_data' });
    await expect(decryptor.end(() => {})).rejects.toMatchObject({ code: 'trailing_data' });
    const busy = new age.Decryptor(identity), first = busy.push(file.subarray(0, 200), () => {});
    await expect(busy.push(file.subarray(200), () => {})).rejects.toThrow(/Await/);
    await first;
  });

  it('passes a source error through and cancels the source on damage', async () => {
    const file = await contentFile(131072);
    let cancelled: unknown = null;
    let pulls = 0;
    const failing = new ReadableStream<Bytes>({
      pull(controller) {
        if (pulls++) controller.error(new TypeError('network down'));
        else controller.enqueue(file.subarray(0, age.H + age.S + 10));
      },
    }, { highWaterMark: 0 });
    const { out, error } = await drain(age.decryptReadable(failing, identity));
    expect(error?.message).toBe('network down');
    expect(out.length).toBe(age.CHUNK);
    const damaged = new ReadableStream<Bytes>({
      start(controller) { controller.enqueue(concat([file.subarray(0, 300), Uint8Array.of(file[300] ^ 1), file.subarray(301, age.H + age.S + 1)])); },
      cancel(reason) { cancelled = reason; },
    });
    expect((await drain(age.decryptReadable(damaged, identity))).error?.code).toBe('corrupt');
    expect((cancelled as CodedError).code).toBe('corrupt');
  });
});

describe('E2EE key material stays inside', () => {
  it('keeps the payload key out of content keys and every message out of the key', async () => {
    const upload = await age.prepareUpload('secret.txt', 10);
    const key = upload.content;
    expect(Object.keys(key)).toEqual(['head', 'size']);
    expect(Object.isFrozen(key)).toBe(true);
    expect(JSON.stringify(key)).not.toMatch(upload.key);
    const clone = structuredClone(key);
    await expect(age.encryptPart(clone, new Uint8Array(10), 1)).rejects.toThrow(TypeError);
    for (const attempt of [
      () => age.parseKeyEntry(upload.key.slice(0, 42) + '!', 'x', ORIGIN), () => age.decodeKey(upload.key + 'A'),
      () => age.parseLink(`${ORIGIN}/d/x#${upload.key}=`, ORIGIN),
    ]) {
      try { attempt(); } catch (error) { expect(String((error as Error).message)).not.toContain(upload.key.slice(0, 20)); expect((error as Error).stack ?? '').not.toContain(upload.key.slice(0, 20)); }
    }
  });
});

describe('E2EE MD5 (RFC 1321)', () => {
  it('matches the RFC test suite and the padding edges', () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const suite: [string, string][] = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'], ['a', '0cc175b9c0f1b6a831c399e269772661'], ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'], ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
      ['1234567890'.repeat(8), '57edf4a22be3c955ac49da2e2107b67a'],
      ['a'.repeat(55), 'ef1772b6dff9a122358552954ad0df65'], ['a'.repeat(56), '3b0c8ac703f828b04c6c197006d17218'],
      ['a'.repeat(63), 'b06521f39153d618550606be297466d5'], ['a'.repeat(64), '014842d480b571495a4a0363793f7367'],
      ['a'.repeat(65), 'c743a45e0d2e6a95cb859adae0248435'],
    ];
    for (const [input, want] of suite) expect(age.md5Hex(text(input)), input.slice(0, 10)).toBe(want);
    expect(age.contentMd5(text(''))).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
    // Unaligned views (a part buffer's subarray) take the byte-by-byte path; it must agree with the aligned one.
    const buffer = randomBytes(300);
    for (const k of [1, 2, 3, 5]) expect(age.md5Hex(buffer.subarray(k)), `offset ${k}`).toBe(age.md5Hex(buffer.slice(k)));
    expect(age.md5Hex(text('a'.repeat(65)).subarray(1))).toBe('014842d480b571495a4a0363793f7367');
  });
});

// A benchmark, not a check: the round trips above already cross part boundaries. FYL_BENCH=1 npx vitest run e2ee-core runs it.
describe('E2EE performance', () => {
  it.runIf(inject('bench'))('measures encryption and decryption throughput in this runtime', async () => {
    const P = 50 * 1024 * 1024, plaintext = randomBytes(P), mib = P / 1048576;
    const upload = await age.prepareUpload('speed.bin', P);
    let started = performance.now();
    const first = await age.encryptPart(upload.content, plaintext, 1);
    const encrypt = performance.now() - started;
    const second = await age.encryptPart(upload.content, plaintext, 2);
    started = performance.now();
    age.md5(first);
    const md5 = performance.now() - started;
    const file = concat([first, second]), pieces = split(file, Array.from({ length: Math.floor(file.length / 65536) }, (_, i) => 65536 * (i + 1)));
    started = performance.now();
    const { out, error } = await drain(streamOf(pieces).pipeThrough(age.decryptStream(upload.content)));
    const decrypt = performance.now() - started;
    expect(error).toBeNull();
    expect(await sha256(out)).toBe(await sha256(plaintext));
    const rate = (ms: number) => (mib / (ms / 1000)).toFixed(0) + ' MiB/s';
    // Vitest runs dist/ through Vite's module transform, which turns noble's imported rotl() into a getter call per use:
    // ChaCha20 runs several times slower here than as native modules in a browser or a plain workerd.
    console.log(`E2EE throughput over ${mib} MiB: encrypt ${rate(encrypt)}, MD5 ${rate(md5)}, stream decrypt ${rate(decrypt)}`);
  });
});

interface CrossPart { part: number; start: number; end: number; sha256: string; md5: string; contentMd5: string }
interface CrossDoc {
  vectors: {
    why: string; tool?: string; input: string; name: string; plaintextSize: number; seed: string; plaintextSha256: string; key: string; ageIdentity: string;
    recipient: string; id: string; link: string; ciphertextSize: number; head: string; meta: string; sha256: string; partSize: number; parts: CrossPart[]; ciphertext?: string;
  }[];
}

describe('E2EE interoperability (cross/*.json)', () => {
  // Vectors the browser core, the Rust core and the reference age CLI wrote (scripts/e2ee_interop.mjs, docs/E2EE.md
  // "Interoperability evidence"). Plaintext: ChaCha20-Poly1305 with key seed and the zero nonce over zero bytes, tag dropped.
  const keystream = async (seed: Bytes, size: number) => {
    // @ts-expect-error: plain ES module without type declarations.
    const { chacha20poly1305 } = await import('../dist/vendor/noble-ciphers-2.4.0/chacha.js');
    return (chacha20poly1305(seed, new Uint8Array(12)).encrypt(new Uint8Array(size)) as Bytes).subarray(0, size);
  };

  for (const producer of ['browser', 'rust', 'age']) {
    it(`opens, rebuilds and decrypts every ${producer} vector`, async () => {
      const { vectors } = doc<CrossDoc>(`cross/${producer}`);
      expect(vectors.length).toBeGreaterThan(0);
      for (const v of vectors) {
        const why = `${producer}: ${v.why}`, C = v.ciphertextSize, P = v.plaintextSize, identity = age.decodeKey(v.key);
        expect([age.encodeAgeIdentity(identity), await age.ageRecipient(identity), age.encodeKey(age.decodeAgeIdentity(v.ageIdentity))], why)
          .toEqual([v.ageIdentity, v.recipient, v.key]);
        expect([age.normalizeName(v.input), age.ciphertextSize(P), age.partCount(C, v.partSize)], why).toEqual([v.name, C, v.parts.length]);
        // The keyed link as shareLink() builds it, parsed, and every key-field form of it.
        expect(age.shareLink(ORIGIN, v.id, `${ORIGIN}/d/${v.id}`, v.key), why).toBe(v.link);
        expect([age.parseLink(v.link, ORIGIN), age.parseLink(`${ORIGIN}/d/${v.id}`, ORIGIN)], why).toEqual([{ id: v.id, key: v.key, exposed: false }, { id: v.id, key: null, exposed: false }]);
        for (const entry of [v.key, v.link, `${ORIGIN}/d/${v.id}%23${v.key}`, v.ageIdentity, v.ageIdentity.toLowerCase()]) {
          expect(age.parseKeyEntry(` \t\f${entry}\r\n`, v.id, ORIGIN), `${why}: ${entry}`).toBe(v.key);
        }
        expect(code(() => age.parseKeyEntry(v.link, 'other', ORIGIN)), why).toBe('other_transfer');
        const plaintext = await keystream(hex(v.seed), P);
        expect(await sha256(plaintext), why).toBe(v.plaintextSha256);
        const checked = await age.checkKey(identity, hex(v.head), hex(v.meta), C);
        expect([checked.name, checked.size], why).toEqual([v.name, P]);
        // The producer's file rebuilt from its head, part by part, last first: equal hashes mean equal bytes.
        const file = new Uint8Array(C);
        for (const want of [...v.parts].reverse()) {
          const part = await age.encryptPart(checked.content, plaintext, want.part, { partSize: v.partSize }), { start, end } = age.partRange(C, want.part, v.partSize);
          expect({ part: want.part, start, end, sha256: await sha256(part), md5: age.md5Hex(part), contentMd5: age.contentMd5(part) }, why).toEqual(want);
          file.set(part, start);
        }
        expect(await sha256(file), why).toBe(v.sha256);
        if (v.ciphertext) expect(toHex(file), why).toBe(v.ciphertext);
        // Decrypted as a download does (content key, verified head, odd pieces) and whole with the identity.
        const pieces = split(file, Array.from({ length: Math.floor(C / 4093) }, (_, i) => 4093 * (i + 1)));
        const { out, error } = await drain(age.decryptReadable(streamOf(pieces), checked.content));
        expect([error, same(out, plaintext)], why).toEqual([null, true]);
        const whole = await run(identity, [file], { verifiedHead: hex(v.head) });
        expect([whole.result, same(whole.out, plaintext)], why).toEqual(['success', true]);
      }
    });
  }
});
