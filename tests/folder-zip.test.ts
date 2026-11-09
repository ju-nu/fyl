import { beforeAll, describe, expect, it, vi } from 'vitest';
import basic from './vectors/folder-zip/basic.json';
import lengths from './vectors/folder-zip/lengths.json';
import names from './vectors/folder-zip/names.json';
import refusals from './vectors/folder-zip/refusals.json';
import times from './vectors/folder-zip/times.json';
import zip64 from './vectors/folder-zip/zip64.json';

// dist/zip.js (the page's folder zip, docs/FOLDER-ZIP.md) and the CRC-32 of dist/e2ee/crc32.js must give exactly the
// bytes of tests/vectors/folder-zip/, which scripts/folder_zip.py writes and the Rust CLI is held to as well. A tree is
// handed over as a walk lists it: every item with its path components below the folder (bytes where the vector has
// pathHex), its kind and its contents as a Blob.
interface Entry { path: string; bytes: Uint8Array; size: number; mtime: number; file: Blob | null }
interface Layout { entries: Entry[]; rows: { offset: number; local: number; central: number; large: boolean; far: boolean }[]; centralOffset: number; centralSize: number; zip64End: boolean; size: number }
type Segment = { bytes: Uint8Array } | { entry: number; size: number };
interface Zip {
  MAX_ENTRIES: number;
  clean(name: string | Uint8Array): string | null;
  gather(root: string, items: object[]): { root: string; entries: Entry[]; skipped: { parts: (string | Uint8Array)[]; reason: string }[] };
  layout(entries: Entry[]): Layout;
  check(entries: Entry[], limit: number): Layout;
  segments(out: Layout, crcs: number[]): Segment[];
  file(root: string, out: Layout, crcs: number[]): File;
  dataRanges(out: Layout): [number, number][];
  fingerprint(entries: Entry[]): Promise<string>;
}
interface Node { path?: string; pathHex?: string; text?: string; base64?: string; type?: string; mtimeMs?: number }
let zip: Zip, crc32: (bytes: Uint8Array, crc?: number) => number, crc32Combine: (a: number, b: number, length: number) => number;
let crcFiles: (files: Blob[], emit?: (read: number) => void) => Promise<number[]>;

const FIXED_MS = 1793260800000, GIB = 1024 ** 3, LIMIT = 50 * GIB;
const utf8 = (text: string) => new TextEncoder().encode(text);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) || [], byte => parseInt(byte, 16));
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const split = (bytes: Uint8Array) => {
  const parts: Uint8Array[] = [];
  let from = 0;
  bytes.forEach((byte, i) => { if (byte === 0x2F) { parts.push(bytes.subarray(from, i)); from = i + 1; } });
  return [...parts, bytes.subarray(from)];
};
const contents = (node: Node) => node.base64 ? Uint8Array.from(atob(node.base64), char => char.charCodeAt(0)) : utf8(node.text || '');
const items = (tree: Node[]) => tree.map(node => ({
  parts: node.pathHex ? split(fromHex(node.pathHex)) : (node.path as string).split('/'),
  kind: ({ fifo: 'special' } as Record<string, string>)[node.type || ''] || node.type || 'file',
  size: node.type ? 0 : contents(node).length, mtimeMs: node.mtimeMs ?? FIXED_MS, file: node.type ? null : new Blob([contents(node)]),
}));
// A skipped item as the vectors write it: its path below the folder, as text where it is UTF-8.
const shown = (parts: (string | Uint8Array)[]) => {
  const bytes = new Uint8Array(parts.flatMap((part, i) => [...(i ? [0x2F] : []), ...(typeof part === 'string' ? utf8(part) : part)]));
  try { return { path: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; } catch { return { pathHex: hex(bytes) }; }
};
const empty = (path: string, size = 0): Entry => ({ path, bytes: utf8(path), size, mtime: Math.floor(FIXED_MS / 1000), file: null });

beforeAll(async () => {
  vi.stubGlobal('window', globalThis);
  // @ts-expect-error: a browser script without type declarations; it defines window.FylZip.
  await import('../dist/zip.js');
  zip = (globalThis as unknown as { FylZip: Zip }).FylZip;
  // @ts-expect-error: a browser module without type declarations.
  ({ crc32, crc32Combine } = await import('../dist/e2ee/crc32.js'));
  // @ts-expect-error: a browser module without type declarations.
  ({ crcFiles } = await import('../dist/e2ee/jobs.js'));
});

describe('folder zip vectors (docs/FOLDER-ZIP.md)', () => {
  for (const vector of [basic, names, times, lengths] as unknown as { root: string; tree: Node[]; entries: { path: string; size: number; mtime: number; crc32: string; offset: number }[]; skipped: object[]; fingerprint: string; size: number; sha256: string; zip: string }[]) {
    it(`builds ${vector.root} byte for byte: order, names, times, skipped items, fingerprint`, async () => {
      const { root, entries, skipped } = zip.gather(vector.root, items(vector.tree));
      expect(root).toBe(vector.root);
      expect(skipped.map(item => ({ ...shown(item.parts), reason: item.reason }))).toEqual(vector.skipped);
      const out = zip.check(entries, LIMIT);
      const crcs = await crcFiles(entries.map(entry => entry.file as Blob));
      expect(entries.map((entry, i) => ({ path: entry.path, size: entry.size, mtime: entry.mtime, crc32: crcs[i].toString(16).padStart(8, '0'), offset: out.rows[i].offset })))
        .toEqual(vector.entries);
      const bytes = new Uint8Array(await zip.file(root, out, crcs).arrayBuffer());
      expect([out.size, bytes.length]).toEqual([vector.size, vector.size]);
      expect(hex(bytes)).toBe(vector.zip);
      expect(await sha256(bytes)).toBe(vector.sha256);
      expect(await zip.fingerprint(entries)).toBe(vector.fingerprint);
      expect(zip.file(root, out, crcs).name).toBe(root + '.zip');
    });
  }

  it('reads a zip part by offset from the composed File, as a resume rebuilds it', async () => {
    const { root, entries } = zip.gather(basic.root, items(basic.tree as Node[]));
    const out = zip.check(entries, LIMIT), crcs = await crcFiles(entries.map(entry => entry.file as Blob)), file = zip.file(root, out, crcs);
    for (const [start, end] of [[0, 1], [40, 400], [500, 946], [945, 946]])
      expect(hex(new Uint8Array(await file.slice(start, end).arrayBuffer()))).toBe(basic.zip.slice(2 * start, 2 * end));
    // Each entry's data sits where dataRanges() says: its CRC over those bytes is the pre-pass's.
    const bytes = new Uint8Array(await file.arrayBuffer());
    zip.dataRanges(out).forEach(([start, end], i) => expect(crc32(bytes.subarray(start, end))).toBe(crcs[i]));
  });

  it('decides every ZIP64 field around the thresholds by formula, up to exactly 50 GiB', () => {
    for (const vector of zip64.formula) {
      const entries = vector.files.map(file => empty(vector.root + '/' + file.path, file.size));
      const out = zip.layout(entries);
      expect(out.rows.map((row, i) => ({ path: entries[i].path, size: entries[i].size, crc32: vector.entries[i].crc32, offset: row.offset, local: row.local,
        central: row.central, zip64Sizes: row.large, zip64Offset: row.far })), vector.name).toEqual(vector.entries);
      expect([out.centralOffset, out.centralSize, out.zip64End, out.size], vector.name).toEqual([vector.centralOffset, vector.centralSize, vector.zip64End, vector.size]);
      const segments = zip.segments(out, vector.entries.map(entry => parseInt(entry.crc32, 16)));
      expect(segments.map(segment => 'bytes' in segment ? { hex: hex(segment.bytes) } : { zeros: segment.size }), vector.name).toEqual(vector.segments);
      expect({ raw: out.size <= LIMIT, e2ee: out.size <= 53_673_987_000 }, vector.name).toEqual(vector.fits);
    }
  });

  it('switches to the ZIP64 end records at 65,535 entries', async () => {
    for (const vector of zip64.built) {
      const entries = Array.from({ length: vector.count }, (_, i) => empty('many/' + String(i).padStart(5, '0')));
      const out = zip.check(entries, LIMIT);
      const bytes = new Uint8Array(await new Blob(zip.segments(out, entries.map(() => 0)).map(segment => (segment as { bytes: Uint8Array }).bytes)).arrayBuffer());
      expect([out.centralOffset, out.centralSize, out.zip64End, bytes.length]).toEqual([vector.centralOffset, vector.centralSize, vector.zip64End, vector.size]);
      expect(hex(bytes.subarray(bytes.length - 98))).toBe(vector.tail);
      expect(await sha256(bytes)).toBe(vector.sha256);
    }
  });

  it('refuses a folder as a whole: nothing to send, a collision, too many files, too large', () => {
    const refusal = (run: () => unknown) => { try { run(); return null; } catch (error) { const { code, detail } = error as { code: string; detail: string }; return { code, detail: detail || undefined }; } };
    for (const vector of refusals.trees) {
      const { entries } = zip.gather(vector.root, items(vector.tree as Node[]));
      expect(refusal(() => zip.check(entries, LIMIT)), vector.name).toEqual({ code: vector.code, detail: (vector as { detail?: string }).detail });
    }
    for (const vector of refusals.counts) {
      const entries = Array.from({ length: vector.files }, (_, i) => empty('many/' + String(i).padStart(6, '0')));
      expect(refusal(() => zip.check(entries, LIMIT))?.code ?? null).toBe(vector.code);
    }
    for (const vector of refusals.sizes) {
      const entries = vector.files.map(file => empty(vector.root + '/' + file.path, file.size));
      expect(refusal(() => zip.check(entries, vector.limit))?.code ?? null, vector.description).toBe(vector.code);
    }
  });

  it('names: drops bidi controls, keeps NFC and NFD apart, skips what an extractor would misread', () => {
    expect(zip.clean('WhatsApp Chat mit \u202A+43 660 1234567\u202C.txt')).toBe('WhatsApp Chat mit +43 660 1234567.txt');
    expect(zip.clean('\u00E4.txt')).not.toBe(zip.clean('a\u0308.txt'));
    for (const name of ['', '.', '..', '...', '\u200E', 'a/b', 'a\\b', 'tab\there', 'nel\u0085', 'para\u2029', 'lone\uD800', 'n'.repeat(256), new Uint8Array([0x6C, 0xE9])])
      expect(zip.clean(name), String(name)).toBeNull();
    expect(zip.clean('n'.repeat(255))).toBe('n'.repeat(255));
    expect(zip.clean(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]))).toBe('\uFEFFa'); // a byte order mark stays part of the name
  });
});

describe('CRC-32 (dist/e2ee/crc32.js)', () => {
  it('combines the CRCs of two pieces as zlib does', () => {
    const data = Uint8Array.from({ length: 100_000 }, (_, i) => i * 7 % 251);
    for (const vector of zip64.crc32Combine) {
      expect(crc32(data.subarray(0, vector.split)).toString(16).padStart(8, '0')).toBe(vector.crc1);
      expect(crc32(data.subarray(vector.split)).toString(16).padStart(8, '0')).toBe(vector.crc2);
      expect(crc32Combine(parseInt(vector.crc1, 16), parseInt(vector.crc2, 16), vector.length - vector.split).toString(16).padStart(8, '0')).toBe(vector.crc);
    }
    expect(crc32(utf8('123456789'))).toBe(0xCBF43926);
    expect(crc32(utf8('56789'), crc32(utf8('1234')))).toBe(0xCBF43926);
  });

  it('gives the CRC of zeros beyond 4 GiB by combining, as the ZIP64 vectors have it', () => {
    // crc32_zeros() of the reference: doubling a block of zeros.
    const zeros = (n: number) => {
      let crc = 0, block = crc32(new Uint8Array(1)), size = 1;
      for (; n; n = Math.floor(n / 2)) {
        if (n % 2) crc = crc32Combine(crc, block, size);
        if (n > 1) { block = crc32Combine(block, block, size); size *= 2; }
      }
      return crc;
    };
    for (const vector of zip64.formula) for (const entry of vector.entries) expect(zeros(entry.size).toString(16).padStart(8, '0'), entry.path).toBe(entry.crc32);
  });

  it('reads every file once in the pre-pass, small ones several to a read, and names a file that changed', async () => {
    const big = Uint8Array.from({ length: 9 * 1048576 + 5 }, (_, i) => i % 253);
    const files = [new Blob(['a']), new Blob([]), new Blob([big]), ...Array.from({ length: 600 }, (_, i) => new Blob(['file ' + i]))];
    const reads: number[] = [];
    const crcs = await crcFiles(files, read => reads.push(read));
    expect(crcs).toEqual(await Promise.all(files.map(async file => crc32(new Uint8Array(await file.arrayBuffer())))));
    expect(reads.at(-1)).toBe(files.reduce((sum, file) => sum + file.size, 0));
    // 1 batch of the two small ones, 3 pieces of the big file, then 600 small ones in batches of 512.
    expect(reads.length).toBe(1 + 3 + 2);
    const gone = { size: 3, slice: () => gone, arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) } as unknown as Blob;
    await expect(crcFiles([new Blob(['ok']), gone, new Blob(['x'])])).rejects.toMatchObject({ code: 'file_changed', index: 1 });
    const shrunk = { size: 5, slice: () => shrunk, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Blob;
    await expect(crcFiles([new Blob(['ok']), new Blob(['x']), shrunk])).rejects.toMatchObject({ code: 'file_changed', index: 2 });
  });
});
