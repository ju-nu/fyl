import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { randomToken, networkOf, networkHash, digest, budget, unwrap, PART_BYTES, TOMBSTONE_TTL_MS } from '../src/shared';
import { call, post, init, part, finish, file, pathOf, pageOf, operator, record, edit, swap, useNetworkPrefix, type Session } from './helpers';

useNetworkPrefix('198.18.18.');

const alarmIn = (id: string, ms: number) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => ctx.storage.setAlarm(Date.now() + ms));

describe('fyl.at Worker + real local R2/SQLite bindings', () => {
  describe('uploads and downloads', () => {
    it('provides non-browser JSON health and rejects malformed admission', async () => {
      expect((await call('/api/health')).status).toBe(200);
      expect((await post('/api/upload/init', { filename: 'empty', size: 0 })).status).toBe(413);
      expect((await post('/api/upload/init', { filename: 'large', size: Number(env.MAX_FILE_BYTES) + 1 })).status).toBe(413);
      expect((await post('/api/upload/init', { filename: '../escape', size: 1 })).status).toBe(400);
      expect((await post('/api/upload/init', { filename: 'ok', size: 1, expiresIn: 299 })).status).toBe(400);
      expect((await post('/api/upload/init', { filename: 'ok', size: 1 }, { Origin: 'https://other.invalid' })).status).toBe(403);
    });
    it('admits a 50 GB file with a day to upload and reads its bounded part manifest', async () => {
      expect(Number(env.MAX_FILE_BYTES)).toBe(50 * 1024 ** 3);
      const session = await init(50 * 1024 ** 3, false, 'large-archive.zip');
      try {
        const stored = await record(session.uploadId);
        expect(stored.uploadDeadline - stored.createdAt).toBe(86400000);
        // The 1,024 parts live in their own table, one row each, never in the transfer record.
        expect(stored).not.toHaveProperty('parts');
        expect(await runInDurableObject(env.TRANSFERS.getByName(session.uploadId), (_instance, ctx) =>
          ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM parts').one().count)).toBe(0);
        const parts = Array.from({ length: Math.ceil(50 * 1024 ** 3 / PART_BYTES) }, (_, index) => ({ partNumber: index + 1, etag: 'a'.repeat(80) }));
        expect(JSON.stringify({ ...session, parts }).length).toBeGreaterThan(65536);
        // Missing parts must be rejected by authoritative state, rather than the old 64 KiB body limit.
        expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(409);
      } finally {
        expect((await post('/api/upload/abort', session)).status).toBe(200);
      }
    });
    it('makes opted-in init retries idempotent without sharing capabilities', async () => {
      const clientKey = randomToken(), key = crypto.randomUUID().replaceAll('-', '');
      const metadata = { filename: 'stable.txt', size: 1, clientKey };
      const a = await post('/api/upload/init', metadata, { 'Idempotency-Key': key });
      const b = await post('/api/upload/init', metadata, { 'Idempotency-Key': key });
      const first = await a.json<Session>();
      expect(await b.json()).toEqual(first);
      expect(first.key).toBe(clientKey);
      expect((await post('/api/upload/init', { ...metadata, size: 2 }, { 'Idempotency-Key': key })).status).toBe(409);
      expect((await post('/api/upload/abort', first)).status).toBe(200);
    });
    it('uploads and downloads exact bytes with attachment headers and byte ranges', async () => {
      const { receipt, payload } = await file();
      const response = await call(pathOf(receipt.url));
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      const disposition = response.headers.get('Content-Disposition') ?? '';
      expect(disposition.startsWith('attachment;')).toBe(true);
      expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe("report & '旅行'.zip");
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      // HEAD tells a download manager the same: it can split and resume, and the ETag to check against.
      const head = await call(pathOf(receipt.url), { method: 'HEAD' });
      expect([head.status, head.headers.get('Accept-Ranges'), head.headers.get('ETag')]).toEqual([200, 'bytes', response.headers.get('ETag')]);
      expect(response.headers.get('ETag')).toBeTruthy();
      const range = await call(pathOf(receipt.url), { headers: { Range: 'bytes=2-5' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('Content-Range')).toBe(`bytes 2-5/${payload.length}`);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(payload.slice(2, 6));
    });
    it('sends file responses with a CSP that runs nothing, and leaves the download page its own', async () => {
      const plain = await file(), locked = await file(false, 'tide-lamp-41'), policy = "default-src 'none'; sandbox";
      const basic = { Authorization: 'Basic ' + btoa('fyl:tide-lamp-41') };
      const [open, closed] = [pathOf(plain.receipt.url), pathOf(locked.receipt.url)];
      for (const [url, init] of [[open, {}], [open, { method: 'HEAD' }], [open, { headers: { Range: 'bytes=1-2' } }], [open + '?dl=1', { headers: { Accept: 'text/html' } }],
        [closed, { headers: basic }], [closed, { method: 'HEAD', headers: basic }]] as const) {
        const response = await call(url, init);
        expect(response.status, url).toBeLessThan(300);
        expect(response.headers.get('Content-Disposition'), url).toMatch(/^attachment;/);
        expect(response.headers.get('Content-Security-Policy'), url).toBe(policy);
        await response.arrayBuffer();
      }
      const page = await call(pathOf(plain.receipt.url), { headers: { Accept: 'text/html' } });
      expect(page.headers.get('Content-Type')).toContain('text/html');
      expect(page.headers.get('Content-Security-Policy')).not.toBe(policy);
      await page.text();
    });
    it('assembles real multipart uploads with a smaller final part', async () => {
      const session = await init(PART_BYTES + 3);
      const second = await part(session, new Uint8Array([7, 8, 9]), 2);
      const first = await part(session, new Uint8Array(PART_BYTES).fill(42), 1);
      expect((await post('/api/upload/complete', { ...session, parts: [second, first] })).status).toBe(409);
      const receipt = await finish(session, [first, second]);
      const response = await call(pathOf(receipt.url), { headers: { Range: `bytes=${PART_BYTES - 1}-` } });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([42, 7, 8, 9]));
    });
    it('requires the private capability for expiry and instant deletion', async () => {
      const { receipt, session } = await file();
      const path = `/api/transfers/${receipt.id}`;
      expect((await call(path, { method: 'DELETE' })).status).toBe(403);
      expect((await call(path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + randomToken() } })).status).toBe(403);
      const changed = await call(path, { method: 'PATCH', headers: { Authorization: 'Bearer ' + receipt.deleteToken,
        'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 604800 }) });
      expect(changed.status).toBe(200);
      expect((await changed.json<{ expiresAt: number }>()).expiresAt).toBeGreaterThan(receipt.expiresAt);
      expect((await call(path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
      expect((await call(pathOf(receipt.url))).status).toBe(410);
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    });
    it('replays completion but never lets abort delete a completed file', async () => {
      const { receipt, session, parts } = await file();
      const replay = await finish(session, parts);
      expect(replay).toEqual(receipt);
      expect((await post('/api/upload/abort', session)).status).toBe(409);
      const download = await call(pathOf(receipt.url));
      expect(download.status).toBe(200);
      await download.arrayBuffer();
    });
    it('revokes an incomplete upload and rejects private-key guesses', async () => {
      const session = await init(3);
      const bad = await post('/api/upload/abort', { ...session, key: randomToken() });
      expect(bad.status).toBe(403);
      expect((await post('/api/upload/abort', session)).status).toBe(200);
      expect((await post('/api/upload/abort', session)).status).toBe(200);
      expect((await post('/api/upload/complete', { ...session, parts: [{ partNumber: 1, etag: 'wrong' }] })).status).toBe(410);
      // An upload that never completed says so (410 aborted), for its owner too, so a client can tell it from a deleted file;
      // also one past its upload window whose alarm hasn't run yet. Browsers keep the "not found" page.
      const late = await init(3);
      await edit(late.uploadId, stored => { stored.uploadDeadline = Date.now() - 1; });
      for (const id of [session.uploadId, late.uploadId]) {
        for (const [path, headers] of [[`/api/transfers/${id}`, {}], [`/api/transfers/${id}`, { Authorization: 'Bearer ' + (id === late.uploadId ? late.key : session.key) }],
          [`/d/${id}`, {}]] as const) {
          const closed = await call(path, { headers });
          expect([closed.status, (await closed.json<{ code: string }>()).code], path).toEqual([410, 'aborted']);
        }
        expect((await pageOf(await call(`/d/${id}`, { headers: { Accept: 'text/html' } }))).data).toMatchObject({ state: 'gone', reason: 'missing' });
      }
    });
    it('takes the upload key only from the Authorization header', async () => {
      const payload = new TextEncoder().encode('header-authenticated part');
      const session = await init(payload.length);
      const put = (headers: Record<string, string>) => call(`/api/upload/part?uploadId=${session.uploadId}&partNumber=1`, {
        method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), ...headers },
      });
      expect((await put({ Authorization: 'Bearer not-a-key' })).status).toBe(403);
      // A key in the URL (as CLI 2.0 sent it) authorises nothing: alone, or next to a wrong key in the header.
      const inUrl = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
        call(`${path}?uploadId=${session.uploadId}&key=${session.key}&partNumber=1`, { ...init, headers: { ...init.headers as Record<string, string>, ...headers } });
      const sending = { method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length) } };
      for (const [path, headers, init, status] of [['/api/upload/part', {}, sending, 400], ['/api/upload/part', { Authorization: 'Bearer ' + randomToken() }, sending, 403],
        ['/api/upload/status', {}, {}, 400], ['/api/upload/status', { Authorization: 'Bearer ' + randomToken() }, {}, 403]] as const) {
        const refused = await inUrl(path, headers, init);
        expect([path, refused.status], JSON.stringify(headers)).toEqual([path, status]);
        expect(JSON.stringify(await refused.json())).not.toContain(session.key);
      }
      const owner = { Authorization: 'Bearer ' + session.key };
      expect((await (await call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: owner })).json<{ parts: unknown[] }>()).parts).toEqual([]);
      expect((await put({ Authorization: 'Bearer ' + randomToken() })).status).toBe(403);
      const accepted = await put({ Authorization: 'Bearer ' + session.key });
      expect(accepted.status).toBe(200);
      const { etag } = await accepted.json<{ etag: string }>();
      const receipt = await finish(session, [{ partNumber: 1, etag }]);
      expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
    });
    it('reports finished parts so an interrupted upload can resume', async () => {
      const first = new Uint8Array(PART_BYTES).fill(7), last = new TextEncoder().encode('tail');
      const session = await init(PART_BYTES + last.length);
      const status = (key = session.key) => call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + key } });
      expect((await status(randomToken())).status).toBe(403);
      expect((await call(`/api/upload/status?uploadId=${session.uploadId}`)).status).toBe(400);
      const done = await part(session, first, 1);
      const before = await (await status()).json<{ status: string; size: number; partSize: number; parts: { partNumber: number; size: number; etag: string }[] }>();
      expect(before).toMatchObject({ status: 'uploading', size: PART_BYTES + last.length, partSize: PART_BYTES });
      // In production R2's part ETag is the part's MD5; the local R2 simulator uses other ETags.
      expect(before.parts).toEqual([{ partNumber: 1, size: PART_BYTES, etag: done.etag }]);
      // Resume: only the missing part is sent, then the stored ETags complete the file.
      const tail = await part(session, last, 2);
      const receipt = await finish(session, [{ partNumber: 1, etag: done.etag }, tail]);
      expect((await (await call(pathOf(receipt.url))).arrayBuffer()).byteLength).toBe(PART_BYTES + last.length);
      expect((await (await status()).json<{ status: string }>()).status).toBe('ready');
    });
    it('answers changes to an upload that is still running with 409 upload_running, not 410 aborted, for both owner PATCH bodies', async () => {
      const session = await init(10, false, 'running.zip', 'tide-lamp-41');
      for (const body of [{ expiresIn: 600 }, { clearPause: true }]) {
        const response = await call(`/api/transfers/${session.uploadId}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect([response.status, await response.json()], JSON.stringify(body)).toEqual([409, { error: 'This upload is still running.', code: 'upload_running' }]);
      }
      // Once its window is over it is gone for good.
      await edit(session.uploadId, stored => { stored.uploadDeadline = Date.now() - 1; });
      const late = await call(`/api/transfers/${session.uploadId}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
      expect([late.status, (await late.json<{ code: string }>()).code]).toEqual([410, 'aborted']);
    });
  });

  describe('one-time downloads', () => {
    it('lets one network resume and split a one-time download, refuses others, and closes on a full download', async () => {
      const { receipt, payload, session } = await file(true);
      const path = pathOf(receipt.url), downloader = '198.51.100.7', other = '203.0.113.9';
      expect((await call(path, { method: 'HEAD' }, other)).status).toBe(200);
      const first = await call(path, { headers: { Range: 'bytes=0-3' } }, downloader);
      expect(first.status).toBe(206);
      expect(first.headers.get('Accept-Ranges')).toBe('bytes');
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload.slice(0, 4));
      const blocked = await call(path, {}, other);
      expect(blocked.status).toBe(410);
      expect((await blocked.json<{ code: string }>()).code).toBe('consumed');
      const parts = await Promise.all([
        call(path, { headers: { Range: 'bytes=4-9' } }, downloader),
        call(path, { headers: { Range: 'bytes=10-' } }, downloader),
      ]);
      expect(parts.map(r => r.status)).toEqual([206, 206]);
      const joined = new Uint8Array([...payload.slice(0, 4), ...new Uint8Array(await parts[0].arrayBuffer()), ...new Uint8Array(await parts[1].arrayBuffer())]);
      expect(joined).toEqual(payload);
      const full = await call(path, {}, downloader);
      expect(full.status).toBe(200);
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(payload);
      await env.TRANSFERS.getByName(session.uploadId).finishConsumed();
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
      expect((await call(path, {}, downloader)).status).toBe(410);
    });
    it('keys network controls on the IPv6 /64 so one subscriber cannot rotate past them and can resume inside it', async () => {
      expect(networkOf('198.51.100.7')).toBe('198.51.100.7');
      expect(networkOf('2001:db8:85a3::8a2e:370:7334')).toBe('2001:0db8:85a3:0000::/64');
      expect(networkOf('2001:DB8:85A3:0:0:8A2E:370:7334')).toBe('2001:0db8:85a3:0000::/64');
      expect(networkOf('::1')).toBe('0000:0000:0000:0000::/64');
      expect(networkOf('fe80::')).toBe('fe80:0000:0000:0000::/64');
      expect(networkOf('local')).toBe('local');
      expect(networkOf('::ffff:192.0.2.1')).toBe('::ffff:192.0.2.1');
      expect(networkOf('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
      expect(networkOf('1::2::3')).toBe('1::2::3');
      expect(networkOf('fe80::1%eth0')).toBe('fe80::1%eth0');
      // The subscriber: the /56 a line is usually delegated; IPv4 and anything unparsed stay as they are.
      expect(networkOf('2001:db8:85a3:12ff::1', 56)).toBe('2001:0db8:85a3:1200::/56');
      expect(networkOf('2001:DB8:85A3:1201:0:8A2E:370:7334', 56)).toBe('2001:0db8:85a3:1200::/56');
      expect(networkOf('2001:db8:85a3:1301::1', 56)).toBe('2001:0db8:85a3:1300::/56');
      for (const value of ['198.51.100.7', 'local', '1::2::3', '::ffff:192.0.2.1']) expect(networkOf(value, 56)).toBe(value);
      const { receipt, payload } = await file(true);
      const path = pathOf(receipt.url);
      const first = await call(path, { headers: { Range: 'bytes=0-3' } }, '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
      expect(first.status).toBe(206);
      // A privacy-extension rotation inside the same /64 continues the session; another /64 is refused.
      const rotated = await call(path, { headers: { Range: 'bytes=4-' } }, '2001:db8:1:2:1111:2222:3333:4444');
      expect(rotated.status).toBe(206);
      expect(new Uint8Array([...new Uint8Array(await first.arrayBuffer()), ...new Uint8Array(await rotated.arrayBuffer())])).toEqual(payload);
      const neighbour = await call(path, { headers: { Range: 'bytes=0-' } }, '2001:db8:1:3:aaaa:bbbb:cccc:dddd');
      expect(neighbour.status).toBe(410);
    });
    it('closes a one-time link after a range that covers the whole file', async () => {
      const { receipt, payload } = await file(true);
      const path = pathOf(receipt.url), downloader = '198.51.100.9';
      const whole = await call(path, { headers: { Range: 'bytes=0-' } }, downloader);
      expect(whole.status).toBe(206);
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(payload);
      await expect.poll(async () => (await call(path, { method: 'HEAD' }, downloader)).status).toBe(410);
    });
    it('refuses a range it cannot serve before a one-time link opens its session or a download counts', async () => {
      const { receipt, payload, session } = await file(true);
      const path = pathOf(receipt.url), scanner = '198.51.100.30';
      for (const range of ['bytes=0-1,4-5', `bytes=${payload.length}-`, 'bytes=x-1', 'items=0-1']) {
        expect((await call(path, { headers: { Range: range } }, scanner)).status, range).toBe(416);
      }
      expect(await record(session.uploadId)).not.toHaveProperty('session');
      // The recipient, on another network, still gets the file.
      const download = await call(path, {}, '203.0.113.30');
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);
      const regular = await file();
      expect((await call(pathOf(regular.receipt.url), { headers: { Range: 'bytes=0-1,4-5' } })).status).toBe(416);
      expect((await record(regular.session.uploadId)).downloads).toBe(0);
    });
    it('shows browsers the download page for one-time links, so link previews cannot use up the download', async () => {
      const { receipt, payload, session } = await file(true);
      const path = pathOf(receipt.url), html = { Accept: 'text/html,application/xhtml+xml' };
      // Link previews and mail scanners ask for HTML: they get the page, and no download session opens.
      const preview = await call(path, { headers: html }, '198.51.100.20');
      expect(preview.status).toBe(200);
      const { data, html: page } = await pageOf(preview);
      expect(data).toMatchObject({ state: 'ready', name: "report & '旅行'.zip", size: payload.length, once: true, downloadUrl: receipt.url + '?dl=1' });
      expect(page).not.toContain('a real R2 fixture');
      expect(await record(session.uploadId)).not.toHaveProperty('session');
      // The page's Download button (?dl=1) delivers the file, here to another network than the preview's.
      const download = await call(path + '?dl=1', { headers: html }, '203.0.113.20');
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);
      const late = await call(path, { headers: html }, '198.51.100.20');
      expect(late.status).toBe(410);
      expect((await pageOf(late)).data).toMatchObject({ state: 'gone', reason: 'consumed', name: null });
    });
    it('closes an idle one-time download session through the alarm', async () => {
      const { receipt, session } = await file(true);
      const path = pathOf(receipt.url), downloader = '198.51.100.8';
      const range = await call(path, { headers: { Range: 'bytes=0-1' } }, downloader);
      expect(range.status).toBe(206);
      await range.arrayBuffer();
      // Once its response has ended, the session idles.
      await expect.poll(async () => (await record(session.uploadId)).session?.open).toBe(0);
      const stub = env.TRANSFERS.getByName(session.uploadId);
      expect((await record(session.uploadId)).session?.network).toMatch(/^[0-9a-f]{64}$/);
      expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      await edit(session.uploadId, record => { if (record.session) record.session.lastAt = Date.now() - 16 * 60 * 1000; });
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
      const response = await call(path, { headers: { Range: 'bytes=2-3' } }, downloader);
      expect(response.status).toBe(410);
      expect((await response.json<{ code: string }>()).code).toBe('consumed');
    });
    it('keeps a one-time session open while a response streams, and idles it from when the last one ended', async () => {
      const { session } = await file(true), stub = env.TRANSFERS.getByName(session.uploadId), network = 'f'.repeat(64);
      const idle = () => edit(session.uploadId, record => { if (record.session) record.session.lastAt = Date.now() - 16 * 60 * 1000; });
      // A download manager splits the file in two; one range ends, the other streams for longer than the idle time.
      const ask = { navigate: false, explicit: false };
      unwrap(await stub.claim(false, network, 'bytes=0-3', null, false, network, ask));
      unwrap(await stub.claim(false, network, 'bytes=4-', null, false, network, ask));
      unwrap(await stub.ended());
      expect((await record(session.uploadId)).session?.open).toBe(1);
      await idle();
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await record(session.uploadId)).status).toBe('ready');
      // Its end starts the idle time; the session closes when that runs out.
      unwrap(await stub.ended());
      expect((await record(session.uploadId)).session?.open).toBe(0);
      expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      await idle();
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await record(session.uploadId)).status).toBe('consumed');
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    });
    it('shows browsers the download page with the reason instead of JSON for a dead download link', async () => {
      const id = randomToken(), page = await call(`/d/${id}/gone.zip`, { headers: { Accept: 'text/html,application/xhtml+xml' } });
      expect(page.status).toBe(404);
      const { html, root, data } = await pageOf(page);
      expect(html).not.toContain('<base');
      expect(root).toContain('data-state="gone"');
      expect(data).toMatchObject({ state: 'gone', id, reason: 'missing', name: null, url: null });
      const api = await call(`/d/${randomToken()}/gone.zip`);
      expect(api.status).toBe(404);
      expect(api.headers.get('Content-Type')).toContain('application/json');
    });
  });

  describe('network hashes, probes and file names', () => {
    it('keys network hashes with the NETWORK_HASH_KEY secret, and has none without it', async () => {
      const keyed = await networkHash(env.NETWORK_HASH_KEY, '192.0.2.1:' + 20000);
      expect(keyed).toMatch(/^[0-9a-f]{64}$/);
      expect(keyed).not.toBe(await digest('192.0.2.1:' + 20000));
      expect(await networkHash('another key', '192.0.2.1:' + 20000)).not.toBe(keyed);
      for (const key of [undefined, '']) await expect(networkHash(key, 'value')).rejects.toMatchObject({ status: 503, code: 'misconfigured' });
    });
    it('leaves no storage behind when an unknown transfer is probed', async () => {
      const id = randomToken();
      expect((await call(`/api/transfers/${id}`)).status).toBe(404);
      expect((await call(`/d/${id}/probe.bin`)).status).toBe(404);
      await runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => {
        const tables = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transfer'").toArray();
        expect(tables).toEqual([]);
      });
    });
    it('rejects file names made only of dots, or with characters that break or disguise the name', async () => {
      for (const filename of ['.', '..', '...']) {
        expect((await post('/api/upload/init', { filename, size: 10 })).status).toBe(400);
      }
      // C0/C1 controls, line separators and a lone surrogate (which no URL or header can encode) break the name.
      const c = String.fromCodePoint;
      for (const filename of [c(0x202e), c(0x202a, 0x202c) + '..',
        'a' + c(0x85) + 'b', 'tab\there', 'line' + c(0x2028) + 'break', String.fromCharCode(0xd800) + '.bin', 'a/b', 'a\\b']) {
        expect((await post('/api/upload/init', { filename, size: 10 })).status, JSON.stringify(filename)).toBe(400);
      }
      // Bidi controls would show `invoice_<RLO>fdp.exe` as invoice_exe.pdf: they are dropped, so the name reads as it is
      // stored. WhatsApp wraps phone numbers in U+202A … U+202C.
      for (const [filename, stored] of [['invoice_' + c(0x202e) + 'fdp.exe', 'invoice_fdp.exe'], ['WhatsApp Chat - ' + c(0x202a) + '+43 1 234' + c(0x202c) + '.zip', 'WhatsApp Chat - +43 1 234.zip'],
        ['a' + c(0x2066) + 'b' + c(0x2069), 'ab'], ['a' + c(0x200f) + '.txt', 'a.txt'], ['a' + c(0x61c) + 'b', 'ab']] as const) {
        const response = await post('/api/upload/init', { filename, size: 10 });
        expect(response.status, JSON.stringify(filename)).toBe(201);
        const body = await response.json() as { url: string };
        expect(decodeURIComponent(new URL(body.url).pathname.split('/').pop() || ''), JSON.stringify(filename)).toBe(stored);
      }
      // Joiners inside emoji sequences and words are text, not controls.
      for (const filename of ['.env', c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) + '.jpg', c(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x645) + '.txt']) {
        expect((await post('/api/upload/init', { filename, size: 10 })).status, filename).toBe(201);
      }
    });
  });

  describe('cleanup and tombstones', () => {
    it('expires access and deletes the R2 object through a durable alarm', async () => {
      const { session, receipt } = await file();
      const stub = env.TRANSFERS.getByName(session.uploadId);
      await edit(session.uploadId, record => { record.expiresAt = Date.now() - 1; });
      // The helper fires this future alarm explicitly; avoid racing the local scheduler.
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
      const response = await call(pathOf(receipt.url));
      expect(response.status).toBe(410);
      expect((await response.json<{ code: string }>()).code).toBe('expired');
    });
    it('clears filenames after cleanup and drops the whole closed transfer after 7 days', async () => {
      const { session, receipt } = await file();
      expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
      const stub = env.TRANSFERS.getByName(session.uploadId);
      expect(TOMBSTONE_TTL_MS).toBe(7 * 86400000);
      const closed = await record(session.uploadId);
      expect(closed.clean).toBe(true);
      expect(closed.name).toBe('');
      expect(closed.purgeAt).toBeGreaterThan(Date.now() + TOMBSTONE_TTL_MS - 60000);
      expect(closed.purgeAt).toBeLessThanOrEqual(Date.now() + TOMBSTONE_TTL_MS);
      // An hour after cleanup the alarm checks once more for an object a racing completion left, then waits for the purge.
      expect(closed.verifyAt).toBeLessThanOrEqual(Date.now() + 3600000);
      expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBe(closed.verifyAt);
      await edit(session.uploadId, record => { record.verifyAt = Date.now() - 1; });
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await record(session.uploadId)).not.toHaveProperty('verifyAt');
      expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBe(closed.purgeAt);
      // Until then the link answers 410, not 404.
      await edit(session.uploadId, record => { record.purgeAt = Date.now() + 60000; });
      expect((await call(pathOf(receipt.url))).status).toBe(410);
      await edit(session.uploadId, record => { record.purgeAt = Date.now() - 1; });
      await alarmIn(session.uploadId, 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      // The purge leaves nothing: no tables, no alarm, only the 4 KiB of an empty object.
      await runInDurableObject(stub, async (_instance, ctx) => {
        expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).toEqual([]);
        expect(ctx.storage.sql.databaseSize).toBe(4096);
        expect(await ctx.storage.getAlarm()).toBeNull();
      });
      expect((await call(pathOf(receipt.url))).status).toBe(404);
    });
    it('keeps no network hash in a tombstone: a takedown during a one-time download drops the session', async () => {
      const { session, receipt } = await file(true);
      const reading = await call(pathOf(receipt.url), { headers: { Range: 'bytes=0-1' } });
      await reading.arrayBuffer();
      expect((await record(session.uploadId)).session?.network).toMatch(/^[0-9a-f]{64}$/);
      expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'during a download' }) })).status).toBe(200);
      expect(await record(session.uploadId)).toMatchObject({ status: 'removed', clean: true });
      expect(await record(session.uploadId)).not.toHaveProperty('session');
    });
    it('clears the name of a clean record that kept one and gives it a purge date when it next starts; a takedown keeps none', async () => {
      // As cleanups until 2026-10-27 left them: name, fingerprint and a one-time session kept, no purge date, no alarm.
      const stale = async (status: string) => {
        const { session, receipt } = await file(true), stub = env.TRANSFERS.getByName(session.uploadId);
        await edit(session.uploadId, record => {
          Object.assign(record, { status, clean: true, name: 'kept.txt', fingerprint: 'f'.repeat(64), session: { network: 'a'.repeat(64), guesser: 'g', startedAt: 1, lastAt: 1, open: 0 } });
          delete record.purgeAt; delete record.verifyAt;
        });
        await runInDurableObject(stub, (_instance, ctx) => ctx.storage.deleteAlarm());
        await evictDurableObject(stub);
        return { session, receipt, stub };
      };
      const { session, receipt, stub } = await stale('expired');
      const view = await (await operator(`/api/admin/transfers/${receipt.id}`)).json<{ name: string | null }>();
      expect(view.name).toBeNull();
      const fixed = await record(session.uploadId);
      expect([fixed.name, fixed.fingerprint]).toEqual(['', '']);
      expect(fixed).not.toHaveProperty('session');
      expect(fixed.purgeAt).toBeGreaterThan(Date.now() + TOMBSTONE_TTL_MS - 60000);
      expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBe(fixed.purgeAt);
      expect((await call(pathOf(receipt.url))).status).toBe(410);
      // A takedown loses the name too but stays for good: no purge date, no alarm.
      const removed = await stale('removed');
      expect((await call(pathOf(removed.receipt.url))).status).toBe(410);
      const kept = await record(removed.session.uploadId);
      expect([kept.name, kept.fingerprint, kept.purgeAt]).toEqual(['', '', undefined]);
      expect(await runInDurableObject(removed.stub, (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
    });
  });

  describe('operator', () => {
    it('lets the operator reconcile the budgets on demand', async () => {
      const response = await operator('/api/admin/reconcile', { method: 'POST' });
      expect([response.status, await response.json()]).toEqual([200, { drift: expect.any(Object), cleanups: { rearmed: expect.any(Number), released: expect.any(Number), failed: expect.any(Number) } }]);
      expect((await operator('/api/admin/reconcile')).status).toBe(405);
      expect((await operator('/api/admin/reconcile', { method: 'POST' }, '')).status).toBe(401);
      // Nothing drifted since: the second run fixes nothing.
      expect(await (await operator('/api/admin/reconcile', { method: 'POST' })).json()).toEqual({ drift: {}, cleanups: { rearmed: 0, released: 0, failed: 0 } });
    });
    it('lets the operator pause uploads and take a file down immediately', async () => {
      expect((await operator('/api/admin/uploads', {}, 'wrong-token')).status).toBe(401);
      expect((await operator('/api/admin/uploads', {}, '')).status).toBe(401);
      const status = await (await operator('/api/admin/uploads')).json<{ paused: boolean; stored: { maxBytes: number } }>();
      expect(status.paused).toBe(false);
      expect(status.stored.maxBytes).toBe(Number(env.MAX_STORED_BYTES));
      // An upload in progress, then the switch: new uploads and further parts are refused.
      const payload = new TextEncoder().encode('paused part');
      const inFlight = await init(payload.length);
      expect((await operator('/api/admin/uploads', { method: 'POST', body: JSON.stringify({ paused: true }) })).status).toBe(200);
      const refused = await post('/api/upload/init', { filename: 'blocked.bin', size: 10 });
      expect(refused.status).toBe(503);
      expect((await refused.json<{ code: string }>()).code).toBe('uploads_paused');
      expect((await call(`/api/upload/part?uploadId=${inFlight.uploadId}&partNumber=1`, {
        method: 'PUT', body: payload, headers: { 'Content-Length': String(payload.length), Authorization: 'Bearer ' + inFlight.key },
      })).status).toBe(503);
      expect((await operator('/api/admin/uploads', { method: 'POST', body: JSON.stringify({ paused: false }) })).status).toBe(200);
      expect((await post('/api/upload/init', { filename: 'allowed.bin', size: 10 })).status).toBe(201);
      // Takedown: bytes gone, public reason "removed" for API clients and browsers.
      const { receipt, session } = await file();
      expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: 'nope', note: 'malware' }) })).status).toBe(400);
      expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'malware' }) })).status).toBe(200);
      expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
      const gone = await call(pathOf(receipt.url));
      expect(gone.status).toBe(410);
      expect((await gone.json<{ code: string }>()).code).toBe('removed');
      const page = await call(pathOf(receipt.url), { headers: { Accept: 'text/html' } });
      expect((await pageOf(page)).data).toMatchObject({ state: 'gone', reason: 'removed' });
    });
  });

  describe('admission budgets', () => {
    it('keeps admission cleanup scheduled while uploads continue', async () => {
      const stub = env.BUDGET.getByName('alarm-budget-' + crypto.randomUUID());
      const scheduled = Date.now() + 60000;
      await runInDurableObject(stub, async (_instance, ctx) => {
        ctx.storage.sql.exec('INSERT INTO reservations (id,bytes,created_at,active,ip_hash) VALUES (?,?,?,?,?)', 'old', 1, Date.now() - 31 * 86400000, 0, 'old-network');
        await ctx.storage.setAlarm(scheduled);
      });
      expect((await stub.reserve('new', 1, 'network')).ok).toBe(true);
      await runInDurableObject(stub, async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).toBe(scheduled); });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, (_instance, ctx) => {
        expect(ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM reservations WHERE id=?', 'old').one().count).toBe(0);
        expect(ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM reservations WHERE active=1').one().count).toBe(1);
      });
    });
    it('enforces a durable admission budget under concurrent reservations', async () => {
      const stub = env.BUDGET.getByName('budget-' + crypto.randomUUID());
      const stored = Number(env.MAX_STORED_BYTES), daily = Number(env.MAX_DAILY_UPLOAD_BYTES);
      const cap = Math.min(stored, daily), tighter = stored <= daily ? 'storage_capacity' : 'daily_budget';
      const bytes = Math.ceil(cap * .6);
      // The global budgets are contested here, not one network's.
      await swap(stub, () => ({ MAX_DAILY_UPLOAD_BYTES_PER_NETWORK: String(stored) }) as unknown as Partial<Env>);
      // Declaring two files that could not both be stored admits both: nothing has been received yet.
      expect((await stub.reserve('one', bytes, 'network')).ok).toBe(true);
      expect((await stub.reserve('two', bytes, 'network')).ok).toBe(true);
      // The tighter budget is contested by bytes about to be sent, reserved before R2 may receive them.
      const results = await Promise.all([stub.reservePart('one', 1, 1, 'a', bytes, 'network'), stub.reservePart('two', 1, 1, 'b', bytes, 'network')]);
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.filter(r => !r.ok && r.status === 429 && r.code === tighter)).toHaveLength(1);
      const [charged, blocked] = results[0].ok ? ['one', 'two'] : ['two', 'one'], ticket = charged === 'one' ? 'a' : 'b';
      expect((await stub.reservePart(charged, 1, 1, ticket, bytes, 'network')).ok).toBe(true); // asking again for an attempt is idempotent
      expect((await stub.reservePart(charged, 2, 10, 'c', bytes + 1, 'network')).ok).toBe(false); // never more than declared
      expect(unwrap(await stub.confirmPart(charged, 1, 1, ticket))).toBe(true);
      unwrap(await stub.release(charged));
      // Released bytes still count for the day.
      const again = await stub.reservePart(blocked, 1, 1, 'd', bytes, 'network');
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.code).toBe('daily_budget');
      expect((await stub.reservePart(blocked, 1, 1, 'd', Math.floor(cap * .4), 'network')).ok).toBe(true);
      expect((await stub.reservePart('unknown', 1, 1, 'e', 1, 'network')).ok).toBe(false);
    });
    it('charges the daily payload to the day a part was admitted, also for uploads admitted the day before', async () => {
      const stub = env.BUDGET.getByName('budget-' + crypto.randomUUID()), bytes = Math.ceil(Number(env.MAX_DAILY_UPLOAD_BYTES) * .6);
      expect(Number(env.MAX_STORED_BYTES)).toBeGreaterThan(2 * bytes);
      await swap(stub, () => ({ MAX_DAILY_UPLOAD_BYTES_PER_NETWORK: env.MAX_STORED_BYTES }) as unknown as Partial<Env>);
      // Two uploads admitted just before midnight send all their bytes today.
      await runInDurableObject(stub, (_instance, ctx) => {
        for (const id of ['one', 'two'])
          ctx.storage.sql.exec('INSERT INTO reservations (id,bytes,created_at,ip_hash) VALUES (?,?,?,?)', id, bytes, Math.floor(Date.now() / 86400000) * 86400000 - 60000, 'network');
      });
      expect((await stub.reservePart('one', 1, 1, 'a', bytes, 'network')).ok).toBe(true);
      const refused = await stub.reservePart('two', 1, 1, 'b', bytes, 'network');
      expect(refused.ok ? '' : refused.code).toBe('daily_budget');
      expect((await stub.status()).today).toMatchObject({ bytes, payload: 0, reserved: bytes, uploads: 0 });
      unwrap(await stub.confirmPart('one', 1, 1, 'a'));
      expect((await stub.status()).today).toMatchObject({ bytes, payload: bytes, reserved: 0, attempted: bytes, uploads: 0 });
    });
    it('charges the global budgets with received bytes, so declared sizes alone cannot lock other uploaders out', async () => {
      const max = Number(env.MAX_FILE_BYTES), capacity = Math.max(Number(env.MAX_STORED_BYTES), Number(env.MAX_DAILY_UPLOAD_BYTES));
      const declare = (size: number, from: string, name = 'declared-only.bin') => call('/api/upload/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: name, size }),
      }, from);
      // Declare more maximum-size files than both global budgets could hold, without sending a byte.
      const sessions: Session[] = [];
      for (let i = 0; i <= Math.ceil(capacity / max); i++) {
        const response = await declare(max, `203.0.113.${i % 250 + 1}`);
        expect(response.status).toBe(201);
        sessions.push(await response.json<Session>());
      }
      // A real uploader is still admitted, before and after the declarations are aborted.
      const large = await declare(10 * 1024 ** 3, '198.51.100.20', 'legit.iso');
      expect(large.status, await large.clone().text()).toBe(201);
      expect((await post('/api/upload/abort', await large.json())).status).toBe(200);
      for (const session of sessions) expect((await post('/api/upload/abort', session)).status).toBe(200);
      expect((await declare(2048, '198.51.100.20', 'legit.txt')).status).toBe(201);
      // Bytes that are actually sent are charged before R2 may receive them.
      const admission = budget(env);
      const usedBytes = () => runInDurableObject(admission, (_instance, ctx) =>
        ctx.storage.sql.exec<{ used: number }>('SELECT COALESCE(SUM(used),0) AS used FROM reservations').one().used);
      const before = await usedBytes();
      const { session, payload } = await file();
      expect(await usedBytes()).toBe(before + payload.length);
      await runInDurableObject(admission, (_instance, ctx) => {
        const row = ctx.storage.sql.exec<{ used: number; bytes: number }>('SELECT used, bytes FROM reservations WHERE id = ?', session.uploadId).one();
        expect(row).toEqual({ used: payload.length, bytes: payload.length });
      });
    }, 60_000);
  });
});
