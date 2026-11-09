import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sign, randomToken, resumeToken, kind, RISKY, PASSWORD_PAUSE_MS } from '../src/shared';
import {
  call, post, init, part, finish, file, direct, pathOf, pageOf, record, edit, swap, tries, unpause, networkOfClient, useNetworkPrefix, type Receipt,
} from './helpers';
import risky from './vectors/risky.json';

useNetworkPrefix('198.18.6.');

const PASSWORD = 'tide-lamp-41';
const html = { Accept: 'text/html,application/xhtml+xml' };
const basic = (password: string, user = 'fyl') => ({ Authorization: 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(user + ':' + password))) });
/** The download page's password form, as a browser submits it. */
const unlock = (path: string, password: string, from?: string, headers: Record<string, string> = {}) => call(path, {
  method: 'POST', body: new URLSearchParams({ password }).toString(),
  headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at', ...headers },
}, from);
/** A METRICS stand-in that keeps the events written to it. */
const dataset = () => {
  const events: string[] = [];
  return { events, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point?.blobs?.[0]) events.push(String(point.blobs[0])); } } };
};
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

describe('download page', () => {
  it('shows browsers the page for a regular link, and gives curl, ?dl=1 and ranges the file', async () => {
    const { receipt, payload, session } = await file();
    const path = pathOf(receipt.url);
    const response = await call(path, { headers: html });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const { html: page, root, data } = await pageOf(response);
    expect(root).toContain('data-state="ready"');
    expect(root).not.toMatch(/data-once|data-risky|data-protected/);
    expect(data).toEqual({
      state: 'ready', id: receipt.id, name: "report & '旅行'.zip", size: payload.length, type: 'ZIP archive', ext: 'ZIP',
      expiresAt: receipt.expiresAt, once: false, protected: false, risky: false, url: receipt.url, downloadUrl: receipt.url + '?dl=1',
      received: null, updatedAt: null, reason: null, error: null, triesLeft: null, pausedUntil: null, now: expect.any(Number), mode: 'raw', head: null, meta: null,
    });
    expect(page).not.toContain('a real R2 fixture');
    expect((await record(session.uploadId)).downloads).toBe(0);
    // Download tools, the page's button (?dl=1) and range requests get the file.
    for (const [query, headers] of [['', { 'User-Agent': 'curl/8.5.0', Accept: '*/*' }], ['?dl=1', html], ['', {}]] as const) {
      const download = await call(path + query, { headers });
      expect(download.headers.get('Content-Disposition')).toContain('attachment');
      expect(await bytes(download)).toEqual(payload);
    }
    const range = await call(path, { headers: { ...html, Range: 'bytes=2-5' } });
    expect(range.status).toBe(206);
    expect(await bytes(range)).toEqual(payload.slice(2, 6));
    // The name segment is cosmetic: the page for any name shows the link as shared.
    expect((await pageOf(await call(`/d/${receipt.id}/other.bin`, { headers: html }))).data.url).toBe(receipt.url);
  });

  it('flags programs and one-time links, and keeps markup in a name inert', async () => {
    const program = await file(true, undefined, 'setup.exe');
    const { root, data } = await pageOf(await call(pathOf(program.receipt.url), { headers: html }));
    expect(root).toMatch(/data-state="ready"/);
    expect(root).toContain('data-once');
    expect(root).toContain('data-risky');
    expect(data).toMatchObject({ type: 'Windows program', ext: 'EXE', risky: true, once: true });
    expect(await record(program.session.uploadId)).not.toHaveProperty('session');
    const tricky = await file(false, undefined, '<!--<script>x.tar.gz');
    const page = await pageOf(await call(pathOf(tricky.receipt.url), { headers: html }));
    expect(page.html).not.toContain('<!--<script>');
    expect(page.data).toMatchObject({ name: '<!--<script>x.tar.gz', type: 'gzip archive', ext: 'GZ' });
    expect((await pageOf(await call(pathOf((await file(false, undefined, 'README')).receipt.url), { headers: html }))).data)
      .toMatchObject({ type: 'file', ext: 'FILE', risky: false });
  });

  it('warns before every extension of tests/vectors/risky.json, the list it shares with the page (docs/E2EE.md §15.4)', async () => {
    expect([...RISKY].sort()).toEqual([...risky.extensions].sort());
    expect(new Set(risky.extensions).size).toBe(risky.extensions.length);
    // Every listed extension is found in a name, `-ms` ones too, in any case.
    for (const extension of risky.extensions) {
      for (const name of ['file.' + extension, 'FILE.' + extension.toUpperCase()]) expect([name, kind(name).risky]).toEqual([name, true]);
    }
    for (const { name, ...expected } of risky.names) expect([name, kind(name)]).toEqual([name, expected]);
    // A raw file's page says so, before anything is downloaded.
    for (const name of ['Invoice.pdf.html', 'Documents.library-ms']) {
      const { root, data } = await pageOf(await call(pathOf((await file(false, undefined, name)).receipt.url), { headers: html }));
      expect(root).toContain('data-risky');
      expect(data).toMatchObject({ name, risky: true });
    }
  });

  it('shows the reason a link is gone with the status as before', async () => {
    const { receipt } = await file();
    expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
    const deleted = await call(pathOf(receipt.url), { headers: html });
    expect(deleted.status).toBe(410);
    const { root, data } = await pageOf(deleted);
    expect(root).toContain('data-state="gone"');
    expect(data).toMatchObject({ state: 'gone', id: receipt.id, reason: 'deleted', name: null, size: null });
    expect((await call(pathOf(receipt.url))).headers.get('Content-Type')).toContain('application/json');
  });
});

describe('password-protected downloads', () => {
  it('stores only a PBKDF2 hash and keeps the name out of the link, the page and public info', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD);
    expect(session.url).toBe(`https://fyl.at/d/${receipt.id}`);
    expect(receipt).toMatchObject({ url: session.url, name: "report & '旅行'.zip", protected: true });
    const stored = await record(session.uploadId);
    expect(stored).toMatchObject({ pwIter: 100000 });
    expect(stored.pwSalt && atob(stored.pwSalt).length).toBe(16);
    expect(stored.pwHash).toMatch(/^[0-9a-f]{64}$/);
    // PBKDF2-HMAC-SHA-256 of the password with the stored salt, as any implementation computes it.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(atob(String(stored.pwSalt)), c => c.charCodeAt(0)), iterations: 100000 }, key, 256);
    expect([...new Uint8Array(derived)].map(byte => byte.toString(16).padStart(2, '0')).join('')).toBe(stored.pwHash);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    // Public info hides the name; the owner's view keeps it.
    const info = await (await call(`/api/transfers/${receipt.id}`)).json<Record<string, unknown>>();
    expect(info).toMatchObject({ name: null, url: session.url, protected: true, state: 'ready' });
    const owner = await (await call(`/api/transfers/${receipt.id}`, { headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).json<Record<string, unknown>>();
    expect(owner).toMatchObject({ name: "report & '旅行'.zip", protected: true });
    // Browsers get the password page, with no name, type or browser login dialog; bots too.
    for (const headers of [html, { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }]) {
      const response = await call(pathOf(receipt.url), { headers });
      expect(response.status).toBe(200);
      const { html: page, root, data } = await pageOf(response);
      expect(root).toContain('data-protected');
      expect(data).toMatchObject({ state: 'protected', name: null, type: null, ext: null, risky: false, protected: true, url: session.url,
        downloadUrl: null, error: null, triesLeft: 5, pausedUntil: null, size: payload.length });
      expect(page).not.toContain('旅行');
    }
  });

  it('asks curl for the password with Basic Auth and downloads with the right one', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD);
    const path = pathOf(receipt.url), from = '198.18.6.240';
    const missing = await call(path, { headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe('Basic realm="fyl.at", charset="UTF-8"');
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
    expect(await missing.text()).toBe(`This file needs a password. Run: curl -fOJ -u fyl '${receipt.url}'\n`);
    // A browser at ?dl=1 gets the password page, not the challenge (no native login dialog).
    expect((await pageOf(await call(path + '?dl=1', { headers: html }))).data.state).toBe('protected');
    expect((await call(path, { method: 'HEAD' })).status).toBe(401);
    const wrong = await call(path, { headers: basic('wrong-password') }, from);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(await wrong.text()).toBe('Wrong password. 4 tries left.\n');
    expect(await tries(session.uploadId)).toEqual([{ network: await networkOfClient(from, receipt.id), fails: 1, paused_until: 0 }]);
    // The user name is ignored; a right password resets the network's count, for GET, HEAD and ranges alike.
    const right = await call(path, { headers: basic(PASSWORD, 'anyone') }, from);
    expect(right.headers.get('Content-Disposition')).toContain('attachment');
    expect(await bytes(right)).toEqual(payload);
    expect(await tries(session.uploadId)).toEqual([]);
    expect((await call(path, { method: 'HEAD', headers: basic(PASSWORD) })).status).toBe(200);
    const range = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-3' } });
    expect(await bytes(range)).toEqual(payload.slice(0, 4));
    expect((await record(session.uploadId)).downloads).toBe(2);
    // Unreadable credentials count as none.
    expect(await (await call(path, { headers: { Authorization: 'Basic !!!' } })).text()).toContain('This file needs a password.');
  });

  it('pauses a network for 15 minutes after 5 wrong tries, refusing even the right password', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url), metrics = dataset(), from = '198.18.6.241';
    const restore = await swap(env.TRANSFERS.getByName(session.uploadId), () => ({ METRICS: metrics.METRICS }));
    try {
      for (const left of [4, 3, 2]) expect(await (await call(path, { headers: basic('wrong-' + left) }, from)).text()).toBe(`Wrong password. ${left} tries left.\n`);
      expect(await (await call(path, { headers: basic('wrong-1') }, from)).text()).toBe('Wrong password. 1 try left.\n');
      const paused = await call(path, { headers: basic('wrong-0') }, from);
      expect(paused.status).toBe(429);
      expect(paused.headers.has('WWW-Authenticate')).toBe(false);
      expect(Number(paused.headers.get('Retry-After'))).toBeGreaterThan(890);
      expect(await paused.text()).toBe('Too many wrong tries. Try again in 15 minutes.\n');
      expect((await call(path, { headers: basic(PASSWORD) }, from)).status).toBe(429);
      // The page shows the pause too, and its form refuses the right password.
      for (const response of [await call(path, { headers: html }, from), await unlock(path, PASSWORD, from)]) {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(890);
        const { data } = await pageOf(response);
        expect(data).toMatchObject({ state: 'protected', error: 'paused', name: null });
        expect(data.pausedUntil).toBeGreaterThan(Date.now() + PASSWORD_PAUSE_MS - 60000);
      }
      // Recipients on other networks still see the form, with all their tries.
      expect((await pageOf(await call(path, { headers: html }, '198.18.6.242'))).data).toMatchObject({ state: 'protected', error: null, triesLeft: 5 });
      // An open paused page asks without a password whether the pause is still on (download.js): 429 while it is, 401
      // once the sender lifted it, and the question spends no try.
      const probe = () => call(path + '?dl=1', { method: 'HEAD' }, from).then(response => response.status);
      expect(await probe()).toBe(429);
      // After the pause the count starts over.
      await unpause(session.uploadId);
      expect([await probe(), await probe()]).toEqual([401, 401]);
      expect(await (await call(path, { headers: basic('wrong-again') }, from)).text()).toBe('Wrong password. 4 tries left.\n');
      expect(await bytes(await call(path, { headers: basic(PASSWORD) }, from))).toEqual(payload);
    } finally { await restore(); }
    expect(metrics.events).toEqual([...Array(5).fill('password_wrong'), 'password_paused', 'password_wrong', 'password_ok']);
  });

  it('counts a burst of concurrent tries from one network one by one, so it gets no more than 5 guesses', async () => {
    const { receipt, session } = await file(false, PASSWORD), path = pathOf(receipt.url), from = '198.18.6.243';
    const statuses = (await Promise.all(Array.from({ length: 10 }, (_, index) => call(path, { headers: basic('wrong-' + index) }, from)))).map(response => response.status);
    expect(statuses.sort()).toEqual([...Array(4).fill(401), ...Array(6).fill(429)]);
    expect((await call(path, { headers: basic(PASSWORD) }, from)).status).toBe(429);
    expect(await tries(session.uploadId)).toEqual([{ network: await networkOfClient(from, receipt.id), fails: 0, paused_until: expect.any(Number) }]);
    expect((await tries(session.uploadId))[0].paused_until).toBeGreaterThan(Date.now() + PASSWORD_PAUSE_MS - 60000);
    expect(await record(session.uploadId)).not.toHaveProperty('pwPausedUntil');
  });

  it('unlocks with the page form and downloads with the grant it gives', async () => {
    const { receipt, payload } = await file(false, PASSWORD, 'notes.pdf'), path = pathOf(receipt.url);
    const wrong = await unlock(path, 'not-the-password');
    expect(wrong.status).toBe(401);
    expect((await pageOf(wrong)).data).toMatchObject({ state: 'protected', error: 'wrong', triesLeft: 4, name: null, downloadUrl: null });
    const right = await unlock(path, PASSWORD);
    expect(right.status).toBe(200);
    const { root, data } = await pageOf(right);
    expect(root).toContain('data-state="unlocked"');
    expect(data).toMatchObject({ state: 'unlocked', name: 'notes.pdf', type: 'PDF document', ext: 'PDF', protected: true, url: receipt.url, error: null, triesLeft: null });
    expect(data.downloadUrl).toMatch(new RegExp(`^${receipt.url}\\?grant=\\d+\\.[a-zA-Z0-9_-]{43}$`));
    // The page starts the download with a navigation, which asks for HTML: the grant makes it a download.
    const download = await call(pathOf(String(data.downloadUrl)) + new URL(String(data.downloadUrl)).search, { headers: html });
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await bytes(download)).toEqual(payload);
    // The form takes only same-origin, URL-encoded and small posts.
    expect((await unlock(path, PASSWORD, undefined, { Origin: 'https://other.invalid' })).status).toBe(403);
    expect((await unlock(path, PASSWORD, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await unlock(path, PASSWORD, undefined, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await unlock(path, 'x'.repeat(5000))).status).toBe(413);
    // The longest password fits: 200 characters of 4 UTF-8 bytes each.
    expect((await unlock(path, '😀'.repeat(200))).status).toBe(401);
    // Posted to a link without a password, or one that is gone, the form gets that link's page.
    const open = await file(), opened = await unlock(pathOf(open.receipt.url), PASSWORD);
    expect(opened.status).toBe(200);
    expect((await pageOf(opened)).data).toMatchObject({ state: 'ready', name: "report & '旅行'.zip", downloadUrl: open.receipt.url + '?dl=1' });
    expect((await call(`/api/transfers/${open.receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + open.receipt.deleteToken } })).status).toBe(200);
    const gone = await unlock(pathOf(open.receipt.url), PASSWORD);
    expect(gone.status).toBe(410);
    expect((await pageOf(gone)).data).toMatchObject({ state: 'gone', reason: 'deleted' });
  });

  it('refuses forged, foreign and expired grants', async () => {
    const { receipt } = await file(false, PASSWORD), other = await file(false, PASSWORD), path = pathOf(receipt.url);
    const signed = async (id: string, expiry: number, key = String(env.GRANT_SIGNING_KEY)) => `${expiry}.${await sign(key, `fyl-grant:${id}:${expiry}`)}`;
    const soon = Date.now() + 600000;
    expect((await call(path + '?grant=' + await signed(receipt.id, soon))).status).toBe(200);
    for (const grant of [
      await signed(other.receipt.id, soon), await signed(receipt.id, Date.now() - 1000), await signed(receipt.id, Date.now() + 3 * 3600000),
      `${soon}.${(await signed(receipt.id, soon)).split('.')[1].replace(/^./, c => c === 'A' ? 'B' : 'A')}`, `${soon + 1}.${(await signed(receipt.id, soon)).split('.')[1]}`,
      await signed(receipt.id, soon, 'another key'), await signed(receipt.id, soon, String(env.NETWORK_HASH_KEY)),
      await signed(receipt.id, soon, 'fyl-development-signing-key'), 'nonsense',
    ]) {
      const refused = await call(path + '?grant=' + encodeURIComponent(grant));
      expect(refused.status, grant).toBe(401);
      expect(refused.headers.get('WWW-Authenticate')).toContain('Basic');
    }
  });

  it('opens a one-time session for the grant or Basic download like for a plain one', async () => {
    const { receipt, payload, session } = await file(true, PASSWORD), path = pathOf(receipt.url), from = '198.18.6.252';
    // Wrong tries and the page open nothing.
    expect((await call(path, { headers: basic('wrong-password') }, from)).status).toBe(401);
    const { data } = await pageOf(await unlock(path, PASSWORD, from));
    expect(data).toMatchObject({ state: 'unlocked', once: true });
    expect(await record(session.uploadId)).not.toHaveProperty('session');
    const grant = new URL(String(data.downloadUrl)).search;
    const partial = await call(path + grant, { headers: { Range: 'bytes=0-3' } }, from);
    expect(await bytes(partial)).toEqual(payload.slice(0, 4));
    expect((await record(session.uploadId)).session).toBeDefined();
    // Another network can't join the session, with the password or not.
    expect((await call(path, { headers: basic(PASSWORD) }, '198.18.6.253')).status).toBe(410);
    expect((await pageOf(await call(path, { headers: html }, '198.18.6.253'))).data).toMatchObject({ state: 'gone', reason: 'consumed' });
    // The same network resumes with Basic Auth; the whole file closes the link.
    expect(await bytes(await call(path, { headers: basic(PASSWORD) }, from))).toEqual(payload);
    await expect.poll(async () => (await record(session.uploadId)).status).toBe('consumed');
    expect((await call(path + grant, {}, from)).status).toBe(410);
  });

  it('checks passwords at init and keeps idempotent replays to the same password', async () => {
    const invalid = ['12345', 'x'.repeat(201), 'tab\tpassword', 'line\nbreak', 'nul\u0000xxxx', String.fromCharCode(0xd800) + 'xxxxxx', 123456, true];
    for (const password of invalid) {
      const response = await post('/api/upload/init', { filename: 'a.bin', size: 1, password });
      expect(response.status, JSON.stringify(password)).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe('Password must be 6 to 200 characters, without control characters.');
    }
    for (const password of ['123456', '😀'.repeat(200), 'pass word with spaces', null]) {
      const response = await post('/api/upload/init', { filename: 'a.bin', size: 1, password });
      expect(response.status, String(password)).toBe(201);
      expect((await post('/api/upload/abort', await response.json())).status).toBe(200);
    }
    const clientKey = randomToken(), key = crypto.randomUUID().replaceAll('-', '');
    const metadata = { filename: 'stable.txt', size: 1, clientKey, password: PASSWORD };
    const first = await post('/api/upload/init', metadata, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const session = await first.json<{ uploadId: string; url: string }>();
    expect(session.url).toBe(`https://fyl.at/d/${session.uploadId}`);
    expect(await (await post('/api/upload/init', metadata, { 'Idempotency-Key': key })).json()).toEqual(session);
    expect((await post('/api/upload/init', { ...metadata, password: 'another-password' }, { 'Idempotency-Key': key })).status).toBe(409);
    expect((await post('/api/upload/init', { ...metadata, password: undefined }, { 'Idempotency-Key': key })).status).toBe(409);
    // NFC and NFD spellings of a password are the same password, counted in NFC.
    expect((await post('/api/upload/init', { ...metadata, password: 'café-lamp-41'.normalize('NFD') }, { 'Idempotency-Key': key + 'x' })).status).toBe(201);
    expect((await post('/api/upload/init', { ...metadata, password: 'café-lamp-41'.normalize('NFC') }, { 'Idempotency-Key': key + 'x' })).status).toBe(201);
    const longest = 'é'.repeat(200), { receipt, payload } = await file(false, longest);
    expect(await bytes(await call(pathOf(receipt.url), { headers: basic(longest.normalize('NFD')) }))).toEqual(payload);
  });

  it('drops the password hash when the transfer is cleaned up', async () => {
    const { receipt, session } = await file(false, PASSWORD);
    expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
    const stored = await record(session.uploadId);
    expect(stored.clean).toBe(true);
    for (const field of ['pwSalt', 'pwHash', 'pwIter', 'pwPausedUntil']) expect(stored).not.toHaveProperty(field);
    expect((await call(pathOf(receipt.url), { headers: basic(PASSWORD) })).status).toBe(410);
  });
});

describe('links shared while the upload is still running', () => {
  it('shows the progress, makes curl retry and switches to the file once it is complete', async () => {
    const payload = new TextEncoder().encode('early link fixture'), session = await init(payload.length, false, 'early.zip');
    expect(session.url).toBe(`https://fyl.at/d/${session.uploadId}/early.zip`);
    const path = pathOf(session.url), metrics = dataset();
    const page = await direct(path, metrics, { headers: html });
    expect(page.response.status).toBe(200);
    const { root, data } = await pageOf(page.response);
    expect(root).toContain('data-state="uploading"');
    expect(data).toMatchObject({ state: 'uploading', name: 'early.zip', size: payload.length, received: 0, expiresAt: null,
      url: session.url, downloadUrl: session.url + '?dl=1', once: false, protected: false });
    expect(data.updatedAt).toBe((await record(session.uploadId)).createdAt);
    // curl (and HEAD) get 503 with Retry-After, which curl --retry waits for.
    const waiting = await direct(path, metrics, { headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' } });
    expect(waiting.response.status).toBe(503);
    expect(waiting.response.headers.get('Retry-After')).toBe('10');
    expect(await waiting.response.json()).toEqual({ error: 'Still uploading, 0 % done. curl --retry waits until it’s ready.', code: 'uploading', received: 0, size: payload.length });
    expect((await call(path, { method: 'HEAD' })).status).toBe(503);
    // The waiting page counts as a page view too (statistics); curl's wait doesn't.
    expect(metrics.events).toEqual(['early_wait', 'page_view', 'early_wait']);
    // Recipients poll the public info for the progress.
    const before = Date.now(), parts = [await part(session, payload)];
    const progress = await (await call(`/api/transfers/${session.uploadId}`)).json<Record<string, number>>();
    expect(progress).toEqual({ id: session.uploadId, state: 'uploading', size: payload.length, received: payload.length,
      updatedAt: progress.updatedAt, once: false, protected: false, name: 'early.zip', expiresAt: null, mode: 'raw', serverTime: expect.any(Number) });
    expect(progress.updatedAt).toBeGreaterThanOrEqual(before);
    expect((await (await call(`/api/transfers/${session.uploadId}`)).json<{ received: number }>()).received).toBe(payload.length);
    expect((await call(path, {})).status).toBe(503);
    // Its sender sees it as well, with the progress, so a client can show an upload still running (and delete it).
    const owned = await call(`/api/transfers/${session.uploadId}`, { headers: { Authorization: 'Bearer ' + session.key } });
    expect([owned.status, await owned.json()]).toEqual([200, { id: session.uploadId, name: 'early.zip', size: payload.length, createdAt: expect.any(Number),
      expiresAt: null, minutes: 1440, once: false, downloads: 0, state: 'uploading', protected: false, mode: 'raw', url: session.url, received: payload.length,
      updatedAt: progress.updatedAt, owner: true, serverTime: expect.any(Number) }]);
    const receipt: Receipt = await finish(session, parts);
    expect(receipt.url).toBe(session.url);
    expect(await bytes(await call(path, {}))).toEqual(payload);
    expect((await pageOf(await call(path, { headers: html }))).data.state).toBe('ready');
  });

  it('keeps a protected upload in progress anonymous and answers curl with 503 before asking for the password', async () => {
    const session = await init(10, true, 'secret-plans.zip', PASSWORD);
    expect(session.url).toBe(`https://fyl.at/d/${session.uploadId}`);
    const path = pathOf(session.url);
    const { html: page, data } = await pageOf(await call(path, { headers: html }));
    expect(data).toMatchObject({ state: 'uploading', name: null, type: null, ext: null, protected: true, once: true, downloadUrl: null, received: 0 });
    expect(page).not.toContain('secret-plans');
    expect((await call(path, {})).status).toBe(503);
    expect((await call(path, { headers: basic(PASSWORD) })).status).toBe(503);
    // The form posted early shows the same.
    expect((await pageOf(await unlock(path, PASSWORD))).data.state).toBe('uploading');
    expect(await (await call(`/api/transfers/${session.uploadId}`)).json()).toMatchObject({ state: 'uploading', name: null, protected: true, once: true });
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('shows the sender a protected upload still running with its name, so `fyl rm` can look it up and delete it', async () => {
    const session = await init(10, false, 'secret plan.zip', PASSWORD), path = `/api/transfers/${session.uploadId}`;
    const owner = { Authorization: 'Bearer ' + session.key };
    const info = await (await call(path, { headers: owner })).json<Record<string, unknown>>();
    expect(info).toMatchObject({ state: 'uploading', name: 'secret plan.zip', protected: true, owner: true, received: 0, expiresAt: null, url: session.url });
    expect(info).not.toHaveProperty('passwordPause');
    // The resume token continues the upload but is no management key; a wrong key gets nothing either.
    for (const key of [await resumeToken(session.key), randomToken()]) {
      const refused = await call(path, { headers: { Authorization: 'Bearer ' + key } });
      expect([refused.status, (await refused.json<{ code: string }>()).code]).toEqual([403, 'denied']);
    }
    expect((await call(path, { method: 'DELETE', headers: owner })).status).toBe(200);
    const gone = await call(path, { headers: owner });
    expect([gone.status, (await gone.json<{ code: string }>()).code]).toEqual([410, 'deleted']);
  });

  it('treats an upload past its 24-hour window as gone', async () => {
    const session = await init(10, false, 'late.bin');
    await edit(session.uploadId, stored => { stored.uploadDeadline = Date.now() - 1; });
    expect((await call(`/api/transfers/${session.uploadId}`)).status).toBe(410);
    expect((await call(pathOf(session.url))).status).toBe(410);
    expect((await pageOf(await call(pathOf(session.url), { headers: html }))).data).toMatchObject({ state: 'gone', reason: 'missing' });
  });
});

describe('browser navigations to download addresses', () => {
  it('get pages instead of a Basic Auth challenge, a 503 or JSON errors', async () => {
    // A protected file opened at ?dl=1 or with an expired grant: the password page, never the browser's dialog.
    const locked = await file(false, PASSWORD);
    const path = pathOf(locked.receipt.url);
    for (const address of [path + '?dl=1', path + '?grant=1.forged']) {
      const response = await call(address, { headers: html });
      expect(response.status).toBe(200);
      expect((await pageOf(response)).data).toMatchObject({ state: 'protected', name: null });
    }
    // curl still gets the challenge.
    expect((await call(path + '?dl=1')).headers.get('WWW-Authenticate')).toContain('Basic');
    // A used-up one-time link opened at ?dl=1: the gone page with its reason, keeping the 410.
    const once = await file(true);
    const used = pathOf(once.receipt.url);
    expect((await call(used, {}, '198.18.6.251')).status).toBe(200);
    await expect.poll(async () => (await call(used, { method: 'HEAD' }, '198.18.6.251')).status).toBe(410);
    const response = await call(used + '?dl=1', { headers: html }, '198.18.6.252');
    expect(response.status).toBe(410);
    expect((await pageOf(response)).data).toMatchObject({ state: 'gone', reason: 'consumed' });
  });

  it('put the state block after <meta charset> and give the button its address without JavaScript', async () => {
    const { receipt } = await file();
    const { html: page } = await pageOf(await call(pathOf(receipt.url), { headers: html }));
    expect(page.indexOf('<meta charset')).toBeLessThan(page.indexOf('id="fyl-state"'));
    expect(page).toMatch(new RegExp(`id="download"[^>]*href="${receipt.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?dl=1"`));
  });

  it('says of the key no more than docs/E2EE.md §1 claims: a key sent after %23 did reach fyl.at', async () => {
    const { receipt } = await file();
    const page = (await pageOf(await call(pathOf(receipt.url), { headers: html }))).html;
    expect(page).toContain('<p class="meta" id="key-note">The key is the part of the link after #, which browsers don’t send to fyl.at.</p>');
    expect(page).not.toMatch(/never reaches fyl\.at/);
  });
});

describe('the unlock form in real browsers', () => {
  it('accepts Origin: null from the same site and refuses it otherwise', async () => {
    const { receipt } = await file(false, PASSWORD);
    const path = pathOf(receipt.url);
    // With Referrer-Policy: no-referrer browsers send Origin: null on form posts; Sec-Fetch-Site vouches for them.
    const ok = await unlock(path, PASSWORD, undefined, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect((await pageOf(ok)).data.state).toBe('unlocked');
    const refused: Record<string, string>[] = [{ Origin: 'null' }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'same-site' }];
    for (const headers of refused)
      expect((await unlock(path, PASSWORD, undefined, headers)).status).toBe(403);
  });

  it('sets a same-origin referrer policy on the page so the form sends its real origin', async () => {
    const { receipt } = await file();
    expect((await pageOf(await call(pathOf(receipt.url), { headers: html }))).html).toContain('<meta name="referrer" content="same-origin">');
  });

  it('loads what <head> asks for before any script runs without a Referer, which could carry a key sent after %23', async () => {
    // docs/E2EE.md §2.2, §15.3; download.js turns the page's own policy to no-referrer on an encrypted page.
    const { receipt } = await file();
    const head = (await pageOf(await call(pathOf(receipt.url), { headers: html }))).html.split('</head>')[0];
    const loads = head.match(/<(?:link|script)\b[^>]*\b(?:href|src)="[^"]*"[^>]*>/g) ?? [];
    expect(loads.length).toBe(10); // eight loads (the touch icon among them), plus the llms.txt describedby and alternate links
    expect(loads.filter(tag => !tag.includes(' referrerpolicy="no-referrer"'))).toEqual([]);
  });
});
