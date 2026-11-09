import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PART_BYTES, budget, randomToken, unwrap } from '../src/shared';
import { call, post, init, part, put, finish, file, pathOf, record, edit, useNetworkPrefix, type Session } from './helpers';

useNetworkPrefix('198.18.3.');

type Row = { number: number; size: number; etag: string | null; ticket: string; attempts: number; active: number; finished: number | null; slot: number | null; seq: number | null };
const transfer = (session: Session) => env.TRANSFERS.getByName(session.uploadId);
const rows = (session: Session) => runInDurableObject(transfer(session), (_instance, ctx) =>
  ctx.storage.sql.exec<Row>('SELECT * FROM parts ORDER BY number').toArray());
const tables = (session: Session) => runInDurableObject(transfer(session), (_instance, ctx) =>
  ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray().map(row => row.name));
const status = async (session: Session) => (await call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + session.key } }))
  .json<{ status: string; parts: { partNumber: number; size: number; etag: string }[] }>();
const charged = (session: Session) => runInDurableObject(budget(env), (_instance, ctx) =>
  ctx.storage.sql.exec<{ used: number }>('SELECT used FROM reservations WHERE id=?', session.uploadId).one().used);
// Closes or reopens this transfer's admission, so the Budget refuses only its parts (a pause would refuse every upload).
const admission = (session: Session, open: boolean) => runInDurableObject(budget(env), (_instance, ctx) => {
  ctx.storage.sql.exec('UPDATE reservations SET active=? WHERE id=?', open ? 1 : 0, session.uploadId);
});
// A part attempt admitted by the Durable Object whose bytes went to its R2 slot, but whose finishPart is still to come.
const inFlight = async (session: Session, payload: Uint8Array, number: number) => {
  const target = unwrap(await transfer(session).reservePart(session.key, number, payload.byteLength, 'f'.repeat(64), null));
  const { etag } = await env.FILES.resumeMultipartUpload(target.objectKey, target.uploadId).uploadPart(target.slot, payload);
  return { ...target, etag };
};

describe('parts in their own table', () => {
  it('keeps a finished part when two concurrent attempts are both refused, and never disturbs an admitted one', async () => {
    const payload = new TextEncoder().encode('raced part');
    const session = await init(payload.length);
    const done = await part(session, payload, 1);
    const [before] = await rows(session);
    expect(before).toMatchObject({ number: 1, size: payload.length, etag: done.etag, attempts: 1, active: 0 });
    await admission(session, false);
    try {
      const refused = await Promise.all([put(session, payload, 1), put(session, payload, 1)]);
      expect(refused.map(response => response.status)).toEqual([409, 409]);
    } finally {
      await admission(session, true);
    }
    // Refused attempts write nothing: same ticket, count and ETag, and the part still resumes.
    expect(await rows(session)).toEqual([before]);
    expect((await status(session)).parts).toEqual([{ partNumber: 1, size: payload.length, etag: done.etag }]);
    // An admitted attempt in flight, then a refused one: the admitted attempt still finishes.
    const admitted = await inFlight(session, payload, 1);
    await admission(session, false);
    try {
      expect((await put(session, payload, 1)).status).toBe(409);
    } finally {
      await admission(session, true);
    }
    expect(unwrap(await transfer(session).finishPart(session.key, 1, admitted.ticket, admitted.etag))).toEqual({ etag: admitted.etag });
    // It wrote its own slot, the part's second R2 part number, and is the second attempt admitted.
    expect(await rows(session)).toEqual([{ number: 1, size: payload.length, etag: admitted.etag, ticket: admitted.ticket, attempts: 2, active: 0, finished: expect.any(Number), slot: 2, seq: 2 }]);
    const receipt = await finish(session, [{ partNumber: 1, etag: admitted.etag }]);
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
  });

  it('charges the Budget the confirmed bytes of every part, concurrent parts included', async () => {
    const first = new Uint8Array(PART_BYTES).fill(3), last = new Uint8Array([4, 5]);
    const session = await init(PART_BYTES + last.length);
    const parts = await Promise.all([part(session, first, 1), part(session, last, 2)]);
    expect(await charged(session)).toBe(PART_BYTES + last.length);
    expect((await rows(session)).map(row => [row.number, row.size, row.active])).toEqual([[1, PART_BYTES, 0], [2, last.length, 0]]);
    expect((await status(session)).parts).toEqual(parts.map(({ partNumber, etag }, index) => ({ partNumber, etag, size: [PART_BYTES, last.length][index] })));
    await finish(session, parts);
  });

  it('ignores a parts field that records from before 2.1.2 kept in their payload, and never fails on it', async () => {
    const payload = new TextEncoder().encode('ignored legacy parts'), session = await init(payload.length);
    const done = await part(session, payload);
    // A payload as 2.1.1 wrote it, with its parts inside (here next to the table): nothing reads them any more.
    const legacy = { 1: { size: 3, attempts: 7, ticket: 'old-ticket', active: true, etag: 'old-etag' }, 9: { size: 1, attempts: 1, ticket: 't', active: false } };
    await edit(session.uploadId, record => { Object.assign(record, { parts: legacy }); });
    await evictDurableObject(transfer(session));
    expect((await status(session)).parts).toEqual([{ partNumber: 1, size: payload.length, etag: done.etag }]);
    expect(await rows(session)).toEqual([expect.objectContaining({ number: 1, etag: done.etag, attempts: 1 })]);
    // The next save leaves the field out.
    const receipt = await finish(session, [done]);
    expect(await record(session.uploadId)).not.toHaveProperty('parts');
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
    // Garbage in the field doesn't matter either.
    await edit(session.uploadId, record => { Object.assign(record, { parts: 'not an object' }); });
    await evictDurableObject(transfer(session));
    expect((await call(`/api/transfers/${session.uploadId}`)).status).toBe(200);
  });

  it('leaves no parts behind after cleanup, for new records and for closed ones that kept their parts in the record', async () => {
    // Aborted mid-upload: the table goes with the bytes, and the status still answers.
    const payload = new Uint8Array(PART_BYTES).fill(1);
    const aborted = await init(PART_BYTES + 1);
    await part(aborted, payload, 1);
    expect(await rows(aborted)).toHaveLength(1);
    expect((await post('/api/upload/abort', aborted)).status).toBe(200);
    expect(await tables(aborted)).toEqual(['transfer']);
    expect(await status(aborted)).toMatchObject({ status: 'aborted', parts: [] });
    // Deleted after completion.
    const { session, receipt } = await file();
    expect(await rows(session)).toHaveLength(1);
    expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
    expect(await tables(session)).toEqual(['transfer']);
    // A record 2.1.1 had already cleaned still answers as closed, with its parts field ignored and no parts table made.
    await runInDurableObject(transfer(session), (_instance, ctx) => {
      const stored = JSON.parse(ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id=1').one().payload);
      ctx.storage.sql.exec('UPDATE transfer SET payload=? WHERE id=1', JSON.stringify({ ...stored, parts: { 1: { size: 17, attempts: 1, ticket: 't', active: false } } }));
    });
    await evictDurableObject(transfer(session));
    const closed = await call(pathOf(receipt.url));
    expect([closed.status, (await closed.json<{ code: string }>()).code]).toEqual([410, 'deleted']);
    expect(await tables(session)).toEqual(['transfer']);
  });

  it('drops the empty table that purges before 2.1.2 left behind once the object is touched again', async () => {
    const id = randomToken(), stub = env.TRANSFERS.getByName(id);
    await runInDurableObject(stub, async (_instance, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE transfer (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
      ctx.storage.sql.exec('INSERT INTO transfer (id,payload) VALUES (1,?)', '{}');
      ctx.storage.sql.exec('DELETE FROM transfer WHERE id=1');
      // A pending alarm proves deleteAll() drops alarms too outside an alarm handler (one that runs consumes its own).
      await ctx.storage.setAlarm(Date.now() + 86400000);
      expect(ctx.storage.sql.databaseSize).toBeGreaterThan(4096);
    });
    // A later request starts a new instance of the object.
    await evictDurableObject(stub);
    expect((await call(`/api/transfers/${id}`)).status).toBe(404);
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).toEqual([]);
      expect(ctx.storage.sql.databaseSize).toBe(4096);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  });
});
