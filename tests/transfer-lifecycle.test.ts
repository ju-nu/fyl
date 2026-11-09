import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PART_BYTES, digest, randomToken } from '../src/shared';
import {
  call, post, init, part, put, finish, file, pathOf, pageOf, operator, pause, record, edit, swap, useNetworkPrefix, type Receipt, type Session,
} from './helpers';

useNetworkPrefix('198.18.1.');

const parts = (id: string) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) =>
  ctx.storage.sql.exec('SELECT number, size, etag, attempts, active FROM parts ORDER BY number').toArray());
const takedown = (id: string) => operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id, note: 'test takedown' }) });
const remove = (receipt: Receipt) => call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } });
// The public reason a closed link gives (the name in a download path is never checked).
const reason = async (id: string) => {
  const response = await call(`/d/${id}/x`);
  expect(response.status).toBe(410);
  return (await response.json<{ code: string }>()).code;
};
// The Durable Object's own R2 binding with some methods replaced.
const bucket = (files: R2Bucket, overrides: Partial<R2Bucket>) => ({
  head: (key: string) => files.head(key), delete: (keys: string | string[]) => files.delete(keys),
  resumeMultipartUpload: (key: string, uploadId: string) => files.resumeMultipartUpload(key, uploadId),
  ...overrides,
}) as unknown as R2Bucket;

describe('part attempts and final transfer states', () => {
  it('does not count refused part attempts, so an upload interrupted by a pause stays resumable', async () => {
    const first = new Uint8Array(PART_BYTES).fill(42), last = new Uint8Array([7, 8, 9]);
    const session = await init(PART_BYTES + last.length);
    const done = await part(session, first, 1);
    expect((await pause(true)).status).toBe(200);
    try {
      // More refusals than any attempt limit allows, for the missing part and for re-uploads of the charged one.
      for (let attempt = 0; attempt < 8; attempt++) {
        for (const [number, payload] of [[2, last], [1, first]] as const) {
          const refused = await put(session, payload, number);
          expect(refused.status).toBe(503);
          expect((await refused.json<{ code: string }>()).code).toBe('uploads_paused');
        }
      }
      expect(await parts(session.uploadId)).toEqual([{ number: 1, size: PART_BYTES, etag: done.etag, attempts: 1, active: 0 }]);
    } finally {
      expect((await pause(false)).status).toBe(200);
    }
    // Resume: the missing part goes through and the stored part completes the file.
    const tail = await part(session, last, 2);
    const receipt = await finish(session, [done, tail]);
    const response = await call(pathOf(receipt.url), { headers: { Range: `bytes=${PART_BYTES - 1}-` } });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([42, 7, 8, 9]));
  });

  it('keeps an operator takedown final even when the sender aborts or deletes afterwards', async () => {
    const { receipt, session } = await file();
    expect((await takedown(receipt.id)).status).toBe(200);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
    expect((await remove(receipt)).status).toBe(200);
    expect((await takedown(receipt.id)).status).toBe(200);
    expect((await record(session.uploadId)).status).toBe('removed');
    expect(await reason(receipt.id)).toBe('removed');
    const page = await call(pathOf(receipt.url), { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(410);
    expect((await pageOf(page)).data).toMatchObject({ state: 'gone', reason: 'removed' });
    const owner = await call(`/api/transfers/${receipt.id}`, { headers: { Authorization: 'Bearer ' + receipt.deleteToken } });
    expect((await owner.json<{ code: string }>()).code).toBe('removed');
    // Taken down mid-upload: the sender's abort keeps the reason and no further part is accepted.
    const payload = new TextEncoder().encode('taken down mid-upload');
    const upload = await init(payload.length);
    expect((await takedown(upload.uploadId)).status).toBe(200);
    expect((await post('/api/upload/abort', upload)).status).toBe(200);
    expect((await put(upload, payload, 1)).status).toBe(410);
    expect((await record(upload.uploadId)).status).toBe('removed');
  });

  it('keeps the public reason when the sender deletes a link that already expired or was used up', async () => {
    // Expired through the alarm.
    const expired = await file(), stub = env.TRANSFERS.getByName(expired.session.uploadId);
    await edit(expired.session.uploadId, record => { record.expiresAt = Date.now() - 1; });
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await remove(expired.receipt)).status).toBe(200);
    expect(await reason(expired.receipt.id)).toBe('expired');
    // Lapsed before its alarm ran: deleting it still says expired, and the bytes go right away.
    const lapsed = await file();
    await edit(lapsed.session.uploadId, record => { record.expiresAt = Date.now() - 1; });
    expect((await remove(lapsed.receipt)).status).toBe(200);
    expect(await env.FILES.head(`files/${lapsed.session.uploadId}`)).toBeNull();
    expect(await reason(lapsed.receipt.id)).toBe('expired');
    // A used-up one-time link.
    const once = await file(true);
    const download = await call(pathOf(once.receipt.url), {}, '198.18.1.251');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(once.payload);
    await env.TRANSFERS.getByName(once.session.uploadId).finishConsumed();
    expect((await remove(once.receipt)).status).toBe(200);
    expect(await reason(once.receipt.id)).toBe('consumed');
    // A live link is deleted as before.
    const ready = await file();
    expect((await remove(ready.receipt)).status).toBe(200);
    expect(await env.FILES.head(`files/${ready.session.uploadId}`)).toBeNull();
    expect(await reason(ready.receipt.id)).toBe('deleted');
  });

  it('allows twenty admitted attempts per part', async () => {
    const payload = new TextEncoder().encode('retried part');
    const session = await init(payload.length);
    try {
      for (let attempt = 0; attempt < 20; attempt++) await part(session, payload, 1);
      // Final for this part, so clients stop instead of retrying (it was a retryable 429 before 2.3.0).
      const limited = await put(session, payload, 1);
      expect(limited.status).toBe(409);
      expect(await limited.json()).toEqual({ error: 'This part has reached its retry limit.', code: 'part_limit' });
      expect((await parts(session.uploadId))[0]).toMatchObject({ number: 1, attempts: 20, active: 0 });
    } finally {
      expect((await post('/api/upload/abort', session)).status).toBe(200);
    }
  });

  it('re-reads the record after R2 answers a completion retry, so a takedown meanwhile stays final', async () => {
    const payload = new TextEncoder().encode('stuck completion'), session = await init(payload.length);
    const done = [await part(session, payload)], completionHash = await digest(JSON.stringify(done));
    // A completion whose response was lost long ago left the record 'completing', and R2 has no object.
    await edit(session.uploadId, record => { record.status = 'completing'; record.completionHash = completionHash; record.operationAt = Date.now() - 121000; });
    // Plain flags, each side polling on its own timers: a promise settled across the test and the object fails.
    const tick = () => new Promise(resolve => setTimeout(resolve, 10));
    let looking = false, answered = false;
    const restore = await swap(env.TRANSFERS.getByName(session.uploadId), ({ FILES }) => ({ FILES: bucket(FILES, {
      head: async (key: string) => { looking = true; while (!answered) await tick(); return FILES.head(key); },
    }) }));
    try {
      const retry = post('/api/upload/complete', { ...session, parts: done });
      while (!looking) await tick();
      // The operator takes the file down while R2 answers the retry's lookup.
      expect((await takedown(session.uploadId)).status).toBe(200);
      answered = true;
      const response = await retry;
      expect([response.status, (await response.json<{ error: string }>()).error]).toEqual([409, 'Transfer changed during completion.']);
    } finally { await restore(); }
    expect(await record(session.uploadId)).toMatchObject({ status: 'removed', clean: true, name: '', fingerprint: '' });
    expect(await reason(session.uploadId)).toBe('removed');
  });

  it('reopens an upload whose R2 completion failed, so the retry completes at once, and keeps what R2 completed anyway', async () => {
    for (const completedAnyway of [false, true]) {
      const payload = new TextEncoder().encode('flaky completion'), session = await init(payload.length);
      const done = [await part(session, payload)];
      let failures = 1;
      const restore = await swap(env.TRANSFERS.getByName(session.uploadId), ({ FILES }) => ({ FILES: bucket(FILES, {
        resumeMultipartUpload: (key: string, uploadId: string) => {
          const upload = FILES.resumeMultipartUpload(key, uploadId);
          return { abort: () => upload.abort(), complete: async (manifest: R2UploadedPart[]) => {
            if (failures-- <= 0) return upload.complete(manifest);
            if (completedAnyway) await upload.complete(manifest);
            throw new Error('We encountered an internal error. Please try again.');
          } } as unknown as R2MultipartUpload;
        },
      }) }));
      try {
        const first = await post('/api/upload/complete', { ...session, parts: done });
        if (completedAnyway) expect(first.status).toBe(200);
        else {
          expect(first.status).toBe(503);
          expect((await record(session.uploadId)).status).toBe('uploading');
          await finish(session, done);
        }
      } finally { await restore(); }
      expect((await record(session.uploadId)).status).toBe('ready');
      expect(new Uint8Array(await (await call(`/d/${session.uploadId}/x`)).arrayBuffer())).toEqual(payload);
    }
  });

  it('keeps a takedown for good, so a client that derives its id again cannot upload to the link', async () => {
    const clientKey = randomToken(), idempotency = 'audit' + crypto.randomUUID().replaceAll('-', '');
    const payload = new TextEncoder().encode('taken down for good');
    const metadata = { filename: 'abuse.bin', size: payload.length, clientKey };
    const create = () => post('/api/upload/init', metadata, { 'Idempotency-Key': idempotency });
    const session = await (await create()).json<Session>();
    const receipt = await finish(session, [await part(session, payload)]);
    expect(await (await takedown(receipt.id)).json()).toEqual({ removed: true, existed: true });
    // It gets no purge date, and one set on it is ignored.
    expect(await record(receipt.id)).not.toHaveProperty('purgeAt');
    await edit(receipt.id, record => { record.purgeAt = Date.now() - 1; });
    const stub = env.TRANSFERS.getByName(receipt.id);
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await reason(receipt.id)).toBe('removed');
    // The same clientKey and Idempotency-Key derive the same id again: the link takes no new upload.
    expect((await create()).status).toBe(409);
    // An id with no transfer (yet, or any more) is blocked in advance.
    const other = randomToken(), blocked = await digest(other + ':' + idempotency);
    expect(await (await takedown(blocked)).json()).toEqual({ removed: true, existed: false });
    expect((await post('/api/upload/init', { ...metadata, clientKey: other }, { 'Idempotency-Key': idempotency })).status).toBe(409);
    expect(await reason(blocked)).toBe('removed');
    expect(await runInDurableObject(env.TRANSFERS.getByName(blocked), (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
  });
});
