import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { sign, validPassword, randomToken, resumeToken, PASSWORD_PAUSE_MS, PASSWORD_TRANSFER_TRIES } from '../src/shared';
import vectors from './vectors/passwords.json';
import { call, post, direct, file, init, pathOf, pageOf, record, edit, swap, tries, networkOfClient, operator, operatorDirect, useNetworkPrefix, OPERATOR_TOKEN } from './helpers';

useNetworkPrefix('198.18.7.');

const PASSWORD = 'tide-lamp-41';
const html = { Accept: 'text/html,application/xhtml+xml' };
const basic = (password: string) => ({ Authorization: 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('fyl:' + password))) });
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const codeOf = async (response: Response) => (await response.json<{ code: string }>()).code;
/** A grant for `id` as the Worker would sign it with `key`. */
const grantFor = async (id: string, key: string, expiry = Date.now() + 600000) => `${expiry}.${await sign(key, `fyl-grant:${id}:${expiry}`)}`;
/** The download page's password form, sent to the Worker with some bindings replaced. */
const unlock = async (path: string, password: string, bindings: Partial<Env>) => (await direct(path, bindings, {
  method: 'POST', body: new URLSearchParams({ password }).toString(),
  headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' },
})).response;
const fetchWith = async (path: string, bindings: Partial<Env>, init: RequestInit = {}) => (await direct(path, bindings, init)).response;
/** A METRICS stand-in that keeps the data points written to it. */
const dataset = () => {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } };
};
const limiter = (success: boolean) => {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success }; } };
};

describe('secrets', () => {
  it('never issues or accepts a grant without a GRANT_SIGNING_KEY of 32 characters, while Basic Auth still works', async () => {
    const { receipt, payload } = await file(false, PASSWORD), path = pathOf(receipt.url);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const key of [undefined, '', 'k'.repeat(31)]) {
        const bindings = { GRANT_SIGNING_KEY: key };
        // Unlocking would issue a grant: refused before the password is tried.
        const form = await unlock(path, PASSWORD, bindings);
        expect([form.status, await codeOf(form)]).toEqual([503, 'misconfigured']);
        // No grant passes: not one signed with the configured key, the short key, or the fixed key 2.2.0 fell back to.
        for (const signing of [String(env.GRANT_SIGNING_KEY), key || 'k', 'fyl-development-signing-key']) {
          const refused = await fetchWith(path + '?grant=' + await grantFor(receipt.id, signing), bindings);
          expect(refused.status).toBe(401);
          expect(refused.headers.get('WWW-Authenticate')).toContain('Basic');
          await refused.text();
        }
        // A protected upload can't start (its fingerprint is signed), an open one can.
        const upload = (password?: string) => fetchWith('/api/upload/init', bindings, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'a.bin', size: 1, password }),
        });
        const protectedInit = await upload(PASSWORD);
        expect([protectedInit.status, await codeOf(protectedInit)]).toEqual([503, 'misconfigured']);
        const openInit = await upload();
        expect(openInit.status).toBe(201);
        expect((await post('/api/upload/abort', await openInit.json())).status).toBe(200);
        // Basic Auth checks the password itself.
        expect(await bytes(await fetchWith(path, bindings, { headers: basic(PASSWORD) }))).toEqual(payload);
      }
      // The refused forms counted no tries; the log names the secret and nothing else.
      expect(await tries(receipt.id)).toEqual([]);
      const logged = errors.mock.calls.map(([line]) => String(line)).filter(line => line.includes('misconfigured'));
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) expect(JSON.parse(line)).toEqual({ event: 'misconfigured', missing: 'GRANT_SIGNING_KEY' });
    } finally { errors.mockRestore(); }
  });

  it('accepts grants signed with GRANT_SIGNING_KEY_PREVIOUS while the key is rotated, and nothing longer than a grant lives', async () => {
    const { receipt, payload } = await file(false, PASSWORD), path = pathOf(receipt.url);
    const old = String(env.GRANT_SIGNING_KEY), next = 'next-grant-signing-key-0123456789abcdef', weak = 'w'.repeat(31);
    const rotated = { GRANT_SIGNING_KEY: next, GRANT_SIGNING_KEY_PREVIOUS: old, GRANT_SIGNING_KEY_ROTATED_AT: String(Date.now()) };
    const issued = await grantFor(receipt.id, old);
    expect(await bytes(await fetchWith(path + '?grant=' + issued, rotated))).toEqual(payload);
    // The rotation time may be an ISO date too.
    expect(await bytes(await fetchWith(path + '?grant=' + issued, { ...rotated, GRANT_SIGNING_KEY_ROTATED_AT: new Date().toISOString() }))).toEqual(payload);
    // New grants come from the new key.
    const { data } = await pageOf(await unlock(path, PASSWORD, rotated));
    const fresh = new URL(String(data.downloadUrl)).searchParams.get('grant') || '';
    expect(fresh).toBe(await grantFor(receipt.id, next, Number(fresh.split('.')[0])));
    expect(await bytes(await fetchWith(path + '?grant=' + fresh, rotated))).toEqual(payload);
    // Once the previous key is removed, or with one too short to count, its grants are refused; so are grants more
    // than an hour ahead, and without the current key the previous one passes nothing.
    // A previous key passes only grants it signed before the rotation: one left in place (or leaked) mints nothing an
    // hour later, and without the rotation time it passes nothing at all.
    const hoursAgo = { ...rotated, GRANT_SIGNING_KEY_ROTATED_AT: String(Date.now() - 2 * 3600000) };
    for (const [grant, bindings] of [
      [issued, { GRANT_SIGNING_KEY: next }], [await grantFor(receipt.id, weak), { ...rotated, GRANT_SIGNING_KEY_PREVIOUS: weak }],
      [await grantFor(receipt.id, old, Date.now() + 2 * 3600000), rotated], [issued, { GRANT_SIGNING_KEY: undefined, GRANT_SIGNING_KEY_PREVIOUS: old }],
      [issued, hoursAgo], [issued, { GRANT_SIGNING_KEY: next, GRANT_SIGNING_KEY_PREVIOUS: old }], [issued, { ...rotated, GRANT_SIGNING_KEY_ROTATED_AT: 'soon' }],
    ] as const) {
      const refused = await fetchWith(path + '?grant=' + grant, bindings);
      expect(refused.status).toBe(401);
      await refused.text();
    }
  });

  it('refuses every request that needs a network hash without NETWORK_HASH_KEY, and a weak one signs nothing', async () => {
    const { receipt } = await file(false, PASSWORD), path = pathOf(receipt.url), missing = { NETWORK_HASH_KEY: undefined };
    const json = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [route, request] of [
        [path, { headers: basic(PASSWORD) }], [path, { headers: html }], [path + '?grant=' + await grantFor(receipt.id, String(env.GRANT_SIGNING_KEY)), {}],
        [path, { method: 'POST', body: 'password=' + PASSWORD, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } }],
        ['/api/upload/init', json({ filename: 'a.bin', size: 1 })],
        ['/api/reports', json({ link: receipt.id, category: 'csam', details: 'A report that needs a network hash.', goodFaith: true })],
      ] as const) {
        const refused = await fetchWith(route, missing, request);
        expect([refused.status, await codeOf(refused)], route).toEqual([503, 'misconfigured']);
      }
      expect((await fetchWith(path, missing, { method: 'HEAD' })).status).toBe(503);
    } finally { errors.mockRestore(); }
    // The network key only pseudonymises networks: grants signed with a weak one (or the old fixed key) don't pass.
    for (const key of ['weak', 'fyl-development-signing-key']) {
      const refused = await fetchWith(path + '?grant=' + await grantFor(receipt.id, key), { NETWORK_HASH_KEY: key });
      expect(refused.status).toBe(401);
      await refused.text();
    }
  });
});

describe('password tries', () => {
  it('pauses only the network that guessed wrong 5 times; others keep their tries', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url), guesser = '198.18.7.10', recipient = '198.18.7.11';
    for (let attempt = 0; attempt < 5; attempt++) await (await call(path, { headers: basic('wrong-' + attempt) }, guesser)).text();
    const paused = await call(path, { headers: basic(PASSWORD) }, guesser);
    expect(paused.status).toBe(429);
    await paused.text();
    // The recipient behind another network gets the form and its tries, and downloads with the right password.
    expect((await pageOf(await call(path, { headers: html }, recipient))).data).toMatchObject({ state: 'protected', error: null, triesLeft: 5 });
    expect(await (await call(path, { headers: basic('typo') }, recipient)).text()).toBe('Wrong password. 4 tries left.\n');
    expect(await bytes(await call(path, { headers: basic(PASSWORD) }, recipient))).toEqual(payload);
    // A right password resets that network's count only.
    expect(await tries(session.uploadId)).toEqual([{ network: await networkOfClient(guesser, receipt.id), fails: 0, paused_until: expect.any(Number) }]);
  });

  it('counts the tries of one IPv6 /56 as one network, so a single line cannot pause the transfer for everyone', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url);
    // Ten /64s of one line, five wrong tries each: after the first five the whole line waits, its further tries count nothing.
    for (let net = 0; net < 10; net++)
      for (let attempt = 0; attempt < 5; attempt++) await (await call(path, { headers: basic('guess') }, `2001:db8:aa:aa${net.toString(16).padStart(2, '0')}::${attempt + 1}`)).text();
    const paused = await call(path, { headers: basic(PASSWORD) }, '2001:db8:aa:aaff::9');
    expect(paused.status).toBe(429);
    await paused.text();
    expect(await tries(session.uploadId)).toEqual([{ network: await networkOfClient('2001:db8:aa:aa00::1', receipt.id, 56), fails: 0, paused_until: expect.any(Number) }]);
    expect(await runInDurableObject(env.TRANSFERS.getByName(session.uploadId), (_instance, ctx) => ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM wrong_tries').one().count)).toBe(5);
    expect(await record(session.uploadId)).not.toHaveProperty('pwPausedUntil');
    // Recipients elsewhere, the next /56 included, still download.
    for (const recipient of ['198.18.7.40', '2001:db8:aa:ab00::1']) expect(await bytes(await call(path, { headers: basic(PASSWORD) }, recipient))).toEqual(payload);
  });

  it('pauses the whole transfer for 15 minutes once 50 wrong tries from any networks fall within 15 minutes', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url), stub = env.TRANSFERS.getByName(session.uploadId);
    const wrong = async (from: string) => (await call(path, { headers: basic('guess') }, from)).text();
    expect(await wrong('198.18.7.20')).toBe('Wrong password. 4 tries left.\n');
    // Many networks guessed already: two tries short of the limit.
    await runInDurableObject(stub, (_instance, ctx) => {
      for (let index = 0; index < PASSWORD_TRANSFER_TRIES - 3; index++) ctx.storage.sql.exec('INSERT INTO wrong_tries (at) VALUES (?)', Date.now() - index * 1000);
    });
    expect(await wrong('198.18.7.21')).toBe('Wrong password. 4 tries left.\n');
    const last = await call(path, { headers: basic('guess') }, '198.18.7.22');
    expect(last.status).toBe(429);
    expect(await last.text()).toBe('Too many wrong tries. Try again in 15 minutes.\n');
    // Every network is paused now, even with the right password, and the page shows it.
    for (const from of ['198.18.7.20', '198.18.7.23']) {
      const refused = await call(path, { headers: basic(PASSWORD) }, from);
      expect(refused.status).toBe(429);
      await refused.text();
    }
    const { data } = await pageOf(await call(path, { headers: html }, '198.18.7.24'));
    expect(data).toMatchObject({ state: 'protected', error: 'paused' });
    expect(data.pausedUntil).toBeGreaterThan(Date.now() + PASSWORD_PAUSE_MS - 60000);
    expect((await record(session.uploadId)).pwPausedUntil).toBe(data.pausedUntil);
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec('SELECT * FROM wrong_tries').toArray())).toEqual([]);
    // After the pause the right password works again.
    await edit(session.uploadId, stored => { stored.pwPausedUntil = Date.now() - 1; });
    expect(await bytes(await call(path, { headers: basic(PASSWORD) }, '198.18.7.24'))).toEqual(payload);
  });

  it('counts only the wrong tries of the last 15 minutes towards the pause of the whole transfer', async () => {
    const { receipt, session } = await file(false, PASSWORD), path = pathOf(receipt.url), stub = env.TRANSFERS.getByName(session.uploadId);
    expect(await (await call(path, { headers: basic('guess') }, '198.18.7.30')).text()).toBe('Wrong password. 4 tries left.\n');
    await runInDurableObject(stub, (_instance, ctx) => {
      for (let index = 0; index < PASSWORD_TRANSFER_TRIES; index++) ctx.storage.sql.exec('INSERT INTO wrong_tries (at) VALUES (?)', Date.now() - PASSWORD_PAUSE_MS - 1000);
    });
    expect(await (await call(path, { headers: basic('guess') }, '198.18.7.31')).text()).toBe('Wrong password. 4 tries left.\n');
    // The old ones are dropped; the two recent tries remain.
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM wrong_tries').one().count)).toBe(2);
    expect(await record(session.uploadId)).not.toHaveProperty('pwPausedUntil');
  });

  it('lets the sender lift every password pause at once, which counts as no try, and shows the pauses without network hashes', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url), stub = env.TRANSFERS.getByName(session.uploadId);
    const owner = (init: RequestInit = {}, key = receipt.deleteToken) =>
      call(`/api/transfers/${receipt.id}`, { ...init, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } });
    const lift = (body: unknown, key?: string) => owner({ method: 'PATCH', body: JSON.stringify(body) }, key);
    expect((await (await owner()).json<{ passwordPause: unknown }>()).passwordPause).toEqual({ until: null, networks: 0, networksUntil: null });
    // Two networks paused, a third two tries in, and the whole transfer paused as well.
    for (const from of ['198.18.7.50', '198.18.7.51']) for (let attempt = 0; attempt < 5; attempt++) await (await call(path, { headers: basic('guess') }, from)).text();
    for (let attempt = 0; attempt < 2; attempt++) await (await call(path, { headers: basic('typo') }, '198.18.7.52')).text();
    await edit(session.uploadId, stored => { stored.pwPausedUntil = Date.now() + PASSWORD_PAUSE_MS; });
    // One network's pause ends later than the other's: the sender sees the later end, so no client needs the pause length.
    const later = await networkOfClient('198.18.7.50', receipt.id, 56);
    await runInDurableObject(stub, (_instance, ctx) => { ctx.storage.sql.exec('UPDATE tries SET paused_until=paused_until+60000 WHERE network=?', later); });
    const paused = await (await owner()).json<{ passwordPause: { until: number | null; networks: number; networksUntil: number | null } }>();
    expect(paused.passwordPause).toEqual({ until: expect.any(Number), networks: 2, networksUntil: expect.any(Number) });
    expect(paused.passwordPause.until).toBeGreaterThan(Date.now());
    expect(paused.passwordPause.networksUntil).toBe(Math.max(...(await tries(session.uploadId)).map(row => row.paused_until)));
    expect((await tries(session.uploadId)).find(row => row.network === later)?.paused_until).toBe(paused.passwordPause.networksUntil);
    expect(JSON.stringify(paused)).not.toMatch(/[0-9a-f]{64}/);
    // Only the management key lifts it, with exactly {"clearPause": true}: nothing changes otherwise.
    for (const [body, key, status] of [[{ clearPause: true }, await resumeToken(receipt.deleteToken), 403], [{ clearPause: false }, undefined, 400],
      [{ clearPause: true, expiresIn: 600 }, undefined, 400], [{ clearPause: 'yes' }, undefined, 400]] as const) {
      const refused = await lift(body, key);
      expect(refused.status, JSON.stringify(body)).toBe(status);
      await refused.text();
    }
    expect((await record(session.uploadId)).pwPausedUntil).toBe(paused.passwordPause.until);
    const metrics = dataset(), restore = await swap(stub, () => ({ METRICS: metrics.METRICS }));
    let lifted: Response;
    try { lifted = await lift({ clearPause: true }); }
    finally { await restore(); }
    expect(lifted.status).toBe(200);
    expect(await lifted.json()).toMatchObject({ id: receipt.id, url: receipt.url, protected: true, owner: true, passwordPause: { until: null, networks: 0, networksUntil: null },
      serverTime: expect.any(Number) });
    expect(metrics.points).toEqual([{ indexes: ['password_unpaused'], blobs: ['password_unpaused', 'transfer'], doubles: [2] }]);
    expect(await record(session.uploadId)).not.toHaveProperty('pwPausedUntil');
    // The paused networks download at once; the third keeps its count, so lifting was no free try for anyone.
    expect(await bytes(await call(path, { headers: basic(PASSWORD) }, '198.18.7.51'))).toEqual(payload);
    expect(await (await call(path, { headers: basic('typo') }, '198.18.7.52')).text()).toBe('Wrong password. 2 tries left.\n');
    expect(await tries(session.uploadId)).toEqual([{ network: await networkOfClient('198.18.7.52', receipt.id, 56), fails: 3, paused_until: 0 }]);
    // Nothing to lift on an open file: the same answer, without pauses.
    const open = (await file()).receipt;
    const plain = await call(`/api/transfers/${open.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + open.deleteToken, 'Content-Type': 'application/json' }, body: '{"clearPause":true}' });
    expect(plain.status).toBe(200);
    expect(await plain.json()).not.toHaveProperty('passwordPause');
  });

  it('validates every shared password vector by code points in NFC, at init too', async () => {
    expect(vectors.length).toBeGreaterThan(20);
    for (const { input, valid, note } of vectors) expect(validPassword(input), note).toBe(valid);
    // Lone surrogates can't be encoded; they stay out of the shared file because some JSON parsers refuse them.
    for (const input of ['\ud800xxxxxx', 'xxxxxx\udfff']) expect(validPassword(input)).toBe(false);
    for (const { input, valid, note } of vectors) {
      const response = await post('/api/upload/init', { filename: 'vector.bin', size: 1, password: input });
      expect(response.status, note).toBe(valid ? 201 : 400);
      if (valid) expect((await post('/api/upload/abort', await response.json())).status).toBe(200);
      else expect((await response.json<{ error: string }>()).error).toBe('Password must be 6 to 200 characters, without control characters.');
    }
  });
});

describe('server time and status polling', () => {
  it('puts the server time into download pages and transfer info', async () => {
    const before = Date.now(), { receipt } = await file(), id = receipt.id;
    const pages = [await call(pathOf(receipt.url), { headers: html }), await call(`/d/${randomToken()}/gone.bin`, { headers: html })];
    for (const page of pages) {
      const { data } = await pageOf(page);
      expect(data.now).toBeGreaterThanOrEqual(before);
      expect(data.now).toBeLessThanOrEqual(Date.now());
    }
    const uploading = await init(10, false, 'early.bin');
    for (const [path, headers] of [[`/api/transfers/${id}`, {}], [`/api/transfers/${id}`, { Authorization: 'Bearer ' + receipt.deleteToken }],
      [`/api/transfers/${uploading.uploadId}`, {}]] as const) {
      const info = await (await call(path, { headers })).json<{ serverTime: number }>();
      expect(info.serverTime).toBeGreaterThanOrEqual(before);
      expect(info.serverTime).toBeLessThanOrEqual(Date.now());
    }
    expect((await post('/api/upload/abort', uploading)).status).toBe(200);
  });

  it("answers a change of expiry like the owner's GET: with the server time, and a protected file's password pauses", async () => {
    const before = Date.now(), change = (receipt: { id: string; deleteToken: string }, expiresIn: number) => call(`/api/transfers/${receipt.id}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + receipt.deleteToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn }) });
    const locked = await file(false, PASSWORD);
    for (let attempt = 0; attempt < 5; attempt++) await (await call(pathOf(locked.receipt.url), { headers: basic('guess') }, '198.18.7.60')).text();
    const changed = await change(locked.receipt, 600);
    expect(changed.status).toBe(200);
    const body = await changed.json<{ serverTime: number; minutes: number; owner: boolean; passwordPause: { until: number | null; networks: number; networksUntil: number | null } }>();
    expect(body).toMatchObject({ id: locked.receipt.id, minutes: 10, owner: true, protected: true, name: "report & '旅行'.zip" });
    expect(body.serverTime).toBeGreaterThanOrEqual(before);
    expect(body.serverTime).toBeLessThanOrEqual(Date.now());
    expect(body.passwordPause).toEqual({ until: null, networks: 1, networksUntil: expect.any(Number) });
    expect(body.passwordPause.networksUntil).toBeGreaterThan(body.serverTime);
    // The same as GET answers now.
    const { serverTime: _time, ...view } = body;
    const { serverTime: _now, ...owner } = await (await call(`/api/transfers/${locked.receipt.id}`, { headers: { Authorization: 'Bearer ' + locked.receipt.deleteToken } })).json<typeof body>();
    expect(view).toEqual(owner);
    // An open file has no pauses to show.
    const open = await change((await file()).receipt, 900);
    const plain = await open.json<Record<string, unknown>>();
    expect(plain).toMatchObject({ minutes: 15, owner: true, protected: false, serverTime: expect.any(Number) });
    expect(plain).not.toHaveProperty('passwordPause');
  });

  it('limits public status polls with STATUS_RATE and owner requests with DOWNLOAD_RATE', async () => {
    expect(env.STATUS_RATE).toBeDefined();
    const { receipt } = await file(), path = `/api/transfers/${receipt.id}`, owner = { headers: { Authorization: 'Bearer ' + receipt.deleteToken } };
    const status = limiter(false), downloads = limiter(true);
    const polled = await fetchWith(path, { STATUS_RATE: status, DOWNLOAD_RATE: downloads });
    expect([polled.status, await codeOf(polled)]).toEqual([429, 'rate_limited']);
    expect((await fetchWith(path, { STATUS_RATE: status, DOWNLOAD_RATE: downloads }, owner)).status).toBe(200);
    expect([status.keys, downloads.keys]).toEqual([['198.18.7.251'], ['198.18.7.251']]);
    const busy = limiter(false), idle = limiter(true);
    expect((await fetchWith(path, { STATUS_RATE: idle, DOWNLOAD_RATE: busy })).status).toBe(200);
    expect((await fetchWith(path, { STATUS_RATE: idle, DOWNLOAD_RATE: busy }, owner)).status).toBe(429);
    expect([idle.keys.length, busy.keys.length]).toEqual([1, 1]);
  });
});

describe('operator readiness', () => {
  const ready = async (bindings: Partial<Env>, init: RequestInit = {}) => (await operatorDirect('/api/admin/ready', bindings, { ...init, headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN } })).response;
  type Readiness = {
    ready: boolean; attention: boolean; reasons: string[]; checks: { secrets: Record<string, boolean>; rotation: boolean; r2: boolean; budget: boolean; reports: boolean };
    backlog: { overdueCleanups: number | null };
    capacity: { storedPercent: number | null; dailyPercent: number | null; storedBytes: number | null; maxStoredBytes: number | null };
    openReports: number | null; oldestOpenReportAge: number | null; highestOpenPriority: number | null;
  };
  const MONITOR_TOKEN = 'test-monitor-token-0123456789abcdef';
  // From the file's .251, past ADMIN_RATE's 10 a minute: these calls get a limit of their own.
  const monitored = async (path: string, bindings: Partial<Env> = {}, init: RequestInit = {}, token = MONITOR_TOKEN) =>
    (await operatorDirect(path, { ADMIN_RATE: limiter(true), ...bindings }, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } })).response;

  it('answers 200 when every check passes, with counts only', async () => {
    const response = await operator('/api/admin/ready');
    expect(response.status).toBe(200);
    const body = await response.json<Readiness>();
    expect(body).toEqual({
      ready: true, attention: false, reasons: [], checks: { secrets: { NETWORK_HASH_KEY: true, GRANT_SIGNING_KEY: true, ADMIN_TOKEN: true }, rotation: true, r2: true, budget: true, reports: true },
      turnstile: 'off', e2ee: 'on', paused: false, backlog: { overdueCleanups: 0 }, capacity: { storedPercent: expect.any(Number), dailyPercent: expect.any(Number), storedBytes: expect.any(Number),
        maxStoredBytes: Number(env.MAX_STORED_BYTES) }, openReports: 0, oldestOpenReportAge: null,
      // The local runtime's version metadata has an upload time but no tag (a deploy's is v<package version>).
      highestOpenPriority: null, version: { tag: null, deployedAt: expect.any(String) },
    });
    expect(body.capacity.storedPercent).toBeLessThan(60);
    expect(body.backlog.overdueCleanups === null || Number.isInteger(body.backlog.overdueCleanups)).toBe(true);
    expect((await operatorDirect('/api/admin/ready', {})).response.status).toBe(401);
    expect((await operator('/api/admin/ready', { method: 'POST', body: '{}' })).status).toBe(405);
  });

  it('answers 503 and names the failed check when a secret is missing or a dependency fails', async () => {
    const broken = { getByName: () => ({ status: async () => { throw new Error('down'); }, summary: async () => { throw new Error('down'); } }) };
    const failing: [Partial<Env>, (body: Readiness) => unknown][] = [
      [{ GRANT_SIGNING_KEY: 'short' }, body => body.checks.secrets.GRANT_SIGNING_KEY],
      [{ NETWORK_HASH_KEY: undefined }, body => body.checks.secrets.NETWORK_HASH_KEY],
      // A short network key still hashes, but pseudonymises weakly: readiness reports it as missing.
      [{ NETWORK_HASH_KEY: 'n'.repeat(31) }, body => body.checks.secrets.NETWORK_HASH_KEY],
      // A previous grant key left in place after its hour, or without the rotation time that bounds it.
      [{ GRANT_SIGNING_KEY_PREVIOUS: 'p'.repeat(32), GRANT_SIGNING_KEY_ROTATED_AT: String(Date.now() - 2 * 3600000) }, body => body.checks.rotation],
      [{ GRANT_SIGNING_KEY_PREVIOUS: 'p'.repeat(32) }, body => body.checks.rotation],
      [{ FILES: { head: async () => { throw new Error('R2 unavailable'); } } as unknown as R2Bucket }, body => body.checks.r2],
      [{ BUDGET: broken as unknown as Env['BUDGET'] }, body => body.checks.budget],
      [{ REPORTS: broken as unknown as Env['REPORTS'] }, body => body.checks.reports],
    ];
    for (const [bindings, check] of failing) {
      const response = await ready(bindings);
      expect(response.status, JSON.stringify(Object.keys(bindings))).toBe(503);
      const body = await response.json<Readiness>();
      expect([body.ready, check(body)]).toEqual([false, false]);
    }
    // Within the hour after a rotation the previous key is expected.
    const rotating = await ready({ GRANT_SIGNING_KEY_PREVIOUS: 'p'.repeat(32), GRANT_SIGNING_KEY_ROTATED_AT: String(Date.now() - 600000) });
    expect([rotating.status, (await rotating.json<Readiness>()).checks.rotation]).toEqual([200, true]);
  });

  it('asks for attention apart from health: open reports with the oldest one\'s age and most urgent priority, or overdue cleanups', async () => {
    const counts = (summary: { open: number; oldest: number | null; priority: number | null }, overdueCleanups = 0) => ({
      REPORTS: { getByName: () => ({ summary: async () => ({ ok: true, value: summary }) }) } as unknown as Env['REPORTS'],
      BUDGET: { getByName: () => ({ status: async () => ({ overdueCleanups }) }) } as unknown as Env['BUDGET'],
    });
    const cases: [ReturnType<typeof counts>, Partial<Readiness>][] = [
      [counts({ open: 3, oldest: Date.now() - 3600000, priority: 1 }), { attention: true, reasons: ['open_reports'], openReports: 3, highestOpenPriority: 1, backlog: { overdueCleanups: 0 } }],
      [counts({ open: 0, oldest: null, priority: null }, 2), { attention: true, reasons: ['overdue_cleanups'], openReports: 0, oldestOpenReportAge: null, highestOpenPriority: null, backlog: { overdueCleanups: 2 } }],
      [counts({ open: 0, oldest: null, priority: null }), { attention: false, reasons: [], openReports: 0, oldestOpenReportAge: null, highestOpenPriority: null }],
    ];
    for (const [bindings, expected] of cases) {
      // Still ready: attention is about the operator's queue, not the service's health.
      const response = await monitored('/api/admin/ready', bindings);
      expect(response.status).toBe(200);
      const body = await response.json<Readiness>();
      expect(body).toMatchObject({ ready: true, ...expected });
      if (body.openReports) expect(body.oldestOpenReportAge).toBeGreaterThanOrEqual(3600);
    }
  });

  it('asks for attention when stored or daily bytes reach 60 % of their limits, with both fill levels in percent', async () => {
    const usage = (stored: number, today: number, extra: { open?: number; overdueCleanups?: number } = {}) => ({
      REPORTS: { getByName: () => ({ summary: async () => ({ ok: true, value: { open: extra.open ?? 0, oldest: extra.open ? Date.now() : null, priority: extra.open ? 4 : null } }) }) } as unknown as Env['REPORTS'],
      BUDGET: { getByName: () => ({ status: async () => ({ overdueCleanups: extra.overdueCleanups ?? 0, stored: { bytes: stored, maxBytes: 1000 }, today: { bytes: today, maxBytes: 3000 } }) }) } as unknown as Env['BUDGET'],
    });
    const cases: [ReturnType<typeof usage>, Partial<Readiness>][] = [
      // Just below 60 % counts as below, also where the percentage rounds to 59.
      [usage(599, 1799), { attention: false, reasons: [], capacity: { storedPercent: 59, dailyPercent: 59, storedBytes: 599, maxStoredBytes: 1000 } }],
      [usage(600, 0), { attention: true, reasons: ['storage_60'], capacity: { storedPercent: 60, dailyPercent: 0, storedBytes: 600, maxStoredBytes: 1000 } }],
      [usage(0, 1800), { attention: true, reasons: ['daily_60'], capacity: { storedPercent: 0, dailyPercent: 60, storedBytes: 0, maxStoredBytes: 1000 } }],
      [usage(1000, 3000, { open: 2, overdueCleanups: 1 }), { attention: true, reasons: ['open_reports', 'overdue_cleanups', 'storage_60', 'daily_60'],
        capacity: { storedPercent: 100, dailyPercent: 100, storedBytes: 1000, maxStoredBytes: 1000 } }],
    ];
    for (const [bindings, expected] of cases) {
      const response = await monitored('/api/admin/ready', bindings);
      // Capacity is the operator's concern, not the service's health.
      expect(response.status).toBe(200);
      expect(await response.json<Readiness>()).toMatchObject({ ready: true, ...expected });
    }
    // Without the Budget's numbers there are no fill levels (and the Budget check fails), never a guess.
    const unreadable = await monitored('/api/admin/ready', { BUDGET: { getByName: () => ({ status: async () => { throw new Error('down'); } }) } as unknown as Env['BUDGET'] });
    expect(await unreadable.json<Readiness>()).toMatchObject({ ready: false, reasons: [], capacity: { storedPercent: null, dailyPercent: null, storedBytes: null, maxStoredBytes: null } });
    // The real Budget's numbers: what /api/admin/uploads shows, in percent of each limit, and the stored bytes themselves
    // (the dashboard's "Storage in use").
    const status = await (await operator('/api/admin/uploads')).json<{ stored: { bytes: number; maxBytes: number }; today: { bytes: number; maxBytes: number } }>();
    const live = await (await monitored('/api/admin/ready')).json<Readiness>();
    expect(live.capacity).toEqual({ storedPercent: Math.floor(status.stored.bytes * 100 / status.stored.maxBytes), dailyPercent: Math.floor(status.today.bytes * 100 / status.today.maxBytes),
      storedBytes: status.stored.bytes, maxStoredBytes: status.stored.maxBytes });
  });

  it('opens readiness, and nothing else, to the monitor token', async () => {
    const operatorView = await (await operator('/api/admin/ready')).json<Readiness>();
    const response = await monitored('/api/admin/ready');
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json<Readiness>()).sort()).toEqual(Object.keys(operatorView).sort());
    const { receipt } = await file(), id = JSON.stringify({ id: receipt.id, note: 'monitor tries' });
    for (const [path, init] of [['/api/admin/uploads', {}], ['/api/admin/uploads', { method: 'POST', body: '{"paused":true}' }], ['/api/admin/reports', {}],
      [`/api/admin/transfers/${receipt.id}`, {}], ['/api/admin/takedown', { method: 'POST', body: id }], ['/api/admin/quarantine', { method: 'POST', body: id }],
      ['/api/admin/reconcile', { method: 'POST' }]] as const) {
      const refused = await monitored(path, {}, init);
      expect([refused.status, await codeOf(refused)], path).toEqual([401, 'denied']);
    }
    expect((await call(`/api/transfers/${receipt.id}`)).status).toBe(200);
    // Without ADMIN_TOKEN the monitor still reads readiness, which fails for it; every other route is gone.
    const alone = await monitored('/api/admin/ready', { ADMIN_TOKEN: undefined });
    expect(alone.status).toBe(503);
    expect((await alone.json<Readiness>()).checks.secrets.ADMIN_TOKEN).toBe(false);
    expect((await monitored('/api/admin/uploads', { ADMIN_TOKEN: undefined })).status).toBe(404);
    // A monitor token shorter than 32 characters counts as missing; with no token configured at all readiness is gone too.
    const weak = 'weak-monitor-token';
    expect((await monitored('/api/admin/ready', { MONITOR_TOKEN: weak }, {}, weak)).status).toBe(401);
    expect((await monitored('/api/admin/ready', { ADMIN_TOKEN: undefined, MONITOR_TOKEN: undefined })).status).toBe(404);
  });
});
