import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { budget } from '../src/shared';
import { call, operator, post, record, swap, useNetworkPrefix, type Session } from './helpers';
import { age, pin, plaintext, prepare, sealedInit, sealedPart, sealedPut } from './sealed';

// Races between concurrent requests, reproduced in the local runtime instead of reasoned about, kept
// as regression tests: none of them may ever yield an unauthorised outcome.
useNetworkPrefix('198.18.77.');

const curl = { 'User-Agent': 'curl/8.5.0', Accept: '*/*' };
const transfer = (id: string) => env.TRANSFERS.getByName(id);
/** Rows of a Transfer table, or the error text when the table is gone. */
const sql = <T>(id: string, query: string, ...bindings: SqlStorageValue[]) =>
  runInDurableObject(transfer(id), (_instance, ctx) => { try { return ctx.storage.sql.exec(query, ...bindings).toArray() as T[]; } catch (error) { return String(error); } });
const alarm = (id: string) => runInDurableObject(transfer(id), async instance => { await (instance as unknown as { alarm(): Promise<void> }).alarm(); });
/** The Budget's reservation of a transfer and its pending part attempts. */
const booked = (id: string) => runInDurableObject(budget(env), (_instance, ctx) => ({
  reservation: ctx.storage.sql.exec('SELECT id, active, running, used, copies FROM reservations WHERE id=?', id).toArray()[0] ?? null,
  pending: ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM pending WHERE id=?', id).one(),
}));

describe('/done from other networks while a one-time encrypted download runs', () => {
  it('changes nothing from another /64, the same /56 included; the recipient keeps resuming and only its /64 closes the link', async () => {
    const sealed = await prepare(plaintext(300000)), session = await sealedInit(sealed, { oneTime: true }), id = session.uploadId;
    const parts = [];
    for (let number = 1; number <= sealed.parts.length; number++) parts.push(await sealedPart(session, sealed, number));
    expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(200);
    // The recipient's /64 is 2001:db8:aaaa:1::/64; its /56 also holds :2::/64 and :3::/64.
    const recipient = '2001:db8:aaaa:1::10';
    const first = await call(`/d/${id}?dl=1`, { headers: { ...curl, Range: 'bytes=0-999' } }, recipient);
    expect(first.status).toBe(206);
    await first.arrayBuffer();
    // Always 204, so the answer says nothing; nothing closes.
    for (const from of ['2001:db8:aaaa:2::99', '2001:db8:aaaa:3::1', '203.0.113.9'])
      expect((await call(`/api/transfers/${id}/done`, { method: 'POST' }, from)).status).toBe(204);
    const after = await record(id);
    expect([after.status, after.session?.network !== undefined]).toEqual(['ready', true]);
    // Another address of the recipient's /64 is the same network: it resumes.
    const resume = await call(`/d/${id}?dl=1`, { headers: { ...curl, Range: 'bytes=1000-' } }, '2001:db8:aaaa:1::77');
    expect(resume.status).toBe(206);
    await resume.arrayBuffer();
    expect((await call(`/api/transfers/${id}/done`, { method: 'POST' }, recipient)).status).toBe(204);
    expect((await record(id)).status).toBe('consumed');
  });
});

describe('takedown immutability', () => {
  // Both orderings of the race: the takedown's R2 abort lands first and the completion fails at R2, or R2 completes first
  // and the abort finds no upload, leaving an object that the completion path must delete.
  for (const ordering of ['abort first', 'complete first'] as const) it(`keeps a takedown that lands while R2 completes the upload, through every later path (${ordering})`, async () => {
    const payload = new TextEncoder().encode('takedown-race-' + crypto.randomUUID());
    const session = await (await post('/api/upload/init', { filename: 'race.bin', size: payload.length, expiresIn: 86400 })).json<Session>(), id = session.uploadId;
    const put = await call('/api/upload/part?' + new URLSearchParams({ uploadId: id, partNumber: '1' }), {
      method: 'PUT', body: payload, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length), Authorization: 'Bearer ' + session.key } });
    const parts = [{ partNumber: 1, ...(await put.json<{ etag: string }>()) }];
    let release: () => void = () => {}, releaseAbort: () => void = () => {}, aborting = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
    // R2 holds the completion until the test releases it; with 'complete first' the abort waits for the completion.
    const restore = await swap(transfer(id), original => ({ FILES: new Proxy(original.FILES, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop !== 'resumeMultipartUpload') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        return (key: string, uploadId: string) => {
          const upload = target.resumeMultipartUpload(key, uploadId);
          return { key, uploadId, abort: async () => { aborting = true; if (ordering === 'complete first') await abortGate; return upload.abort(); },
            uploadPart: (number: number, body: ReadableStream) => upload.uploadPart(number, body),
            complete: async (manifest: R2UploadedPart[]) => { await gate; const object = await upload.complete(manifest); releaseAbort(); return object; } };
        };
      } }) as R2Bucket }));
    let completed: Response;
    try {
      const completing = post('/api/upload/complete', { ...session, parts });
      await expect.poll(async () => (await record(id)).status).toBe('completing');
      const takingDown = operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id, note: 'race the completion' }) });
      if (ordering === 'abort first') expect(await (await takingDown).json()).toMatchObject({ removed: true, existed: true });
      // The takedown reaches its abort, which waits for the completion.
      else await expect.poll(() => aborting).toBe(true);
      release();
      completed = await completing;
      if (ordering === 'complete first') expect(await (await takingDown).json()).toMatchObject({ removed: true, existed: true });
    } finally { await restore(); }
    expect([[409, 'request_failed'], [503, 'temporarily_unavailable']]).toContainEqual([completed.status, (await completed.json<{ code: string }>()).code]);
    expect([(await record(id)).status, (await record(id)).purgeAt]).toEqual(['removed', undefined]);
    // A cleanup retry or the late-object check runs: R2 holds nothing for it.
    for (let run = 0; run < 3; run++) await alarm(id);
    expect(await env.FILES.head(`files/${id}`)).toBeNull();
    expect((await record(id)).clean).toBe(true);
    // The sender's delete, abort, PATCH and a completion replay, the operator's restore and more alarms all keep it.
    expect((await call(`/api/transfers/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.key } })).status).toBe(200);
    expect((await post('/api/upload/abort', { ...session })).status).toBe(200);
    expect((await call(`/api/transfers/${id}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.key, 'Content-Type': 'application/json' }, body: '{"expiresIn":600}' })).status).toBe(410);
    expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(410);
    expect(await (await operator('/api/admin/restore', { method: 'POST', body: JSON.stringify({ id, note: 'restore after a takedown' }) })).json()).toMatchObject({ code: 'removed' });
    for (let run = 0; run < 2; run++) await alarm(id);
    const final = await record(id);
    expect([final.status, final.clean, final.purgeAt]).toEqual(['removed', true, undefined]);
    expect((await call(`/d/${id}?dl=1`, { headers: curl })).status).toBe(410);
    // The Budget released it: nothing active, running or copied, no pending attempt.
    const rows = await booked(id);
    expect(rows.reservation).toMatchObject({ active: 0, running: 0, copies: 0 });
    expect(rows.pending).toEqual({ n: 0 });
  });

  it('blocks the id an upload would derive with a takedown in advance, books nothing for it and never purges it', async () => {
    const clientKey = 'c'.repeat(43), idempotency = 'audit-idempotency-key-0001';
    // The id init derives from the client key and the Idempotency-Key.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientKey + ':' + idempotency)));
    const id = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(await (await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id, note: 'audit: block in advance' }) })).json())
      .toMatchObject({ removed: true, existed: false });
    const init = await post('/api/upload/init', { filename: 'blocked.bin', size: 3, clientKey }, { 'Idempotency-Key': idempotency });
    expect([init.status, (await init.json<{ code: string }>()).code]).toEqual([409, 'request_failed']);
    expect((await booked(id)).reservation).toBeNull();
    await alarm(id);
    expect(await record(id)).toMatchObject({ status: 'removed', clean: true, keyHash: '' });
  });
});

describe('pins and modes', () => {
  it('lets exactly one of two racing pins win; a body under the losing MD5 reaches neither R2 nor the Budget', async () => {
    const sealed = await prepare(plaintext(70000)), session = await sealedInit(sealed), id = session.uploadId;
    const real = age.md5Hex(sealed.parts[0]), fake = 'f'.repeat(32);
    const [a, b] = await Promise.all([pin(session, 1, fake), pin(session, 1, real)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? fake : real, loser = winner === fake ? real : fake;
    expect(await sql<{ md5: string }>(id, 'SELECT md5 FROM pins WHERE number=1')).toEqual([{ md5: winner }]);
    // Refused before an attempt row or a Budget reservation exists.
    const base64 = (hex: string) => btoa(String.fromCharCode(...(hex.match(/../g) as string[]).map(pair => Number.parseInt(pair, 16))));
    const refused = await sealedPut(session, sealed.parts[0], 1, base64(loser));
    expect([refused.status, (await refused.json<{ code: string }>()).code]).toEqual([409, 'part_changed']);
    expect(await sql(id, 'SELECT COUNT(*) AS n FROM attempts')).toEqual([{ n: 0 }]);
    expect((await booked(id)).pending).toEqual({ n: 0 });
  });

  it('keeps a transfer\'s mode as init set it: a raw one takes no pin, an encrypted one no unpinned part', async () => {
    const raw = await (await post('/api/upload/init', { filename: 'raw.bin', size: 5 })).json<Session>();
    expect((await pin(raw, 1, 'a'.repeat(32))).status).toBe(400);
    const sealed = await prepare(plaintext(1000)), sealedSession = await sealedInit(sealed);
    expect((await sealedPut(sealedSession, sealed.parts[0], 1, null)).status).toBe(400);
    // Init again with the same client key but no encryption, without an Idempotency-Key: another transfer, never this one.
    const other = await post('/api/upload/init', { filename: 'x.bin', size: sealed.body.size, clientKey: sealedSession.key });
    expect(other.status).toBe(201);
    expect((await other.json<Session>()).uploadId).not.toBe(sealedSession.uploadId);
  });
});
