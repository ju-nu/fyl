import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PART_BYTES, budget, randomToken, unwrap } from '../src/shared';
import { call, post, init, part, put, finish, file, pathOf, useNetworkPrefix, type Session } from './helpers';

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

  it('leaves no parts behind after cleanup, for aborted and deleted transfers', async () => {
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
  });

  it('answers 404 for an object with an empty transfer table, and creates the upload tables when a record is saved there', async () => {
    const id = randomToken(), stub = env.TRANSFERS.getByName(id);
    await runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE transfer (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
    });
    await evictDurableObject(stub);
    expect((await call(`/api/transfers/${id}`)).status).toBe(404);
    await runInDurableObject(stub, (instance, ctx) => {
      (instance as unknown as { save(record: { clean: boolean }): void }).save({ clean: false });
      const names = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name);
      expect(names.sort()).toEqual(['attempts', 'parts', 'transfer']);
    });
  });
});
