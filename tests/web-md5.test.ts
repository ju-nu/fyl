import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// dist/md5-worker.js with the vendored SparkMD5, run here as the worker script it is: importScripts() puts the
// library where a worker has it (here it loads as a CommonJS module), and postMessage() collects the answers.
type Message = { read?: number; hash?: string | null };
const messages: Message[] = [];
let handle: (event: { data: Blob }) => Promise<void>;

beforeAll(async () => {
  // @ts-expect-error: a browser script without type declarations.
  const spark = (await import('../dist/vendor/spark-md5-3.0.2.js')).default;
  const loaded: string[] = [];
  vi.stubGlobal('importScripts', (path: string) => { loaded.push(path); vi.stubGlobal('SparkMD5', spark); });
  vi.stubGlobal('postMessage', (message: Message) => { messages.push(message); });
  // @ts-expect-error: a worker script without type declarations; it sets self.onmessage.
  await import('../dist/md5-worker.js');
  handle = (globalThis as unknown as { onmessage: typeof handle }).onmessage;
  expect(loaded).toEqual(['vendor/spark-md5-3.0.2.js']);
});
afterAll(() => { vi.unstubAllGlobals(); });

const hashOf = async (blob: Blob) => {
  messages.length = 0;
  await handle({ data: blob });
  return messages;
};

describe('part hashing worker', () => {
  it('computes the MD5 R2 reports as a part ETag', async () => {
    expect((await hashOf(new Blob(['abc']))).at(-1)).toEqual({ hash: '900150983cd24fb0d6963f7d28e17f72' });
    expect((await hashOf(new Blob([]))).at(-1)).toEqual({ hash: 'd41d8cd98f00b204e9800998ecf8427e' });
  });

  it('reads a part in chunks with progress', async () => {
    // The expected hash comes from Python's hashlib over the same bytes (i % 251).
    const bytes = Uint8Array.from({ length: 9 * 1024 * 1024 + 123 }, (_, index) => index % 251);
    const answers = await hashOf(new Blob([bytes]));
    expect(answers.slice(0, -1)).toEqual([{ read: 4194304 }, { read: 8388608 }, { read: bytes.length }]);
    expect(answers.at(-1)).toEqual({ hash: 'd1ecb7666526194fe34b19b663f2a13e' });
  });

  it('answers null when the file cannot be read', async () => {
    const unreadable = { size: 10, slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) }) } as unknown as Blob;
    expect(await hashOf(unreadable)).toEqual([{ hash: null }]);
  });
});
