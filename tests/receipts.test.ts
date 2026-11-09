import { describe, expect, it } from 'vitest';
import { resumeToken } from '../src/shared';
import vectors from './vectors/receipts.json';
import { post, part, useNetworkPrefix, type Session } from './helpers';
import { sealedFile } from './sealed';

useNetworkPrefix('198.18.10.');

type Vector = { note: string; variant?: string; uploadId: string; size: number; manage: boolean; valid: boolean; receipt: unknown };
type Receipt = Record<string, unknown>;
const pattern = new RegExp(vectors.url);
/** The receipt check of contract §4, as the browser (dist/api.js) and the CLI (receipt() in cli-rs) make it. */
const isReceipt = (body: unknown, uploadId: string, size: number, manage: boolean) => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const { url, transferId, expiresAt, managementUrl } = body as Receipt;
  return typeof url === 'string' && pattern.test(url) && transferId === uploadId && typeof expiresAt === 'number' && Number.isFinite(expiresAt)
    && (body as Receipt).size === size && (!manage || typeof managementUrl === 'string');
};
const kind = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const shape = (receipt: Receipt) => Object.fromEntries(Object.keys(receipt).sort().map(key => [key, kind(receipt[key])]));

/** Starts an upload of `size` bytes, sends it and completes it with the management key or the resume token. */
async function completed(name: string, size: number, options: { once?: boolean; password?: string; expiresIn?: number }, manage: boolean) {
  const started = await post('/api/upload/init', { filename: name, size, oneTime: options.once ?? false, expiresIn: options.expiresIn ?? 86400, password: options.password });
  expect(started.status).toBe(201);
  const session = await started.json<Session>(), parts = [await part(session, new Uint8Array(size).fill(1))];
  const body = { uploadId: session.uploadId, key: manage ? session.key : await resumeToken(session.key), parts };
  const first = await post('/api/upload/complete', body);
  expect(first.status).toBe(200);
  const receipt = await first.json<Receipt>();
  // A completion asked for again answers the same receipt (§4): a client whose answer was lost repeats it.
  expect(await (await post('/api/upload/complete', body)).json()).toEqual(receipt);
  return { session, receipt };
}

describe('completion receipts (tests/vectors/receipts.json)', () => {
  it('pins the receipt check: every vector is a receipt or not as it says', () => {
    const all = vectors.cases as Vector[];
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter(vector => vector.valid).length).toBeGreaterThan(5);
    for (const vector of all) expect(isReceipt(vector.receipt, vector.uploadId, vector.size, vector.manage), vector.note).toBe(vector.valid);
  });

  it('sends receipts shaped like the vectors of every variant, which pass the check', async () => {
    const variants = (vectors.cases as Vector[]).filter(vector => vector.variant);
    expect(variants.map(vector => vector.variant)).toEqual(['key', 'resume', 'protected-key', 'protected-resume', 'once-key', 'e2ee-key']);
    for (const vector of variants) {
      const expected = vector.receipt as Receipt, protectedFile = expected.protected === true;
      // An encrypted upload of 14 bytes stores C = 214 (docs/E2EE.md §6); its receipt carries no name (§7 step 5).
      const { session, receipt } = expected.mode === 'e2ee' ? await sealedFile(Number(expected.size) - 200)
        : await completed(String(expected.name), Number(expected.size),
          { once: expected.once === true, password: protectedFile ? 'tide-lamp-41' : undefined, expiresIn: Number(expected.minutes) * 60 }, vector.manage);
      expect([receipt.mode, receipt.name === null], vector.variant).toEqual([expected.mode, expected.name === null]);
      expect(shape(receipt), vector.variant).toEqual(shape(expected));
      expect(isReceipt(receipt, session.uploadId, Number(expected.size), vector.manage), vector.variant).toBe(true);
      // The same link form: a protected file's link never names it.
      expect(String(receipt.url).endsWith(`/d/${session.uploadId}`), vector.variant).toBe(String(expected.url).endsWith(`/d/${vector.uploadId}`));
      expect([receipt.protected, receipt.once, receipt.minutes, receipt.state], vector.variant).toEqual([expected.protected, expected.once, expected.minutes, expected.state]);
    }
  });
});
