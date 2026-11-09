import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { budget, digest, metric } from '../src/shared';
import { direct, edit, file, finish, init, operator, operatorDirect, part, pause, pathOf, post, put, record, swap, OPERATOR_TOKEN, useNetworkPrefix } from './helpers';
import { version } from '../package.json';

useNetworkPrefix('198.18.5.');

/** A METRICS stand-in that keeps the data points written to it. */
function dataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } };
}
const point = (event: string, code = '', value: unknown = 1, dimensions: string[] = []) => ({ indexes: [event], blobs: [event, code, ...dimensions], doubles: [value] });
const fallbacks = (points: AnalyticsEngineDataPoint[]) => points.filter(entry => entry.blobs?.[0] === 'fallback');
const failed = async () => { throw new Error('Durable Object reset because its code was updated.'); };

describe('operational metrics', () => {
  it('writes the event, its code and value, and never throws', () => {
    expect(env.METRICS).toBeDefined();
    const metrics = dataset();
    metric(metrics, 'budget_refused', 'daily_budget');
    metric(metrics, 'upload_completed', '', 1536);
    expect(metrics.points).toEqual([point('budget_refused', 'daily_budget'), point('upload_completed', '', 1536)]);
    expect(() => metric({ METRICS: { writeDataPoint() { throw new Error('dataset unavailable'); } } }, 'takedown')).not.toThrow();
    expect(() => metric({} as Pick<Env, 'METRICS'>, 'takedown')).not.toThrow();
  });

  it('counts operator pauses with their state and takedowns, but not refused operator calls', async () => {
    const metrics = dataset(), { receipt } = await file();
    const admin = async (path: string, data: unknown) => (await operatorDirect(path, metrics, {
      method: 'POST', headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })).response;
    try { expect((await admin('/api/admin/uploads', { paused: true })).status).toBe(200); }
    finally { expect((await admin('/api/admin/uploads', { paused: false })).status).toBe(200); }
    expect((await admin('/api/admin/takedown', { id: receipt.id, note: 'malware' })).status).toBe(200);
    expect((await admin('/api/admin/takedown', { id: 'not-an-id', note: 'malware' })).status).toBe(400);
    expect((await admin('/api/admin/takedown', { id: receipt.id })).status).toBe(400);
    expect(metrics.points).toEqual([point('pause', '', 1), point('pause', '', 0), point('takedown')]);
  });

  it('counts an interrupted one-time download, which stays open for a resume', async () => {
    const { receipt, payload } = await file(true), interrupted = dataset(), resumed = dataset();
    // The client goes away before the first byte.
    const first = await direct(pathOf(receipt.url), interrupted);
    expect(first.response.status).toBe(200);
    await first.response.body?.cancel();
    await first.settled();
    expect(interrupted.points).toEqual([point('download_started', 'other', 1), point('one_time_interrupted')]);
    // The same network resumes; a delivered download is not an event of its own.
    const retry = await direct(pathOf(receipt.url), resumed);
    expect(new Uint8Array(await retry.response.arrayBuffer())).toEqual(payload);
    await retry.settled();
    expect(resumed.points).toEqual([point('download_started', 'other', 1)]);
  });

  it('counts a paused part attempt in the Budget and the Transfer, then the completed upload', async () => {
    const payload = new TextEncoder().encode('metrics fixture'), session = await init(payload.length), metrics = dataset();
    const restore = [
      await swap(budget(env), () => ({ METRICS: metrics.METRICS })),
      await swap(env.TRANSFERS.getByName(session.uploadId), () => ({ METRICS: metrics.METRICS })),
    ];
    try {
      try {
        expect((await pause(true)).status).toBe(200);
        expect((await put(session, payload)).status).toBe(503);
      } finally { expect((await pause(false)).status).toBe(200); }
      await finish(session, [await part(session, payload)]);
    } finally { for (const undo of restore) await undo(); }
    expect(metrics.points).toEqual([
      point('budget_refused', 'uploads_paused'), point('part_refused', 'uploads_paused'), point('part_confirmed', '', payload.length),
      // The test's requests send no User-Agent: the kind of client is `other`; no password, not one-time.
      point('completion_ms', '', expect.any(Number)), point('upload_completed', '', payload.length, ['other', '', '']), point('completion_lifetime', '', 86400, ['other']),
    ]);
  });

  it('counts downloads that start by client kind and one-time flag, never resumed ranges, HEAD or the agent string', async () => {
    const regular = await file(), once = await file(true), metrics = dataset();
    const get = async (url: string, headers: Record<string, string>) => {
      const sent = await direct(pathOf(url), metrics, { headers });
      await sent.response.arrayBuffer();
      await sent.settled();
      return sent.response.status;
    };
    const agents: [string, string][] = [
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36', 'browser'], ['fyl-cli/1.0.0', 'cli'], ['curl/8.5.0', 'curl'],
      ['Wget/1.21.4', 'wget'], ['python-requests/2.32.3', 'other'], ['', 'other'],
      // fyl's own tools and the operator's marked checks count apart, so they stay out of the Downloads tile.
      ['fyl-smoke/1.0.1', 'own'], ['fyl-smoke', 'own'], ['curl/8.5.0 fyl-ops', 'own'], ['fyl/1.0.0', 'other'],
    ];
    for (const [agent, kind] of agents) {
      expect(await get(regular.receipt.url + '?dl=1', { 'User-Agent': agent }), kind).toBe(200);
      expect(metrics.points.at(-1), agent).toEqual(point('download_started', kind, 0));
    }
    const counted = metrics.points.length;
    expect(await get(regular.receipt.url, { 'User-Agent': 'curl/8.5.0', Range: 'bytes=4-' })).toBe(206);
    expect((await direct(pathOf(regular.receipt.url), metrics, { method: 'HEAD' })).response.status).toBe(200);
    expect(metrics.points).toHaveLength(counted);
    // A range from the first byte starts a download; a one-time link counts with the value 1.
    expect(await get(once.receipt.url, { 'User-Agent': 'curl/8.5.0', Range: 'bytes=0-3' })).toBe(206);
    expect(metrics.points.slice(counted)).toEqual([point('download_started', 'curl', 1)]);
    expect(JSON.stringify(metrics.points)).not.toMatch(/Mozilla|python|8\.5\.0|fyl-cli|fyl-smoke|fyl-ops/);
  });

  it('counts refused requests by the limit that refused them, never by network', async () => {
    const metrics = dataset(), refusing = { limit: async () => ({ success: false }) };
    const sent = await direct('/api/upload/init', { ...metrics, INIT_RATE: refusing }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(sent.response.status).toBe(429);
    const polled = await direct(`/api/transfers/${'a'.repeat(43)}`, { ...metrics, STATUS_RATE: refusing });
    expect(polled.response.status).toBe(429);
    expect(metrics.points).toEqual([point('rate_limited', 'init'), point('rate_limited', 'status')]);
  });

  it('counts the GB-days a transfer was stored at its cleanup, by how it ended, and the lifetime it completed with', async () => {
    const day = 86400000, size = 3 * 1024 ** 2, session = await init(size), metrics = dataset();
    const stub = env.TRANSFERS.getByName(session.uploadId);
    const restore = await swap(stub, () => ({ METRICS: metrics.METRICS }));
    try {
      const receipt = await finish(session, [await part(session, new Uint8Array(size).fill(7))]);
      // Downloaded twice (and once only its headers, which counts no download), stored for two days, then it expires.
      for (const method of ['GET', 'GET', 'HEAD']) await (await direct(pathOf(receipt.url), {}, { method })).response.arrayBuffer();
      await edit(session.uploadId, stored => { stored.completedAt = Date.now() - 2 * day; stored.expiresAt = Date.now() - 1; });
      await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally { await restore(); }
    const stored = metrics.points.find(entry => entry.blobs?.[0] === 'stored_gb_days');
    expect(stored?.blobs).toEqual(['stored_gb_days', 'expired', 'other']);
    expect(stored?.doubles?.[0]).toBeCloseTo(size / 1024 ** 3 * 2, 4);
    // With how often it was downloaded.
    expect(stored?.doubles?.[1]).toBe(2);
    expect(metrics.points.find(entry => entry.blobs?.[0] === 'completion_lifetime')?.doubles).toEqual([86400]);
    // Cleanup keeps no kind of client in the tombstone.
    expect((await record(session.uploadId)).client).toBeUndefined();
    // An upload that never completed: the finished parts R2 held, from its start until it was aborted a day later.
    const unfinished = await init(size), held = dataset();
    await part(unfinished, new Uint8Array(size).fill(8));
    await edit(unfinished.uploadId, record => { record.createdAt = Date.now() - day; });
    const undo = await swap(env.TRANSFERS.getByName(unfinished.uploadId), () => ({ METRICS: held.METRICS }));
    try { expect((await post('/api/upload/abort', unfinished)).status).toBe(200); }
    finally { await undo(); }
    const aborted = held.points.filter(entry => entry.blobs?.[0] === 'stored_gb_days');
    expect(aborted.map(entry => entry.blobs)).toEqual([['stored_gb_days', 'aborted', 'other']]);
    expect(aborted[0].doubles?.[0]).toBeCloseTo(size / 1024 ** 3, 4);
    expect(aborted[0].doubles?.[1]).toBe(0);
  });

  it('counts each admitted upload once by its kind of client, and a completed one with its options, never the agent string', async () => {
    const payload = new TextEncoder().encode('channel fixture');
    // A stable id (client key and Idempotency-Key), so its Transfer can count before the first request reaches it.
    const started = async (agent: string, extra: Record<string, unknown> = {}) => {
      // Unique per call: two calls on one key would replay each other's start (409).
      const unique = crypto.randomUUID().replaceAll('-', ''), clientKey = 'k'.repeat(11) + unique, idempotency = 'idem-' + unique;
      const id = await digest(clientKey + ':' + idempotency), metrics = dataset();
      const restore = await swap(env.TRANSFERS.getByName(id), () => ({ METRICS: metrics.METRICS }));
      try {
        const body = { filename: 'notes.txt', size: payload.length, expiresIn: 300, clientKey, ...extra };
        const headers = { 'User-Agent': agent, 'Idempotency-Key': idempotency };
        const session = await (await post('/api/upload/init', body, headers)).json<{ uploadId: string; key: string; url: string }>();
        // A replay of the same start answers the same session and counts nothing more.
        expect((await post('/api/upload/init', body, headers)).status).toBe(201);
        await finish(session, [await part(session, payload)]);
        return { id, points: metrics.points };
      } finally { await restore(); }
    };
    const browser = await started('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36');
    const only = (points: AnalyticsEngineDataPoint[], event: string) => points.filter(entry => entry.blobs?.[0] === event).map(entry => entry.blobs);
    expect(only(browser.points, 'upload_started')).toEqual([['upload_started', 'browser']]);
    expect(only(browser.points, 'upload_completed')).toEqual([['upload_completed', '', 'browser', '', '']]);
    expect(only(browser.points, 'completion_lifetime')).toEqual([['completion_lifetime', '', 'browser']]);
    const cli = await started('fyl-cli/1.0.1', { password: 'a long password', oneTime: true });
    expect(only(cli.points, 'upload_started')).toEqual([['upload_started', 'cli']]);
    expect(only(cli.points, 'upload_completed')).toEqual([['upload_completed', '', 'cli', 'password', 'once']]);
    // The smoke test's CLI marks itself (FYL_UA_SUFFIX): fyl's own uploads, which the dashboard leaves out.
    const smoke = await started('fyl-cli/1.0.1 fyl-smoke');
    expect(only(smoke.points, 'upload_completed')).toEqual([['upload_completed', '', 'own', '', '']]);
    for (const { id, points } of [browser, cli, smoke]) {
      const text = JSON.stringify(points);
      for (const part of [id, 'Mozilla', 'fyl-cli', 'notes.txt', 'a long password']) expect(text).not.toContain(part);
    }
    // A record from before the kind of client was kept counts as `unknown`.
    const session = await init(payload.length), old = dataset();
    await edit(session.uploadId, stored => { delete stored.client; });
    const undo = await swap(env.TRANSFERS.getByName(session.uploadId), () => ({ METRICS: old.METRICS }));
    try { await finish(session, [await part(session, payload)]); } finally { await undo(); }
    expect(only(old.points, 'upload_completed')).toEqual([['upload_completed', '', 'unknown', '', '']]);
  });

  it('counts fetches of the CLI installer and binaries by platform, not other CLI files, a HEAD or our own', async () => {
    const metrics = dataset(), fetch = async (path: string, init: RequestInit = {}) => {
      const { response } = await direct(path, metrics, init);
      await response.arrayBuffer();
      return response.status;
    };
    expect(await fetch('/cli/install', { headers: { 'User-Agent': 'curl/8.5.0' } })).toBe(200);
    expect(await fetch(`/cli/${version}/fyl-linux-x86_64`)).toBe(200);
    expect(await fetch(`/cli/${version}/fyl-macos-arm64`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)' } })).toBe(200);
    for (const [path, init] of [['/cli/latest', {}], ['/cli/version.json', {}], [`/cli/${version}/SHA256SUMS`, {}], ['/cli/install', { method: 'HEAD' }],
      [`/cli/${version}/fyl-linux-arm64`, { headers: { 'User-Agent': `fyl-smoke/${version}` } }], ['/cli/9.9.9/fyl-linux-x86_64', {}], ['/cli/fyl-linux-x86_64', {}]] as const) await fetch(path, init);
    expect(metrics.points.filter(entry => entry.blobs?.[0] === 'cli_fetch')).toEqual([point('cli_fetch', 'install'), point('cli_fetch', 'linux-x86_64'), point('cli_fetch', 'macos-arm64')]);
  });

  it('counts a fallback when the Budget cannot hear that an upload completed, and still completes it', async () => {
    const payload = new TextEncoder().encode('completed anyway'), session = await init(payload.length), metrics = dataset();
    const stub = env.TRANSFERS.getByName(session.uploadId), done = await part(session, payload);
    const restore = await swap(stub, ({ BUDGET }) => ({ METRICS: metrics.METRICS, BUDGET: { getByName: (name: string) => {
      const real = BUDGET.getByName(name);
      return { uploaded: failed, release: (id: string) => real.release(id) };
    } } as unknown as Env['BUDGET'] }));
    try { expect((await finish(session, [done])).url).toContain(session.uploadId); }
    finally { await restore(); }
    expect(fallbacks(metrics.points)).toEqual([point('fallback', 'budget_uploaded')]);
    // Its network's place stays taken until the cleanup frees it: counted too long, never too short.
    expect(await runInDurableObject(budget(env), (_instance, ctx) =>
      ctx.storage.sql.exec<{ running: number }>('SELECT running FROM reservations WHERE id = ?', session.uploadId).one().running)).toBe(1);
  });

  it('counts a fallback when a part attempt cannot be settled at once, which its lease then ends', async () => {
    const payload = new TextEncoder().encode('settled by the lease'), session = await init(payload.length), metrics = dataset();
    // The Budget admits attempts but can't hear how they ended.
    const restore = await swap(env.TRANSFERS.getByName(session.uploadId), ({ BUDGET }) => ({ METRICS: metrics.METRICS, BUDGET: { getByName: (name: string) => {
      const real = BUDGET.getByName(name);
      return { reservePart: (id: string, number: number, slot: number, ticket: string, bytes: number, network: string) =>
        real.reservePart(id, number, slot, ticket, bytes, network), confirmPart: failed, releasePart: failed };
    } } as unknown as Env['BUDGET'] }));
    try {
      // R2 refuses the write, and the Transfer can't free the attempt: the Worker counts it.
      const refusing = { resumeMultipartUpload: () => ({ uploadPart: async () => { throw new Error('R2 is unavailable'); } }) } as unknown as R2Bucket;
      const written = await direct('/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: '1' }), { METRICS: metrics.METRICS, FILES: refusing }, {
        method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), Authorization: 'Bearer ' + session.key },
      });
      expect(written.response.status).toBe(503);
      await written.settled();
      expect(metrics.points).toEqual([point('part_failed', '', payload.length), point('fallback', 'part_fail')]);
      // R2 stores the next attempt, but neither confirming nor releasing it reaches the Budget: the Transfer counts it.
      expect((await put(session, payload)).status).toBe(503);
      expect(fallbacks(metrics.points)).toEqual([point('fallback', 'part_fail'), point('fallback', 'part_release')]);
    } finally { await restore(); }
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('counts a fallback when an object R2 completed after the transfer closed cannot be deleted at once; a later cleanup removes it', async () => {
    const payload = new TextEncoder().encode('completed after its takedown'), session = await init(payload.length), metrics = dataset();
    const stub = env.TRANSFERS.getByName(session.uploadId), done = await part(session, payload);
    const storage = await runInDurableObject(stub, (_instance, ctx) => ctx.storage);
    const restore = await swap(stub, ({ FILES }) => ({ METRICS: metrics.METRICS, FILES: {
      head: (key: string) => FILES.head(key), delete: failed,
      resumeMultipartUpload: (key: string, uploadId: string) => ({ complete: async (parts: R2UploadedPart[]) => {
        const object = await FILES.resumeMultipartUpload(key, uploadId).complete(parts);
        // A takedown closed the transfer while R2 completed it.
        const record = JSON.parse(storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id=1').one().payload);
        storage.sql.exec('UPDATE transfer SET payload=? WHERE id=1', JSON.stringify({ ...record, status: 'removed' }));
        return object;
      } }),
    } as unknown as R2Bucket }));
    try { expect((await post('/api/upload/complete', { ...session, parts: [done] })).status).toBe(409); }
    finally { await restore(); }
    expect(fallbacks(metrics.points)).toEqual([point('fallback', 'orphan_delete')]);
    expect(await env.FILES.head(`files/${session.uploadId}`)).not.toBeNull();
    expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: session.uploadId, note: 'orphan fixture' }) })).status).toBe(200);
    expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
  });

  it('writes no metric for a part request with the key in the URL, which is refused like any request without a key', async () => {
    const metrics = dataset(), session = await init(3);
    const old = await direct(`/api/upload/part?uploadId=${session.uploadId}&key=${session.key}&partNumber=1`, metrics, {
      method: 'PUT', body: new Uint8Array(3), headers: { 'Content-Length': '3' },
    });
    expect([old.response.status, await old.response.json()]).toEqual([400, { error: 'Invalid upload session.', code: 'request_failed' }]);
    expect(metrics.points).toEqual([]);
  });
});
