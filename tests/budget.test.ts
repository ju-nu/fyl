import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Budget } from '../src/budget';
import { ATTEMPT_LEASE_MS, budget, networkHash, networkOf, unwrap } from '../src/shared';
import { call, edit, part, post, finish, swap, useNetworkPrefix, type Session } from './helpers';

useNetworkPrefix('198.18.16.');

const DAY = 86400000, dayOf = (time: number) => Math.floor(time / DAY) * DAY;
const fresh = () => env.BUDGET.getByName('budget-' + crypto.randomUUID());
/** Other limits for one Budget instance (the vars are typed as their configured values). */
const limits = (values: Record<string, string>) => () => values as unknown as Partial<Env>;
const rows = <T>(stub: DurableObjectStub<Budget>, query: string, ...bindings: SqlStorageValue[]) =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec(query, ...bindings).toArray() as T[]);
const used = async (stub: DurableObjectStub<Budget>, id: string) => (await rows<{ used: number }>(stub, 'SELECT used FROM reservations WHERE id = ?', id))[0].used;
/** A METRICS stand-in that keeps the data points written to it. */
function dataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } };
}

describe('upload budgets', () => {
  it('books each attempt once: replays, double confirmations and releases change nothing, and a released upload counts no more', async () => {
    const stub = fresh();
    unwrap(await stub.reserve('u', 100, 'net'));
    for (let replay = 0; replay < 2; replay++) unwrap(await stub.reservePart('u', 1, 1, 't1', 40, 'net'));
    expect(await rows(stub, 'SELECT part, slot, ticket, bytes FROM pending')).toEqual([{ part: 1, slot: 1, ticket: 't1', bytes: 40 }]);
    expect(unwrap(await stub.confirmPart('u', 1, 1, 't1'))).toBe(true);
    expect(unwrap(await stub.confirmPart('u', 1, 1, 't1'))).toBe(false);
    // The part sent again (a retry, a client checking it) reserves its bytes while it runs. R2 then holds it in a
    // second slot until the completion drops that copy: it counts as stored, for the day and for the network.
    unwrap(await stub.reservePart('u', 1, 2, 't2', 40, 'net'));
    expect((await stub.status()).stored).toMatchObject({ bytes: 80, payload: 40, copies: 0, reserved: 40, uploads: 1 });
    expect(unwrap(await stub.confirmPart('u', 1, 2, 't2'))).toBe(false);
    expect(unwrap(await stub.confirmPart('u', 1, 2, 't2'))).toBe(false);
    unwrap(await stub.releasePart('u', 1, 2, 't2'));
    expect(await used(stub, 'u')).toBe(40);
    expect((await stub.status()).stored).toMatchObject({ bytes: 80, payload: 40, copies: 40, reserved: 0 });
    expect((await stub.status()).today).toMatchObject({ bytes: 80, payload: 80, reserved: 0, attempted: 80, uploads: 1 });
    // Sent a third time into slot 1: R2 replaces the bytes there, so nothing more is held.
    unwrap(await stub.reservePart('u', 1, 1, 't5', 40, 'net'));
    expect(unwrap(await stub.confirmPart('u', 1, 1, 't5'))).toBe(false);
    expect((await stub.status()).stored).toMatchObject({ bytes: 80, payload: 40, copies: 40, reserved: 0 });
    // Released twice; whatever arrives afterwards counts nowhere, but the day keeps its bytes.
    unwrap(await stub.reservePart('u', 2, 10, 't3', 60, 'net'));
    for (let replay = 0; replay < 2; replay++) unwrap(await stub.release('u'));
    expect(await rows(stub, 'SELECT * FROM pending')).toEqual([]);
    expect(await rows(stub, 'SELECT * FROM confirmed')).toEqual([]);
    expect(unwrap(await stub.confirmPart('u', 2, 10, 't3'))).toBe(false);
    expect(await stub.reservePart('u', 3, 19, 't4', 1, 'net')).toMatchObject({ ok: false, status: 409 });
    expect((await stub.status()).stored).toMatchObject({ bytes: 0, payload: 0, copies: 0, reserved: 0, uploads: 0 });
    expect((await stub.status()).today).toMatchObject({ bytes: 80, payload: 80, attempted: 180 });
  });

  it('counts the copies R2 holds of a part against the stored and network budgets until the completion drops them', async () => {
    const stub = fresh();
    await swap(stub, limits({ MAX_STORED_BYTES: '100', MAX_DAILY_UPLOAD_BYTES_PER_NETWORK: '1000' }));
    unwrap(await stub.reserve('u', 30, 'net'));
    unwrap(await stub.reserve('v', 30, 'other'));
    // Three attempts of one part run at once and all arrive: R2 holds three copies.
    for (const slot of [1, 2, 3]) unwrap(await stub.reservePart('u', 1, slot, 't' + slot, 30, 'net'));
    for (const slot of [1, 2, 3]) unwrap(await stub.confirmPart('u', 1, slot, 't' + slot));
    expect((await stub.status()).stored).toMatchObject({ bytes: 90, payload: 30, copies: 60, reserved: 0 });
    expect(await rows(stub, "SELECT bytes FROM networks WHERE network = 'net'")).toEqual([{ bytes: 90 }]);
    // The copies fill the storage: another upload's part no longer fits.
    expect(await stub.reservePart('v', 1, 1, 'v1', 30, 'other')).toMatchObject({ ok: false, code: 'storage_capacity' });
    // The completion names one copy, R2 drops the others: their storage is free, the day and network keep their bytes.
    for (let replay = 0; replay < 2; replay++) expect(unwrap(await stub.uploaded('u'))).toBe(true);
    expect((await stub.status()).stored).toMatchObject({ bytes: 30, payload: 30, copies: 0 });
    unwrap(await stub.reservePart('v', 1, 1, 'v1', 30, 'other'));
    expect((await stub.status()).today).toMatchObject({ payload: 90, reserved: 30 });
    unwrap(await stub.release('u'));
    expect((await stub.status()).stored).toMatchObject({ bytes: 30, payload: 0, copies: 0, reserved: 30, uploads: 1 });
  });

  it("caps the bytes one network sends a day and charges them to the sender, while other networks still upload", async () => {
    const stub = fresh();
    await swap(stub, limits({ MAX_DAILY_UPLOAD_BYTES_PER_NETWORK: '100' }));
    for (const id of ['a1', 'a2', 'b1']) unwrap(await stub.reserve(id, 100, id[0] === 'a' ? 'net-a' : 'net-b'));
    // Parallel parts of two uploads from one network share its volume.
    unwrap(await stub.reservePart('a1', 1, 1, 't1', 60, 'net-a'));
    unwrap(await stub.reservePart('a2', 1, 1, 't2', 40, 'net-a'));
    expect(await stub.reservePart('a2', 2, 10, 't3', 1, 'net-a')).toEqual({ ok: false, status: 429, code: 'network_bytes',
      error: "This network's daily upload volume is used up. Please try tomorrow." });
    // Another network still uploads, also when it resumes an upload admitted from the first one: the sender pays.
    unwrap(await stub.reservePart('b1', 1, 1, 't4', 100, 'net-b'));
    unwrap(await stub.reservePart('a1', 2, 10, 't5', 30, 'net-c'));
    // A failed attempt gives its bytes back; a confirmed part keeps counting.
    unwrap(await stub.releasePart('a2', 1, 1, 't2'));
    unwrap(await stub.reservePart('a2', 1, 2, 't6', 40, 'net-a'));
    unwrap(await stub.confirmPart('a1', 1, 1, 't1'));
    unwrap(await stub.confirmPart('a2', 1, 2, 't6'));
    expect((await stub.reservePart('a1', 1, 3, 't7', 1, 'net-a')).ok).toBe(false);
    // A declared size that can no longer fit this network's day is refused at admission already.
    expect(await stub.reserve('a3', 1, 'net-a')).toMatchObject({ ok: false, code: 'network_bytes' });
    unwrap(await stub.confirmPart('a1', 2, 10, 't5'));
    expect(await rows(stub, 'SELECT network, bytes, reserved FROM networks ORDER BY network')).toEqual([
      { network: 'net-a', bytes: 100, reserved: 0 }, { network: 'net-b', bytes: 0, reserved: 100 }, { network: 'net-c', bytes: 30, reserved: 0 },
    ]);
  });

  it('limits the uploads one network runs at once, and frees a place when one completes or is released', async () => {
    const stub = fresh();
    await swap(stub, limits({ MAX_ACTIVE_UPLOADS_PER_NETWORK: '2' }));
    unwrap(await stub.reserve('u1', 10, 'net-a'));
    unwrap(await stub.reserve('u2', 10, 'net-a'));
    expect(await stub.reserve('u3', 10, 'net-a')).toEqual({ ok: false, status: 429, code: 'network_uploads',
      error: 'Too many uploads from this network are running. Finish or cancel one first.' });
    unwrap(await stub.reserve('u4', 10, 'net-b'));
    // Asking again for an admitted upload still answers.
    unwrap(await stub.reserve('u2', 10, 'net-a'));
    unwrap(await stub.release('u1'));
    unwrap(await stub.reserve('u3', 10, 'net-a'));
    // A completed upload stays stored but runs no more; completing again, or releasing it later, frees nothing twice.
    for (let replay = 0; replay < 2; replay++) unwrap(await stub.uploaded('u2'));
    unwrap(await stub.reserve('u5', 10, 'net-a'));
    expect(await stub.reserve('u6', 10, 'net-a')).toMatchObject({ ok: false, code: 'network_uploads' });
    unwrap(await stub.release('u2'));
    expect(await stub.reserve('u6', 10, 'net-a')).toMatchObject({ ok: false, code: 'network_uploads' });
    expect((await stub.status()).stored.uploads).toBe(3);
    // The alarm's reconciliation counts the same: no drift.
    const metrics = dataset();
    await swap(stub, () => ({ METRICS: metrics.METRICS }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(metrics.points).toEqual([]);
    expect(await rows(stub, "SELECT active FROM networks WHERE network = 'net-a'")).toEqual([{ active: 2 }]);
    expect((await stub.status()).network).toEqual({ maxBytes: Number(env.MAX_DAILY_UPLOAD_BYTES_PER_NETWORK), maxUploads: Number(env.MAX_DAILY_UPLOADS_PER_NETWORK), maxActive: 2,
      maxStored: Number(env.MAX_STORED_BYTES_PER_NETWORK) });
    // The configured limits in wrangler.jsonc: 50 running uploads, 250 GiB a day and 250 GiB stored per network.
    expect(Number(env.MAX_ACTIVE_UPLOADS_PER_NETWORK)).toBe(50);
    expect(Number(env.MAX_DAILY_UPLOAD_BYTES_PER_NETWORK)).toBe(250 * 1024 ** 3);
    expect(Number(env.MAX_STORED_BYTES_PER_NETWORK)).toBe(250 * 1024 ** 3);
  });

  it('caps the bytes the network that started an upload stores, for its whole life and wherever its parts come from', async () => {
    const stub = fresh(), live = () => rows(stub, 'SELECT network, bytes, uploads FROM live ORDER BY network');
    await swap(stub, limits({ MAX_STORED_BYTES_PER_NETWORK: '100' }));
    // Two uploads started by one network (on two days: its daily hash differs, its stable one doesn't), one by another.
    unwrap(await stub.reserve('a1', 60, 'day1-a', 'live-a'));
    unwrap(await stub.reserve('a2', 60, 'day2-a', 'live-a'));
    unwrap(await stub.reserve('b1', 100, 'day1-b', 'live-b'));
    // a1's part comes from a third network: the bytes it sends count for its own day, the stored ones for live-a.
    unwrap(await stub.reservePart('a1', 1, 1, 't1', 60, 'day1-x'));
    expect(await stub.reservePart('a2', 1, 1, 't2', 41, 'day2-a')).toEqual({ ok: false, status: 429, code: 'network_storage',
      error: 'This network already stores the maximum for now. Delete a file or wait until one expires.' });
    unwrap(await stub.reservePart('a2', 1, 1, 't3', 40, 'day2-a'));
    unwrap(await stub.reservePart('b1', 1, 1, 't4', 100, 'day1-b'));
    expect(await live()).toEqual([{ network: 'live-a', bytes: 100, uploads: 2 }, { network: 'live-b', bytes: 100, uploads: 1 }]);
    // Admission checks that the declared size could still fit, as the other limits do.
    expect(await stub.reserve('a3', 1, 'day2-a', 'live-a')).toMatchObject({ ok: false, code: 'network_storage' });
    // Reserved bytes become stored payload; a failed attempt gives its bytes back.
    unwrap(await stub.confirmPart('a1', 1, 1, 't1'));
    unwrap(await stub.releasePart('a2', 1, 1, 't3'));
    expect(await live()).toEqual([{ network: 'live-a', bytes: 60, uploads: 2 }, { network: 'live-b', bytes: 100, uploads: 1 }]);
    expect(await stub.reserve('a3', 41, 'day2-a', 'live-a')).toMatchObject({ ok: false, code: 'network_storage' });
    unwrap(await stub.reserve('a3', 40, 'day2-a', 'live-a'));
    // A copy R2 holds counts until the completion drops it.
    unwrap(await stub.reservePart('a1', 1, 2, 't5', 40, 'day1-x'));
    expect((await stub.reservePart('a3', 1, 1, 't6', 1, 'day2-a')).ok).toBe(false);
    unwrap(await stub.confirmPart('a1', 1, 2, 't5'));
    expect(await live()).toEqual([{ network: 'live-a', bytes: 100, uploads: 3 }, { network: 'live-b', bytes: 100, uploads: 1 }]);
    unwrap(await stub.uploaded('a1'));
    expect(await live()).toEqual([{ network: 'live-a', bytes: 60, uploads: 3 }, { network: 'live-b', bytes: 100, uploads: 1 }]);
    // An upload admitted without a stable hash counts for no network.
    unwrap(await stub.reserve('legacy', 500, 'day1-a'));
    unwrap(await stub.reservePart('legacy', 1, 1, 't7', 500, 'day1-a'));
    // Released after its cleanup, an upload's hash goes; the network's row goes with its last upload.
    for (const id of ['a1', 'a1', 'a2']) unwrap(await stub.release(id));
    expect(await live()).toEqual([{ network: 'live-a', bytes: 0, uploads: 1 }, { network: 'live-b', bytes: 100, uploads: 1 }]);
    unwrap(await stub.reservePart('a3', 1, 1, 't8', 40, 'day2-a'));
    for (const id of ['a3', 'b1']) unwrap(await stub.release(id));
    expect(await live()).toEqual([]);
    expect(await rows(stub, 'SELECT id FROM reservations WHERE live_hash IS NOT NULL')).toEqual([]);
    expect((await stub.status()).network.maxStored).toBe(100);
  });

  it('reconciles the stored bytes per network from the rows, and drops a hash no upload holds any more', async () => {
    const stub = fresh(), metrics = dataset();
    await swap(stub, () => ({ METRICS: metrics.METRICS }));
    unwrap(await stub.reserve('r1', 100, 'day-a', 'live-a'));
    unwrap(await stub.reserve('r2', 100, 'day-a', 'live-a'));
    unwrap(await stub.reservePart('r1', 1, 1, 't1', 50, 'day-x'));
    unwrap(await stub.confirmPart('r1', 1, 1, 't1'));
    unwrap(await stub.reservePart('r2', 1, 1, 't2', 30, 'day-a'));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(metrics.points).toEqual([]);
    const live = () => rows(stub, 'SELECT network, bytes, uploads FROM live ORDER BY network');
    expect(await live()).toEqual([{ network: 'live-a', bytes: 80, uploads: 2 }]);
    await rows(stub, "UPDATE live SET bytes = bytes + 5, uploads = 7 WHERE network = 'live-a'");
    await rows(stub, "INSERT INTO live (network, bytes, uploads) VALUES ('live-gone', 9, 1)");
    expect(unwrap(await stub.reconcileNow()).drift).toEqual({ network_stored: 14, network_stored_uploads: 6 });
    expect(await live()).toEqual([{ network: 'live-a', bytes: 80, uploads: 2 }]);
    // A missing row is put back.
    await rows(stub, 'DELETE FROM live');
    expect(unwrap(await stub.reconcileNow()).drift).toEqual({ network_stored: 80, network_stored_uploads: 2 });
    expect(await live()).toEqual([{ network: 'live-a', bytes: 80, uploads: 2 }]);
  });

  it('attributes stored bytes to the network that started the upload, by a keyed hash that does not rotate', async () => {
    const admission = budget(env), restore = await swap(admission, limits({ MAX_STORED_BYTES_PER_NETWORK: '30' }));
    const start = (size: number, from: string) => call('/api/upload/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'stored.bin', size }) }, from);
    const reservation = (id: string) => rows<{ ip_hash: string; live_hash: string | null }>(admission, 'SELECT ip_hash, live_hash FROM reservations WHERE id = ?', id);
    try {
      // Two addresses of one IPv6 line (/56) count as one network.
      const from = '2001:db8:aa:1101::1', sibling = '2001:db8:aa:11ff::9', stable = await networkHash(env.NETWORK_HASH_KEY, 'fyl-live:' + networkOf(from, 56));
      const first = await start(20, from);
      expect(first.status).toBe(201);
      const session = await first.json<Session>();
      const [row] = await reservation(session.uploadId);
      expect(row.live_hash).toBe(stable);
      expect(row.ip_hash).not.toBe(stable);
      // Its part comes from another network (post() and part() use the test's own addresses): it counts for the starter.
      const payload = new Uint8Array(20).fill(7);
      const receipt = await finish(session, [await part(session, payload)]);
      expect(await rows(admission, 'SELECT bytes, uploads FROM live WHERE network = ?', stable)).toEqual([{ bytes: 20, uploads: 1 }]);
      const refused = await start(11, sibling);
      expect([refused.status, (await refused.json<{ code: string }>()).code]).toEqual([429, 'network_storage']);
      expect((await post('/api/upload/abort', await (await start(10, sibling)).json())).status).toBe(200);
      // Another network is not affected.
      expect((await post('/api/upload/abort', await (await start(30, '198.51.100.78')).json())).status).toBe(200);
      // Deleting the file releases its bytes, and its hash with them.
      expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
      expect(await rows(admission, 'SELECT bytes FROM live WHERE network = ?', stable)).toEqual([]);
      expect((await reservation(session.uploadId))[0].live_hash).toBeNull();
      const again = await start(30, from);
      expect(again.status).toBe(201);
      expect((await post('/api/upload/abort', await again.json())).status).toBe(200);
    } finally { await restore(); }
  });

  it("charges an attempt admitted before UTC midnight to that day, and counts the new day's network hash afresh", async () => {
    const stub = fresh(), midnight = dayOf(Date.now()) + DAY;
    await swap(stub, limits({ MAX_ACTIVE_UPLOADS_PER_NETWORK: '1' }));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight - 60000);
      unwrap(await stub.reserve('late', 1000, 'net-yesterday'));
      unwrap(await stub.reservePart('late', 1, 1, 't1', 600, 'net-yesterday'));
      vi.setSystemTime(midnight + 60000);
      unwrap(await stub.confirmPart('late', 1, 1, 't1'));
      expect(await rows(stub, 'SELECT day, bytes, reserved, attempted, uploads FROM daily')).toEqual([{ day: midnight - DAY, bytes: 600, reserved: 0, attempted: 600, uploads: 1 }]);
      expect((await stub.status()).today).toMatchObject({ bytes: 0, payload: 0, uploads: 0 });
      // The same network hashes differently today: yesterday's upload doesn't hold its only place.
      unwrap(await stub.reserve('next', 10, 'net-today'));
      // A part sent after midnight counts for the new day, and for the network that sends it.
      unwrap(await stub.reservePart('late', 2, 10, 't2', 400, 'net-today'));
      expect((await stub.status()).today).toMatchObject({ bytes: 400, payload: 0, reserved: 400, attempted: 400, uploads: 1 });
      expect(await rows(stub, 'SELECT network, day, uploads, active, bytes, reserved FROM networks ORDER BY day')).toEqual([
        { network: 'net-yesterday', day: midnight - DAY, uploads: 1, active: 1, bytes: 600, reserved: 0 },
        { network: 'net-today', day: midnight, uploads: 1, active: 1, bytes: 0, reserved: 400 },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('stops counting an attempt that never settled once its lease ends, and refuses its late confirmation', async () => {
    const stub = fresh();
    await swap(stub, limits({ MAX_DAILY_UPLOAD_BYTES_PER_NETWORK: '150' }));
    unwrap(await stub.reserve('u', 150, 'net'));
    unwrap(await stub.reservePart('u', 1, 1, 't1', 100, 'net'));
    expect((await stub.reservePart('u', 2, 10, 't2', 51, 'net')).ok).toBe(false);
    await rows(stub, 'UPDATE pending SET at = at - ? - 1', ATTEMPT_LEASE_MS);
    unwrap(await stub.reservePart('u', 2, 10, 't3', 50, 'net'));
    expect((await stub.status()).stored).toMatchObject({ reserved: 50, payload: 0 });
    // Its bytes were reserved no longer, so they would pass the caps unchecked: the client sends the part again.
    expect(await stub.confirmPart('u', 1, 1, 't1')).toEqual({ ok: false, status: 503, code: 'lease_expired', error: 'This part took too long. Please send it again.' });
    expect((await stub.status()).today).toMatchObject({ payload: 0, reserved: 50, attempted: 150 });
    expect(await rows(stub, 'SELECT bytes, reserved FROM networks')).toEqual([{ bytes: 0, reserved: 50 }]);
    expect(await used(stub, 'u')).toBe(0);
  });

  it('releases an attempt whose slot is handed out again after its lease once, also when nothing swept it before', async () => {
    const stub = fresh(), day = dayOf(Date.now());
    unwrap(await stub.reserve('u', 100, 'net'));
    unwrap(await stub.reservePart('u', 1, 1, 't1', 40, 'net'));
    await rows(stub, 'UPDATE pending SET at = at - ? - 1', ATTEMPT_LEASE_MS);
    // The Transfer gives slot 1 to a new attempt: the Budget's first call since then sweeps the old row and replaces it.
    unwrap(await stub.reservePart('u', 1, 1, 't2', 40, 'net'));
    const reserved = async () => ({
      pending: await rows(stub, 'SELECT ticket, bytes FROM pending'),
      total: await rows(stub, "SELECT value FROM totals WHERE name = 'reserved'"),
      daily: await rows(stub, 'SELECT reserved FROM daily WHERE day = ?', day),
      network: await rows(stub, "SELECT reserved FROM networks WHERE network = 'net'"),
    });
    expect(await reserved()).toEqual({ pending: [{ ticket: 't2', bytes: 40 }], total: [{ value: 40 }], daily: [{ reserved: 40 }], network: [{ reserved: 40 }] });
    unwrap(await stub.releasePart('u', 1, 1, 't2'));
    unwrap(await stub.releasePart('u', 1, 1, 't1'));
    expect(await reserved()).toEqual({ pending: [], total: [{ value: 0 }], daily: [{ reserved: 0 }], network: [{ reserved: 0 }] });
  });

  it('reconciles its aggregates from the rows in the alarm, counting any drift by aggregate', async () => {
    const stub = fresh(), metrics = dataset();
    await swap(stub, () => ({ METRICS: metrics.METRICS }));
    unwrap(await stub.reserve('r1', 100, 'net-a'));
    unwrap(await stub.reserve('r2', 100, 'net-b'));
    unwrap(await stub.reservePart('r1', 1, 1, 't1', 50, 'net-a'));
    unwrap(await stub.confirmPart('r1', 1, 1, 't1'));
    unwrap(await stub.reservePart('r2', 1, 1, 't2', 30, 'net-b'));
    const snapshot = async () => ({ totals: await rows(stub, 'SELECT name, value FROM totals ORDER BY name'), daily: await rows(stub, 'SELECT * FROM daily'),
      networks: await rows(stub, 'SELECT * FROM networks ORDER BY network') });
    const before = await snapshot();
    expect(before.totals).toEqual([{ name: 'active', value: 2 }, { name: 'reserved', value: 30 }, { name: 'used', value: 50 }]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(metrics.points).toEqual([]);
    expect(await snapshot()).toEqual(before);
    await rows(stub, "UPDATE totals SET value = value + 7 WHERE name = 'used'");
    await rows(stub, 'UPDATE daily SET uploads = 9, reserved = 1');
    await rows(stub, "UPDATE networks SET active = 5 WHERE network = 'net-a'");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await snapshot()).toEqual(before);
    const drift = (code: string, value: number) => ({ indexes: ['budget_drift'], blobs: ['budget_drift', code], doubles: [value] });
    expect(metrics.points).toEqual([drift('used', 7), drift('daily_uploads', 7), drift('daily_reserved', 29), drift('network_active', 4)]);
  });

  it('sweeps and reconciles when the operator asks, as the alarm does, and answers the drift it fixed', async () => {
    const stub = fresh(), metrics = dataset();
    await swap(stub, () => ({ METRICS: metrics.METRICS }));
    unwrap(await stub.reserve('o1', 100, 'net-a'));
    unwrap(await stub.reservePart('o1', 1, 1, 't1', 40, 'net-a'));
    // A lease that ended without a sweep, and an aggregate that is off.
    await rows(stub, 'UPDATE pending SET at = ?', Date.now() - ATTEMPT_LEASE_MS - 1);
    await rows(stub, "UPDATE totals SET value = value + 3 WHERE name = 'active'");
    expect(unwrap(await stub.reconcileNow()).drift).toEqual({ active: 3 });
    expect((await stub.status()).stored).toMatchObject({ reserved: 0, uploads: 1 });
    expect(await rows(stub, 'SELECT * FROM pending')).toEqual([]);
    expect(unwrap(await stub.reconcileNow()).drift).toEqual({});
    expect(metrics.points).toEqual([{ indexes: ['budget_drift'], blobs: ['budget_drift', 'active'], doubles: [3] }]);
  });

  it('reads a bounded number of rows to admit an upload or a part, however many rows it keeps', async () => {
    const stub = fresh(), now = Date.now();
    await runInDurableObject(stub, (_instance, ctx) => {
      for (let i = 0; i < 3000; i++) {
        ctx.storage.sql.exec('INSERT INTO reservations (id, bytes, created_at, ip_hash, used, live_hash) VALUES (?, ?, ?, ?, ?, ?)', 'seed' + i, 1000, now - i, 'net-' + (i % 300), 10, 'live-' + (i % 300));
        if (i < 300) ctx.storage.sql.exec('INSERT INTO live (network, bytes, uploads) VALUES (?, 100, 10)', 'live-' + i);
        if (i < 2000) ctx.storage.sql.exec('INSERT INTO pending (id, part, slot, ticket, bytes, day, network, at) VALUES (?, 1, 1, ?, 10, ?, ?, ?)', 'seed' + i, 't' + i, dayOf(now), 'net-' + (i % 300), now);
        if (i < 1000) ctx.storage.sql.exec('INSERT INTO confirmed (id, part, slot) VALUES (?, 2, 2)', 'seed' + i);
      }
    });
    const reads = (work: (budget: Budget) => Promise<unknown>) => runInDurableObject(stub, async instance => {
      const before = instance.rowsRead;
      await work(instance);
      return instance.rowsRead - before;
    });
    const counts = {
      reserve: await reads(budget => budget.reserve('new', 1000, 'net-7', 'live-7')),
      reservePart: await reads(budget => budget.reservePart('new', 1, 1, 'x', 1000, 'net-7')),
      confirmPart: await reads(budget => budget.confirmPart('new', 1, 1, 'x')),
      retry: await reads(budget => budget.reservePart('new', 1, 2, 'y', 1000, 'net-7')),
      copy: await reads(budget => budget.confirmPart('new', 1, 2, 'y')),
      uploaded: await reads(budget => budget.uploaded('new')),
      release: await reads(budget => budget.release('new')),
    };
    // Counting today's reservations and a network's among them would read thousands of rows here.
    for (const [path, count] of Object.entries(counts)) expect(count, path).toBeLessThanOrEqual(25);
  });
});

describe('the cleanup reconciler', () => {
  const OVERDUE = 8 * DAY + 3600000;
  const backdate = (stub: DurableObjectStub<Budget>, id: string) =>
    rows(stub, 'UPDATE reservations SET created_at = ? WHERE id = ?', Date.now() - OVERDUE - 60000, id);

  it('releases a reservation whose transfer is gone, and leaves young ones alone', async () => {
    const stub = fresh(), gone = 'gone-' + crypto.randomUUID(), young = 'young-' + crypto.randomUUID();
    unwrap(await stub.reserve(gone, 100, 'net'));
    unwrap(await stub.reserve(young, 100, 'net'));
    await backdate(stub, gone);
    expect((await stub.status()).overdueCleanups).toBe(1);
    expect(unwrap(await stub.reconcileNow()).cleanups).toEqual({ rearmed: 0, released: 1, failed: 0 });
    expect((await stub.status()).overdueCleanups).toBe(0);
    expect(await rows(stub, 'SELECT id, active FROM reservations ORDER BY id')).toEqual([{ id: gone, active: 0 }, { id: young, active: 1 }]);
  });

  it('releases a clean transfer\'s reservation, and only reruns the alarm of a live one, which keeps its storage', async () => {
    const stub = budget(env);
    const init = async () => (await (await post('/api/upload/init', { filename: 'live.bin', size: 10 })).json()) as Session;
    const clean = await init(), live = await init();
    // A cleanup that marked the record clean but whose release never reached the Budget.
    await edit(clean.uploadId, stored => { stored.clean = true; stored.status = 'expired'; });
    for (const session of [clean, live]) await backdate(stub, session.uploadId);
    const result = unwrap(await stub.reconcileNow()).cleanups;
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(await rows(stub, 'SELECT id, active FROM reservations WHERE id IN (?, ?) ORDER BY id = ?', clean.uploadId, live.uploadId, live.uploadId))
      .toEqual([{ id: clean.uploadId, active: 0 }, { id: live.uploadId, active: 1 }]);
    // The live upload is still within its window: nothing closed, and the next run tries it again later.
    const stillLive = await runInDurableObject(env.TRANSFERS.getByName(live.uploadId), (_instance, ctx) =>
      JSON.parse(String(ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id = 1').one().payload)) as { clean: boolean; status: string });
    expect(stillLive).toMatchObject({ clean: false, status: 'uploading' });
    expect(await rows(stub, 'SELECT id FROM reconciled WHERE id = ?', live.uploadId)).toEqual([{ id: live.uploadId }]);
    await rows(stub, 'UPDATE reservations SET active = 0 WHERE id = ?', live.uploadId);
  });

  it("runs a stuck transfer's alarm, which closes and cleans it and releases its storage; the daily alarm does the same", async () => {
    const stub = budget(env);
    for (const daily of [false, true]) {
      const { session } = await (async () => {
        const response = await post('/api/upload/init', { filename: 'stuck.bin', size: 10 });
        return { session: await response.json() as Session };
      })();
      // The transfer's own alarm was lost: its upload window is over, and its reservation is past every lifetime.
      await edit(session.uploadId, stored => { stored.uploadDeadline = Date.now() - 1; });
      await runInDurableObject(env.TRANSFERS.getByName(session.uploadId), (_instance, ctx) => ctx.storage.deleteAlarm());
      await backdate(stub, session.uploadId);
      if (daily) await runInDurableObject(stub, async instance => { await (instance as unknown as { alarm(): Promise<void> }).alarm(); });
      else expect(unwrap(await stub.reconcileNow()).cleanups).toMatchObject({ rearmed: 1, failed: 0 });
      expect(await rows(stub, 'SELECT active FROM reservations WHERE id = ?', session.uploadId)).toEqual([{ active: 0 }]);
      const record = await runInDurableObject(env.TRANSFERS.getByName(session.uploadId), (_instance, ctx) =>
        JSON.parse(String(ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id = 1').one().payload)) as { clean: boolean; status: string });
      expect([daily, record.status, record.clean]).toEqual([daily, 'aborted', true]);
    }
  });
});
