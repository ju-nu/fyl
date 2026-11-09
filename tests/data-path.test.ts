import { env } from 'cloudflare:workers';
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ATTEMPT_LEASE_MS, PART_BYTES, budget, networkHash, networkOf, unwrap } from '../src/shared';
import { address, call, post, init, part, put, finish, file, pathOf, record, edit, swap, direct, operator, useNetworkPrefix, type Session } from './helpers';
import vectors from './vectors/errors.json';

useNetworkPrefix('198.18.9.');

const NETWORK = 'e'.repeat(64);
const transfer = (session: Session) => env.TRANSFERS.getByName(session.uploadId);
/** An attempt admitted straight from the Durable Object, as the Worker gets it before it streams the bytes. */
const admit = async (session: Session, number: number, bytes: number) => unwrap(await transfer(session).reservePart(session.key, number, bytes, NETWORK, null));
const write = async (target: { objectKey: string; uploadId: string; slot: number }, payload: Uint8Array) =>
  (await env.FILES.resumeMultipartUpload(target.objectKey, target.uploadId).uploadPart(target.slot, payload)).etag;
const status = async (session: Session) => (await call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + session.key } }))
  .json<{ status: string; parts: { partNumber: number; size: number; etag: string }[] }>();
const sql = <T>(stub: DurableObjectStub, query: string, ...bindings: SqlStorageValue[]) =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec(query, ...bindings).toArray() as T[]);
/** What the Budget holds for an upload. */
const booked = async (session: Session) => ({
  reservation: (await sql<{ used: number; active: number }>(budget(env), 'SELECT used, active FROM reservations WHERE id = ?', session.uploadId))[0],
  pending: await sql(budget(env), 'SELECT part, slot, bytes FROM pending WHERE id = ? ORDER BY slot', session.uploadId),
  confirmed: (await sql(budget(env), 'SELECT part FROM confirmed WHERE id = ?', session.uploadId)).length,
});
const today = async () => (await budget(env).status()).today;
/** The copies of parts the Budget counts for an upload, and whether it still runs for its network. */
const held = async (session: Session) => (await sql<{ copies: number; running: number }>(budget(env), 'SELECT copies, running FROM reservations WHERE id = ?', session.uploadId))[0];
/** Other limits for the shared Budget while `work` runs (the vars are typed as their configured values). */
async function limited<T>(values: Record<string, string>, work: () => Promise<T>) {
  const restore = await swap(budget(env), () => values as unknown as Partial<Env>);
  try { return await work(); } finally { await restore(); }
}
const start = (from: string, name = 'counted.bin') => call('/api/upload/init', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: name, size: 3 }),
}, from);
const alarm = (stub: DurableObjectStub) => runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm());
const takedown = (id: string) => operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id, note: 'test takedown' }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
/** A METRICS stand-in that keeps the data points written to it. */
function dataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } };
}
const events = (points: AnalyticsEngineDataPoint[]) => points.map(point => [point.blobs?.[0], point.blobs?.[1]]);
// The Durable Object's own R2 binding with some methods replaced.
const bucket = (files: R2Bucket, overrides: Partial<R2Bucket>) => ({
  head: (key: string) => files.head(key), delete: (keys: string | string[]) => files.delete(keys),
  resumeMultipartUpload: (key: string, uploadId: string) => files.resumeMultipartUpload(key, uploadId),
  ...overrides,
}) as unknown as R2Bucket;

describe('part storage slots', () => {
  it('gives every attempt its own R2 part number, so a stale attempt finishing late changes nothing', async () => {
    const stale = new Uint8Array([1, 1, 1, 1]), retry = new Uint8Array([2, 2, 2, 2]);
    const session = await init(4), stub = transfer(session);
    // Attempt A is admitted, then the client gives up on it and retries with B.
    const a = await admit(session, 1, 4), b = await admit(session, 1, 4);
    expect([a.slot, b.slot]).toEqual([1, 2]);
    const etag = await write(b, retry);
    expect(unwrap(await stub.finishPart(session.key, 1, b.ticket, etag))).toEqual({ etag });
    // A's other bytes land afterwards, in A's own slot: B's part stays confirmed and complete. R2 holds both
    // copies until the completion, so the Budget counts both.
    const late = await write(a, stale);
    expect(await stub.finishPart(session.key, 1, a.ticket, late)).toMatchObject({ ok: false, status: 409 });
    expect((await status(session)).parts).toEqual([{ partNumber: 1, size: 4, etag }]);
    expect(await booked(session)).toEqual({ reservation: { used: 4, active: 1 }, pending: [], confirmed: 2 });
    expect(await held(session)).toEqual({ copies: 4, running: 1 });
    const receipt = await finish(session, [{ partNumber: 1, etag }]);
    expect(await held(session)).toEqual({ copies: 0, running: 0 });
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(retry);
  });

  it('confirms the newest attempt of a part that is sent again, and counts the part once, its second copy until completion', async () => {
    const payload = new TextEncoder().encode('sent again and again'), session = await init(payload.length), stub = transfer(session);
    const before = await today();
    const first = await admit(session, 1, payload.length), etag = await write(first, payload);
    expect(unwrap(await stub.finishPart(session.key, 1, first.ticket, etag))).toEqual({ etag });
    // Reported twice: the same answer, counted once.
    expect(unwrap(await stub.finishPart(session.key, 1, first.ticket, etag))).toEqual({ etag });
    // A client checking its parts sends it again, twice: the slots alternate, the newest confirmed one wins. R2
    // holds the part in two slots, so the second copy counts as well; the third attempt wrote over the first.
    const again = [await part(session, payload), await part(session, payload)];
    const [row] = await sql<{ slot: number; seq: number; attempts: number }>(stub, 'SELECT slot, seq, attempts FROM parts');
    expect(row).toEqual({ slot: 1, seq: 3, attempts: 3 });
    expect((await status(session)).parts).toEqual([{ partNumber: 1, size: payload.length, etag: again[1].etag }]);
    expect(await booked(session)).toEqual({ reservation: { used: payload.length, active: 1 }, pending: [], confirmed: 2 });
    expect(await held(session)).toEqual({ copies: payload.length, running: 1 });
    const after = await today();
    expect([after.payload - before.payload, after.reserved - before.reserved, after.attempted - before.attempted]).toEqual([2 * payload.length, 0, 3 * payload.length]);
    await finish(session, [{ partNumber: 1, etag: again[1].etag }]);
    expect(await held(session)).toEqual({ copies: 0, running: 0 });
  });

  it('answers 503 part_busy while every slot holds a running attempt, and frees one when R2 fails or the lease ends', async () => {
    const payload = new Uint8Array([3, 3, 3]), session = await init(3), stub = transfer(session), metrics = dataset();
    const held = [];
    for (let attempt = 0; attempt < 9; attempt++) held.push(await admit(session, 1, 3));
    expect(held.map(target => target.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const restore = await swap(stub, () => ({ METRICS: metrics.METRICS }));
    try {
      const busy = await put(session, payload, 1);
      expect([busy.status, busy.headers.get('Retry-After'), await busy.json()]).toEqual([503, '10',
        { error: 'This part is still being uploaded. Please retry shortly.', code: 'part_busy' }]);
      // The Worker reports that R2 refused attempt 5: its slot is free again, and it still counts as an attempt.
      expect(unwrap(await stub.failPart(session.key, 1, held[4].ticket))).toBe(true);
      expect(unwrap(await stub.failPart(session.key, 1, held[4].ticket))).toBe(false);
      // A write cut off because the sender went away (request.signal aborted) is counted apart, as no fault.
      expect(unwrap(await stub.failPart(session.key, 1, held[5].ticket, true))).toBe(true);
    } finally { await restore(); }
    expect(events(metrics.points)).toEqual([['part_busy', ''], ['part_failed', ''], ['part_failed', 'disconnected']]);
    expect([(await admit(session, 1, 3)).slot, (await admit(session, 1, 3)).slot]).toEqual([5, 6]);
    // An attempt that never settled holds its slot only for its lease; reporting afterwards it is refused.
    await sql(stub, 'UPDATE attempts SET at = ? WHERE ticket = ?', Date.now() - ATTEMPT_LEASE_MS - 1, held[0].ticket);
    expect((await admit(session, 1, 3)).slot).toBe(1);
    expect(await stub.finishPart(session.key, 1, held[0].ticket, 'late')).toMatchObject({ ok: false, status: 409 });
    expect((await sql<{ attempts: number }>(stub, 'SELECT attempts FROM parts'))[0].attempts).toBe(12);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('hands the slot of an attempt past its lease out last and refuses its late report, so its write cannot replace a newer part', async () => {
    const stale = new Uint8Array([8, 8, 8, 8]), fresh = new Uint8Array([9, 9, 9, 9]), session = await init(4), stub = transfer(session);
    const a = await admit(session, 1, 4);
    await sql(stub, 'UPDATE attempts SET at = ? WHERE ticket = ?', Date.now() - ATTEMPT_LEASE_MS - 1, a.ticket);
    // A is still streaming, as far as anyone knows: B gets a slot A never had.
    const b = await admit(session, 1, 4);
    expect([a.slot, b.slot]).toEqual([1, 2]);
    const etag = await write(b, fresh);
    expect(unwrap(await stub.finishPart(session.key, 1, b.ticket, etag))).toEqual({ etag });
    // A's bytes arrive at last. Its reservation is gone, so it counts nowhere and the client would send it again.
    const late = await write(a, stale);
    expect(await stub.finishPart(session.key, 1, a.ticket, late)).toEqual({ ok: false, status: 503, code: 'lease_expired', error: 'This part took too long. Please send it again.' });
    expect(await sql(stub, 'SELECT * FROM attempts')).toEqual([]);
    expect(await booked(session)).toEqual({ reservation: { used: 4, active: 1 }, pending: [], confirmed: 1 });
    expect((await status(session)).parts).toEqual([{ partNumber: 1, size: 4, etag }]);
    const receipt = await finish(session, [{ partNumber: 1, etag }]);
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(fresh);
  });

  it('counts every slot holding a copy of a part, so parallel attempts cannot store more than the budgets allow', async () => {
    const session = await init(4), stub = transfer(session), stored = (await budget(env).status()).stored;
    const sender = await networkHash(env.NETWORK_HASH_KEY, 'copies'), network = async () =>
      (await sql<{ bytes: number }>(budget(env), 'SELECT bytes FROM networks WHERE network = ?', sender))[0]?.bytes;
    const attempts = [];
    for (let attempt = 0; attempt < 9; attempt++) attempts.push(unwrap(await stub.reservePart(session.key, 1, 4, sender, null)));
    for (const [index, target] of attempts.entries()) {
      const etag = await write(target, new Uint8Array(4).fill(index));
      expect(unwrap(await stub.finishPart(session.key, 1, target.ticket, etag))).toEqual({ etag });
    }
    // R2 holds all nine until the completion: nine times the part, for the storage and for the sending network.
    expect((await budget(env).status()).stored).toMatchObject({ payload: stored.payload + 4, copies: stored.copies + 32, reserved: stored.reserved });
    expect([await network(), await held(session)]).toEqual([36, { copies: 32, running: 1 }]);
    // While they are held, another upload's part gets no room beyond the storage limit.
    const other = await init(4);
    await limited({ MAX_STORED_BYTES: String(stored.bytes + 36 + 3) }, async () => {
      const refused = await put(other, new Uint8Array(4));
      expect([refused.status, (await refused.json<{ code: string }>()).code]).toEqual([429, 'storage_capacity']);
    });
    const last = (await status(session)).parts[0];
    await finish(session, [{ partNumber: 1, etag: last.etag }]);
    expect((await budget(env).status()).stored).toMatchObject({ payload: stored.payload + 4, copies: stored.copies });
    expect(await network()).toBe(36);
    expect((await post('/api/upload/abort', other)).status).toBe(200);
  });

  it('keeps settling a part attempt after the response with waitUntil, so a client that disconnects frees its slot', async () => {
    const payload = new TextEncoder().encode('disconnected'), session = await init(payload.length), stub = transfer(session);
    // R2 sees the body end early, as when the client goes away mid-part.
    const cut = { resumeMultipartUpload: () => ({ uploadPart: async () => { throw new Error('Network connection lost.'); } }) } as unknown as R2Bucket;
    const kept: Promise<unknown>[] = [];
    const ctx = Object.assign(createExecutionContext(), { waitUntil: (work: Promise<unknown>) => { kept.push(work); } });
    const response = await worker.fetch(new Request('https://fyl.at/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: '1' }), {
      method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), Authorization: 'Bearer ' + session.key, 'CF-Connecting-IP': address(235) },
    }), { ...env, FILES: cut }, ctx);
    expect(response.status).toBe(503);
    // One piece of work from the admission to R2's result: the runtime keeps it running when the request is cancelled.
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
    expect(await sql(stub, 'SELECT * FROM attempts')).toEqual([]);
    expect(await booked(session)).toEqual({ reservation: { used: 0, active: 1 }, pending: [], confirmed: 0 });
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('releases the reserved bytes when R2 fails to store a part, and still counts the attempt', async () => {
    const payload = new TextEncoder().encode('R2 refused this part'), session = await init(payload.length), stub = transfer(session);
    const before = await today(), metrics = dataset(), restore = await swap(stub, () => ({ METRICS: metrics.METRICS }));
    const failing = { resumeMultipartUpload: () => ({ uploadPart: async () => { throw new Error('We encountered an internal error. Please try again.'); } }) } as unknown as R2Bucket;
    try {
      const { response } = await direct('/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: '1' }), { FILES: failing }, {
        method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), Authorization: 'Bearer ' + session.key },
      });
      expect([response.status, (await response.json<{ code: string }>()).code]).toEqual([503, 'temporarily_unavailable']);
    } finally { await restore(); }
    expect(events(metrics.points)).toEqual([['part_failed', '']]);
    expect(await booked(session)).toEqual({ reservation: { used: 0, active: 1 }, pending: [], confirmed: 0 });
    const after = await today();
    expect([after.payload - before.payload, after.reserved - before.reserved, after.attempted - before.attempted]).toEqual([0, 0, payload.length]);
    expect(await sql(stub, 'SELECT * FROM attempts')).toEqual([]);
    expect(await sql(stub, 'SELECT attempts, etag FROM parts')).toEqual([{ attempts: 1, etag: null }]);
    // The retry gets the freed slot and completes the upload.
    const done = await part(session, payload);
    expect((await sql<{ slot: number }>(stub, 'SELECT slot FROM parts'))[0].slot).toBe(1);
    await finish(session, [done]);
  });

  it('charges a part to the network that sends it, so a resumed upload counts where it is sent from', async () => {
    const payload = new TextEncoder().encode('resumed elsewhere'), session = await init(payload.length), from = address(222);
    const response = await call('/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: '1' }), {
      method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), Authorization: 'Bearer ' + session.key },
    }, from);
    expect(response.status).toBe(200);
    const network = await networkHash(env.NETWORK_HASH_KEY, from + ':' + Math.floor(Date.now() / 86400000));
    expect(await sql(budget(env), 'SELECT bytes, reserved FROM networks WHERE network = ?', network)).toEqual([{ bytes: payload.length, reserved: 0 }]);
  });

  it('releases the stored payload and running attempts of an aborted upload; the day keeps its confirmed bytes', async () => {
    const tail = new Uint8Array([7, 8, 9]), session = await init(PART_BYTES + tail.length);
    const before = await today(), stored = (await budget(env).status()).stored;
    await admit(session, 1, PART_BYTES); // still streaming when the sender aborts
    await part(session, tail, 2);
    expect(await booked(session)).toEqual({ reservation: { used: 3, active: 1 }, pending: [{ part: 1, slot: 1, bytes: PART_BYTES }], confirmed: 1 });
    expect((await post('/api/upload/abort', session)).status).toBe(200);
    expect(await booked(session)).toEqual({ reservation: { used: 3, active: 0 }, pending: [], confirmed: 0 });
    expect((await budget(env).status()).stored).toMatchObject({ payload: stored.payload, reserved: stored.reserved, uploads: stored.uploads - 1 });
    const after = await today();
    expect([after.payload - before.payload, after.reserved - before.reserved, after.attempted - before.attempted]).toEqual([3, 0, PART_BYTES + 3]);
  });
});

describe('per-network caps', () => {
  it('counts only uploads still running against a network: completed ones stay stored but free their place', async () => {
    const from = address(241);
    await limited({ MAX_ACTIVE_UPLOADS_PER_NETWORK: '2' }, async () => {
      // More completed uploads than the cap: each finished one no longer runs.
      for (let upload = 0; upload < 3; upload++) {
        const response = await start(from);
        expect(response.status).toBe(201);
        const session = await response.json<Session>();
        await finish(session, [await part(session, new Uint8Array([1, 2, 3]))]);
      }
      const running = [await (await start(from)).json<Session>(), await (await start(from)).json<Session>()];
      const refused = await start(from);
      expect([refused.status, await refused.json()]).toEqual([429, { error: 'Too many uploads from this network are running. Finish or cancel one first.', code: 'network_uploads' }]);
      // Finishing one frees its place, as the refusal says.
      await finish(running[0], [await part(running[0], new Uint8Array([4, 5, 6]))]);
      const next = await start(from);
      expect(next.status).toBe(201);
      for (const session of [running[1], await next.json<Session>()]) expect((await post('/api/upload/abort', session)).status).toBe(200);
    });
  });

  it('counts the /64s of one IPv6 /56 as one network, as one subscriber, for uploads and their bytes', async () => {
    const line = ['2001:db8:77:5501::1', '2001:db8:77:55a2::2', '2001:db8:77:55ff::3'], neighbour = '2001:db8:77:5601::1';
    await limited({ MAX_ACTIVE_UPLOADS_PER_NETWORK: '2' }, async () => {
      const sessions = [await start(line[0]), await start(line[1])];
      expect(sessions.map(response => response.status)).toEqual([201, 201]);
      const refused = await start(line[2]);
      expect([refused.status, (await refused.json<{ code: string }>()).code]).toEqual([429, 'network_uploads']);
      // The next /56 is someone else.
      const other = await start(neighbour);
      expect(other.status).toBe(201);
      const subscriber = await networkHash(env.NETWORK_HASH_KEY, networkOf(line[0], 56) + ':' + Math.floor(Date.now() / 86400000));
      expect(networkOf(line[2], 56)).toBe('2001:0db8:0077:5500::/56');
      expect(await sql(budget(env), 'SELECT uploads, active FROM networks WHERE network = ?', subscriber)).toEqual([{ uploads: 2, active: 2 }]);
      for (const response of [...sessions, other]) expect((await post('/api/upload/abort', await response.json<Session>())).status).toBe(200);
    });
  });
});

describe('error classes', () => {
  it('answers an exhausted part with a permanent 409 part_limit and a busy part with a retryable 503, as tests/vectors/errors.json says', async () => {
    const table = vectors as { status: number; code: string; class: string; note: string }[];
    const classOf = (status: number, code: string) => table.find(entry => entry.status === status && entry.code === code)?.class;
    // The table follows the contract's rule: part_limit and password_paused are permanent whatever the status, 408/429/5xx
    // retry, the rest are final.
    for (const entry of table)
      expect(entry.class, JSON.stringify(entry)).toBe(['part_limit', 'password_paused'].includes(entry.code) || ![408, 429, 500, 502, 503, 504].includes(entry.status) ? 'permanent' : 'retry');
    const payload = new Uint8Array([4, 4]), session = await init(2), stub = transfer(session);
    const held = [];
    for (let attempt = 0; attempt < 9; attempt++) held.push(await admit(session, 1, 2));
    const busy = await put(session, payload);
    expect(classOf(busy.status, (await busy.json<{ code: string }>()).code)).toBe('retry');
    for (const target of held) unwrap(await stub.failPart(session.key, 1, target.ticket));
    for (let attempt = 9; attempt < 20; attempt++) unwrap(await stub.failPart(session.key, 1, (await admit(session, 1, 2)).ticket));
    const limited = await put(session, payload);
    expect(classOf(limited.status, (await limited.json<{ code: string }>()).code)).toBe('permanent');
    expect(limited.status).toBe(409);
  });
});

describe('cleanup', () => {
  it('retries a failed cleanup after a one-time download within minutes, and keeps the storage reserved until it succeeds', async () => {
    const { session, receipt, payload } = await file(true), stub = transfer(session), metrics = dataset(), downloader = address(230);
    // The recipient's download: the Worker reports the whole file delivered with finishConsumed (called here itself).
    const first = await call(pathOf(receipt.url), { headers: { Range: 'bytes=0-3' } }, downloader);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload.slice(0, 4));
    let failures = 5;
    const restore = await swap(stub, ({ FILES }) => ({ METRICS: metrics.METRICS, FILES: bucket(FILES, {
      delete: async (keys: string | string[]) => { if (failures-- > 0) throw new Error('We encountered an internal error.'); return FILES.delete(keys); },
    }) }));
    try {
      const started = Date.now();
      unwrap(await stub.finishConsumed());
      // Closed for good at once; the bytes and their reservation stay, and the retry is a minute away, not at the expiry a day away.
      expect(await record(session.uploadId)).toMatchObject({ status: 'consumed', clean: false, cleanupTries: 1 });
      expect((await call(pathOf(receipt.url), {}, downloader)).status).toBe(410);
      expect(await alarm(stub)).toBeGreaterThanOrEqual(started + 60000);
      expect(await alarm(stub)).toBeLessThanOrEqual(Date.now() + 60000);
      expect((await booked(session)).reservation).toEqual({ used: payload.length, active: 1 });
      // Each further failure waits longer, up to an hour.
      for (const delay of [300000, 900000, 3600000, 3600000]) {
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(await alarm(stub)).toBeGreaterThan(Date.now() + delay - 10000);
        expect(await alarm(stub)).toBeLessThanOrEqual(Date.now() + delay);
        expect((await record(session.uploadId)).status).toBe('consumed');
      }
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally { await restore(); }
    const cleaned = await record(session.uploadId);
    expect(cleaned).toMatchObject({ status: 'consumed', clean: true });
    // The tombstone keeps neither the retry count nor the network hash of the one-time session.
    for (const field of ['cleanupTries', 'session']) expect(cleaned).not.toHaveProperty(field);
    expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    expect((await booked(session)).reservation).toEqual({ used: payload.length, active: 0 });
    expect(await alarm(stub)).toBe(cleaned.verifyAt);
    expect(events(metrics.points)).toEqual([...Array(5).fill(['cleanup_retry', 'r2_delete']), ['stored_gb_days', 'consumed'], ['cleanup_age', '']]);
    expect(metrics.points.at(-1)?.doubles?.[0]).toBeGreaterThanOrEqual(0);
    expect(metrics.points.at(-2)?.doubles?.[0]).toBeGreaterThanOrEqual(0);
    expect((await call(pathOf(receipt.url))).status).toBe(410);
  });

  it('retries when the Budget fails to release an aborted upload, and keeps it closed meanwhile', async () => {
    const payload = new TextEncoder().encode('release later'), session = await init(payload.length), stub = transfer(session), metrics = dataset();
    await part(session, payload);
    const restore = await swap(stub, ({ BUDGET }) => ({ METRICS: metrics.METRICS, BUDGET: { getByName: (name: string) => {
      const real = BUDGET.getByName(name);
      return { release: async () => ({ ok: false, status: 503, error: 'Temporarily unavailable. Please retry.', code: 'temporarily_unavailable' }),
        releasePart: (id: string, number: number, slot: number, ticket: string) => real.releasePart(id, number, slot, ticket) };
    } } as unknown as Env['BUDGET'] }));
    try {
      expect((await post('/api/upload/abort', session)).status).toBe(200);
      expect(await record(session.uploadId)).toMatchObject({ status: 'aborted', clean: false, cleanupTries: 1 });
      expect(await alarm(stub)).toBeLessThanOrEqual(Date.now() + 60000);
      expect((await put(session, payload)).status).toBe(410);
    } finally { await restore(); }
    expect(events(metrics.points)).toEqual([['cleanup_retry', 'budget_release']]);
    expect((await booked(session)).reservation.active).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await record(session.uploadId)).toMatchObject({ status: 'aborted', clean: true });
    expect((await booked(session)).reservation.active).toBe(0);
  });

  it('removes an object an R2 completion racing a takedown left behind at the check an hour later, and keeps the takedown', async () => {
    const payload = new TextEncoder().encode('completed after the takedown'), session = await init(payload.length), stub = transfer(session);
    const [done] = [await part(session, payload)], { uploadId } = await record(session.uploadId), metrics = dataset();
    // The takedown's abort reaches R2 while the completion still runs, so R2 keeps the upload.
    const restore = await swap(stub, ({ FILES }) => ({ METRICS: metrics.METRICS, FILES: bucket(FILES, {
      resumeMultipartUpload: (key: string, id: string) => ({ abort: async () => undefined, complete: (parts: R2UploadedPart[]) => FILES.resumeMultipartUpload(key, id).complete(parts) }) as unknown as R2MultipartUpload,
    }) }));
    try { expect((await takedown(session.uploadId)).status).toBe(200); }
    finally { await restore(); }
    const closed = await record(session.uploadId);
    expect(closed).toMatchObject({ status: 'removed', clean: true, verifyUpload: uploadId });
    expect(closed).not.toHaveProperty('purgeAt');
    // The completion lands after the cleanup: an object nobody can download.
    await env.FILES.resumeMultipartUpload(`files/${session.uploadId}`, uploadId).complete([{ partNumber: 1, etag: done.etag }]);
    expect(await env.FILES.head(`files/${session.uploadId}`)).not.toBeNull();
    expect(await alarm(stub)).toBe(closed.verifyAt);
    await edit(session.uploadId, record => { record.verifyAt = Date.now() - 1; });
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    const counting = await swap(stub, () => ({ METRICS: metrics.METRICS }));
    try { expect(await runDurableObjectAlarm(stub)).toBe(true); }
    finally { await counting(); }
    expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    expect(events(metrics.points)).toEqual([['stored_gb_days', 'removed'], ['cleanup_age', ''], ['cleanup_orphan', '']]);
    const kept = await record(session.uploadId);
    expect(kept).toMatchObject({ status: 'removed', clean: true });
    for (const field of ['verifyAt', 'verifyUpload', 'purgeAt']) expect(kept).not.toHaveProperty(field);
    expect(await alarm(stub)).toBeNull();
    expect((await call(pathOf(`https://fyl.at/d/${session.uploadId}`))).status).toBe(410);
  });

  it('deletes the object at once when a takedown closed the transfer while R2 completed it', async () => {
    const payload = new TextEncoder().encode('taken down mid-completion'), session = await init(payload.length), stub = transfer(session);
    const done = [await part(session, payload)];
    let completing = false, taken = false;
    const restore = await swap(stub, ({ FILES }) => ({ FILES: bucket(FILES, {
      resumeMultipartUpload: (key: string, id: string) => ({ abort: async () => undefined, complete: async (parts: R2UploadedPart[]) => {
        completing = true;
        while (!taken) await tick();
        return FILES.resumeMultipartUpload(key, id).complete(parts);
      } }) as unknown as R2MultipartUpload,
    }) }));
    try {
      const completion = post('/api/upload/complete', { ...session, parts: done });
      while (!completing) await tick();
      expect((await takedown(session.uploadId)).status).toBe(200);
      taken = true;
      const response = await completion;
      expect([response.status, (await response.json<{ error: string }>()).error]).toEqual([409, 'Transfer changed during completion.']);
    } finally { await restore(); }
    expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    expect(await record(session.uploadId)).toMatchObject({ status: 'removed', clean: true });
  });
});
