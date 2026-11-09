import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { randomToken, unwrap } from '../src/shared';
import { PRIORITY, reports } from '../src/reports';
import { call, post, init, part, finish, file, direct, pathOf, pageOf, record, edit, swap, tries, operator, operatorDirect, useNetworkPrefix, OPERATOR_TOKEN, type Receipt } from './helpers';

useNetworkPrefix('198.18.8.');

const PASSWORD = 'tide-lamp-41';
const html = { Accept: 'text/html,application/xhtml+xml' };
const basic = (password: string) => ({ Authorization: 'Basic ' + btoa('fyl:' + password) });
const codeOf = async (response: Response) => (await response.json<{ code: string }>()).code;
const report = (data: unknown, headers: Record<string, string> = {}) => call('/api/reports', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data),
});
const complete = (link: unknown, extra: Record<string, unknown> = {}) => ({
  link, category: 'malware', details: 'The archive contains a password stealer.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true, ...extra,
});
/** Reports a link and returns its case id. */
async function opened(link: string, extra: Record<string, unknown> = {}) {
  const response = await report(complete(link, extra));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json<{ case: string }>()).case;
}
interface Event { at: number; action: string; note: string }
interface Case {
  case: string; createdAt: number; transferId: string; category: string; details: string; name: string | null; email: string | null; network: string;
  status: string; outcome: string | null; closedAt: number | null; priority: number; fileAvailable: boolean; events: Event[];
}
interface View { id: string; exists: boolean; status: string | null; name: string | null; protected: boolean | null; quarantine: { at: number; note: string } | null; clean: boolean | null; openReports: number | null; openCases: string[] | null; reportsUpdated?: boolean }
interface Page { reports: Case[]; next: string | null }
type Decided = Case & { transfer: { status: string | null; quarantine: { at: number; note: string } | null } | null };
async function admin<T>(path: string, init: RequestInit = {}, status = 200) {
  const response = await operator(path, init);
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json<T>();
}
const decide = (id: string, action: string, note?: string, status = 200) => admin<Decided>(`/api/admin/reports/${id}`, { method: 'POST', body: JSON.stringify({ action, note }) }, status);
/** Calls the Worker as the operator with some bindings replaced. */
const operatorWith = (path: string, bindings: Partial<Env>, init: RequestInit = {}) =>
  operatorDirect(path, bindings, { ...init, headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN, 'Content-Type': 'application/json', ...init.headers } }).then(({ response }) => response);
const quarantine = (id: string, note = 'reviewing a report') => admin<View>('/api/admin/quarantine', { method: 'POST', body: JSON.stringify({ id, note }) });
/** Every open case, page by page, in the order of the queue. */
async function queue(limit = 5) {
  const seen: Case[] = [];
  for (let next: string | null = '', pages = 0; next !== null && pages < 100; pages++) {
    const page: Page = await admin<Page>(`/api/admin/reports?status=open&limit=${limit}${next ? '&after=' + next : ''}`);
    seen.push(...page.reports);
    next = page.next;
  }
  return seen;
}
/** The queue's order: the most urgent priority first, then the oldest case. */
const queued = (a: Case, b: Case) => a.priority - b.priority || a.createdAt - b.createdAt || (a.case < b.case ? -1 : 1);
const owner = (receipt: Receipt, init: RequestInit = {}) => call(`/api/transfers/${receipt.id}`, { ...init, headers: { Authorization: 'Bearer ' + receipt.deleteToken, 'Content-Type': 'application/json' } });
const dataset = () => {
  const events: string[] = [];
  return { events, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point?.blobs) events.push(point.blobs.filter(Boolean).join(':')); } } };
};

describe('POST /api/reports', () => {
  it('takes a download link in each of its forms, or the bare id, and nothing else', async () => {
    const { receipt } = await file(), id = receipt.id;
    for (const link of [receipt.url, `https://fyl.at/d/${id}`, receipt.url + '?dl=1', `${receipt.url}?grant=${Date.now()}.${'a'.repeat(43)}`, id,
      `  ${receipt.url}\n`, `https://fyl.at/d/${id}/another name.zip`]) {
      expect(await opened(link), link).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{10}$/);
    }
    for (const link of [`https://evil.example/d/${id}`, `http://fyl.at/d/${id}`, `https://fyl.at.evil.example/d/${id}`, `https://fyl.at@evil.example/d/${id}`,
      `https://fyl.at/#manage/${id}/${receipt.deleteToken}`, `https://fyl.at/d/${id}#key`, `https://fyl.at/d/${id}?x=1`, `https://fyl.at/d/${id}?dl=1&grant=1.x`,
      `${id}!`, id + 'x'.repeat(30), `https://fyl.at/d/${id}x!/`, 'https://fyl.at/d/short', `https://fyl.at/api/transfers/${id}`, '', 42, null]) {
      const response = await report(complete(link));
      expect([response.status, await codeOf(response)], String(link)).toEqual([400, 'invalid_link']);
    }
  });

  it('never files a case against another transfer than the link opens: links a browser would resolve differently are refused', async () => {
    const innocent = (await file()).receipt, served = (await file()).receipt;
    // A browser opens the second transfer for each of these; the first id in the text must not take the case.
    for (const link of [`https://fyl.at/d/${innocent.id}/../${served.id}`, `https://fyl.at/d/${innocent.id}/%2e%2e/${served.id}`,
      `https://fyl.at/d/${innocent.id}/.%2E/${served.id}`, `https://fyl.at/d/${innocent.id}/x/../../${served.id}`,
      `https://fyl.at/d/${innocent.id}/x\\..\\..\\${served.id}`, `https://fyl.at/d/${innocent.id}/./name.zip`, `https://fyl.at/d/${innocent.id}/na\tme.zip`]) {
      expect(new URL(link).pathname.split('/')[2], link).not.toBe('x');
      const response = await report(complete(link));
      expect([response.status, await codeOf(response)], link).toEqual([400, 'invalid_link']);
    }
    // The host as a browser reads it: another case, an explicit default port.
    const id = await opened(`https://FYL.at:443/d/${served.id}/name.zip?dl=1`);
    expect((await admin<Case>(`/api/admin/reports/${id}`)).transferId).toBe(served.id);
    expect((await admin<View>(`/api/admin/transfers/${innocent.id}`)).openReports).toBe(0);
  });

  it('limits the cases one network files a day, counting the /64s of an IPv6 /56 as one network', async () => {
    const { receipt } = await file(), restore = await swap(reports(env), () => ({ MAX_DAILY_REPORTS_PER_NETWORK: '2' }) as unknown as Partial<Env>);
    const from = (address: string) => call('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(complete(receipt.url)) }, address);
    try {
      for (const address of ['2001:db8:5:4401::1', '2001:db8:5:44ee::2']) expect((await from(address)).status).toBe(201);
      for (const address of ['2001:db8:5:44ff::3', '2001:db8:5:4401::4']) {
        const refused = await from(address);
        expect([refused.status, await refused.json()]).toEqual([429, { error: 'This network has sent too many reports today. Please try again tomorrow.', code: 'report_limit' }]);
      }
      expect((await from('2001:db8:5:4501::1')).status).toBe(201);
    } finally { await restore(); }
  });

  it('checks every field, asks contact details unless it is about CSAM, and needs the good-faith statement', async () => {
    const { receipt } = await file(), link = receipt.url;
    const refused: [Record<string, unknown>, string][] = [
      [{ category: 'spam' }, 'invalid_category'], [{ category: undefined }, 'invalid_category'],
      [{ details: 'Too short to judge.' }, 'invalid_details'], [{ details: 'x'.repeat(4001) }, 'invalid_details'],
      [{ details: 'Twenty characters, then a bell \u0007.' }, 'invalid_details'], [{ details: ' '.repeat(30) }, 'invalid_details'], [{ details: 42 }, 'invalid_details'],
      [{ name: undefined }, 'invalid_name'], [{ name: ' ' }, 'invalid_name'], [{ name: 'n'.repeat(201) }, 'invalid_name'], [{ name: 'Ada\nReporter' }, 'invalid_name'],
      [{ email: undefined }, 'invalid_email'], [{ email: 'not-an-address' }, 'invalid_email'], [{ email: 'a@b.c'.padStart(255, 'a') }, 'invalid_email'],
      [{ category: 'csam', name: undefined, email: 'broken@' }, 'invalid_email'],
      [{ goodFaith: undefined }, 'good_faith_required'], [{ goodFaith: false }, 'good_faith_required'], [{ goodFaith: 'true' }, 'good_faith_required'],
    ];
    for (const [change, code] of refused) {
      const response = await report(complete(link, change));
      expect([response.status, await codeOf(response)], JSON.stringify(change)).toEqual([400, code]);
    }
    // Line breaks, tabs and a pasted CRLF are text; 4000 characters fit; CSAM reports need no name or email.
    for (const change of [{ details: 'Line one\r\nline two\twith a tab.' }, { details: 'é'.repeat(4000) },
      { category: 'csam', name: undefined, email: undefined }, { category: 'copyright', name: '', email: null }]) {
      const response = await report(complete(link, change));
      expect(response.status, JSON.stringify(change).slice(0, 80)).toBe(change.category === 'copyright' ? 400 : 201);
      await response.text();
    }
    expect((await report('x'.repeat(16385))).status).toBe(413);
    expect((await report(complete(link), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await report(complete(link), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/reports')).status).toBe(405);
  });

  it('takes reports about a file closed within its 7-day tombstone, open for the operator with fileAvailable false, and refuses ids nothing is known of', async () => {
    const missing = await report(complete(randomToken()));
    expect([missing.status, await codeOf(missing)]).toEqual([404, 'not_found']);
    // A one-time link used up: its recipient can still report it, CSAM without contact details too.
    const used = await file(true);
    expect(new Uint8Array(await (await call(pathOf(used.receipt.url))).arrayBuffer())).toEqual(used.payload);
    expect((await call(pathOf(used.receipt.url))).status).toBe(410);
    const sent = await report(complete(used.receipt.url, { category: 'csam', name: undefined, email: undefined }));
    expect(sent.status).toBe(201);
    const filed = await sent.json<{ case: string; received: number; fileAvailable: boolean }>();
    expect(filed).toEqual({ case: expect.stringMatching(/^R-/), received: expect.any(Number), fileAvailable: false });
    // Reading it, the list and the transfer view leave it open: the operator decides it.
    expect(await admin<Case>(`/api/admin/reports/${filed.case}`)).toMatchObject({ status: 'open', fileAvailable: false, priority: 1, transferId: used.receipt.id });
    expect((await admin<Page>(`/api/admin/reports?status=open&transfer=${used.receipt.id}`)).reports.map(entry => entry.case)).toEqual([filed.case]);
    expect(await admin<View>(`/api/admin/transfers/${used.receipt.id}`)).toMatchObject({ status: 'consumed', openReports: 1, openCases: [filed.case] });
    expect((await admin<Case>(`/api/admin/reports/${filed.case}`)).status).toBe('open');
    // Taking the transfer down decides it: the next read closes the case as removed.
    expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: used.receipt.id, note: 'csam confirmed' }) })).status).toBe(200);
    expect(await admin<Case>(`/api/admin/reports/${filed.case}`)).toMatchObject({ status: 'closed', outcome: 'removed', fileAvailable: false });
    // A deleted file the same; the operator's decision closes it.
    const deleted = await file();
    expect((await owner(deleted.receipt, { method: 'DELETE' })).status).toBe(200);
    const late = await opened(deleted.receipt.url);
    expect((await admin<Case>(`/api/admin/reports/${late}`)).fileAvailable).toBe(false);
    expect(await decide(late, 'reject', 'nothing left to review')).toMatchObject({ status: 'closed', outcome: 'rejected', transfer: { status: 'deleted', quarantine: null } });
    // A file taken down is decided already: the case is kept, closed as removed.
    const removed = await file();
    expect((await operator('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: removed.receipt.id, note: 'malware' }) })).status).toBe(200);
    const again = await admin<Case>(`/api/admin/reports/${await opened(removed.receipt.url)}`);
    expect(again).toMatchObject({ status: 'closed', outcome: 'removed', fileAvailable: false });
    expect(again.events.map(event => event.action)).toEqual(['received', 'removed']);
    // Once the tombstone is purged, nothing is known of the id any more.
    const purged = await file(), stub = env.TRANSFERS.getByName(purged.receipt.id);
    expect((await owner(purged.receipt, { method: 'DELETE' })).status).toBe(200);
    await edit(purged.receipt.id, stored => { stored.purgeAt = Date.now() - 1; delete stored.verifyAt; });
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const unknown = await report(complete(purged.receipt.url));
    expect([unknown.status, await codeOf(unknown)]).toEqual([404, 'not_found']);
    // A link still uploading can be reported: it already works.
    const uploading = await init(10, false, 'early.bin');
    expect((await admin<Case>(`/api/admin/reports/${await opened(uploading.url)}`)).fileAvailable).toBe(true);
    expect((await post('/api/upload/abort', uploading)).status).toBe(200);
  });

  it('stores the transfer id and a network hash, never the link or the address, counts the category and has its own rate limit', async () => {
    const { receipt } = await file(), metrics = dataset();
    const grant = `${Date.now()}.${'g'.repeat(43)}`;
    const sent = await direct('/api/reports', metrics, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(complete(`${receipt.url}?grant=${grant}`, { category: 'phishing' })) });
    expect(sent.response.status).toBe(201);
    const { case: id, received } = await sent.response.json<{ case: string; received: number }>();
    expect(received).toBeLessThanOrEqual(Date.now());
    expect(metrics.events).toEqual(['report_received:phishing']);
    const stored = await admin<Case>(`/api/admin/reports/${id}`);
    expect(stored).toMatchObject({ case: id, transferId: receipt.id, category: 'phishing', name: 'Ada Reporter', email: 'ada@example.org', status: 'open', outcome: null });
    expect(stored.network).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toMatch(new RegExp(`${grant}|198\\.18\\.8\\.|https://`));
    const keys: string[] = [];
    const limited = await direct('/api/reports', { REPORT_RATE: { limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success: false }; } } },
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(complete(receipt.url)) });
    expect([limited.response.status, await codeOf(limited.response), keys]).toEqual([429, 'rate_limited', ['198.18.8.251']]);
  });
});

describe('quarantine', () => {
  it('closes every way to the file while a report is reviewed, and restore opens it again', async () => {
    const { receipt, payload, session } = await file(false, PASSWORD), path = pathOf(receipt.url);
    // A grant from before the quarantine.
    const unlocked = await call(path, { method: 'POST', body: 'password=' + PASSWORD, headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } });
    const grant = new URL(String((await pageOf(unlocked)).data.downloadUrl)).search;
    const view = await quarantine(receipt.id, 'checking a report');
    expect(view).toMatchObject({ id: receipt.id, exists: true, status: 'ready', name: "report & '旅行'.zip", protected: true, clean: false, openReports: 0 });
    expect(view.quarantine).toEqual({ at: expect.any(Number), note: 'checking a report' });
    const blocked: [string, RequestInit][] = [
      [path, { headers: basic(PASSWORD) }], [path, { method: 'HEAD', headers: basic(PASSWORD) }], [path + grant, {}], [path + '?dl=1', {}],
      [path, { headers: basic('a-wrong-guess') }], [`/api/transfers/${receipt.id}`, {}],
      [`/api/transfers/${receipt.id}`, { headers: { Authorization: 'Bearer ' + receipt.deleteToken } }],
      [`/api/transfers/${receipt.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + receipt.deleteToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) }],
    ];
    for (const [address, request] of blocked) {
      const response = await call(address, request);
      expect(response.status, address + ' ' + (request.method || 'GET')).toBe(403);
      if (request.method !== 'HEAD') expect(await codeOf(response)).toBe('quarantined');
    }
    // Browsers get the page with the reason, for the link, the form and the download button alike.
    for (const response of [await call(path, { headers: html }), await call(path + grant, { headers: html }),
      await call(path, { method: 'POST', body: 'password=' + PASSWORD, headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } })]) {
      expect(response.status).toBe(403);
      expect((await pageOf(response)).data).toMatchObject({ state: 'gone', reason: 'quarantined', name: null });
    }
    expect(await tries(session.uploadId)).toEqual([]);
    // Restored: everything works again, the grant too.
    const restored = await admin<View>('/api/admin/restore', { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'false alarm' }) });
    expect(restored.quarantine).toBeNull();
    expect(new Uint8Array(await (await call(path + grant)).arrayBuffer())).toEqual(payload);
    expect((await call(`/api/transfers/${receipt.id}`)).status).toBe(200);
    expect((await operator('/api/admin/restore', { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'once more' }) })).status).toBe(409);
  });

  it('lets the sender delete or abort, lets the upload finish, and never outlasts the transfer', async () => {
    const live = await file();
    await quarantine(live.receipt.id);
    expect((await owner(live.receipt, { method: 'DELETE' })).status).toBe(200);
    const deleted = await call(pathOf(live.receipt.url));
    expect([deleted.status, await codeOf(deleted)]).toEqual([410, 'deleted']);
    expect((await operator('/api/admin/quarantine', { method: 'POST', body: JSON.stringify({ id: live.receipt.id, note: 'too late' }) })).status).toBe(409);
    // An upload still running: the page says why, the upload completes, the file stays closed until restored.
    const payload = new TextEncoder().encode('reported mid-upload'), session = await init(payload.length, false, 'mid.bin');
    await quarantine(session.uploadId, 'reported early');
    const early = await call(pathOf(session.url), { headers: html });
    expect([early.status, (await pageOf(early)).data.reason]).toEqual([403, 'quarantined']);
    expect((await call(`/api/transfers/${session.uploadId}`)).status).toBe(403);
    const receipt = await finish(session, [await part(session, payload)]);
    expect(receipt.url).toBe(session.url);
    const closed = await call(pathOf(receipt.url));
    expect([closed.status, await codeOf(closed)]).toEqual([403, 'quarantined']);
    // Expiry goes on: a quarantined file that expires shows that it expired.
    await edit(session.uploadId, stored => { stored.expiresAt = Date.now() - 1; });
    const expired = await call(pathOf(receipt.url));
    expect([expired.status, await codeOf(expired)]).toEqual([410, 'expired']);
    const aborted = await init(5, false, 'abort.bin');
    await quarantine(aborted.uploadId);
    expect((await post('/api/upload/abort', aborted)).status).toBe(200);
  });

  it('refuses to reject the last open case on a quarantined file: restore or remove decides the quarantine', async () => {
    const { receipt, payload } = await file();
    const first = await opened(receipt.url), second = await opened(receipt.url);
    expect((await decide(first, 'quarantine', 'checking')).transfer).toEqual({ status: 'ready', quarantine: { at: expect.any(Number), note: 'checking' } });
    // Another open case still justifies the quarantine: that one can be rejected, and the answer shows the file stays blocked.
    const rejected = await decide(second, 'reject', 'duplicate');
    expect(rejected).toMatchObject({ status: 'closed', outcome: 'rejected', transfer: { status: 'ready', quarantine: { note: 'checking' } } });
    const refused = await operator(`/api/admin/reports/${first}`, { method: 'POST', body: JSON.stringify({ action: 'reject', note: 'unfounded' }) });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'This file is quarantined. Decide restore to lift the quarantine, or remove to take the file down.', code: 'quarantined' }]);
    expect((await admin<Case>(`/api/admin/reports/${first}`)).status).toBe('open');
    expect((await call(pathOf(receipt.url))).status).toBe(403);
    // Restore ends both: the case closes as restored, and the file downloads again.
    expect(await decide(first, 'restore', 'unfounded')).toMatchObject({ status: 'closed', outcome: 'restored', transfer: { status: 'ready', quarantine: null } });
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
    // A quarantine set directly is guarded the same way.
    const direct = await file(), only = await opened(direct.receipt.url);
    await quarantine(direct.receipt.id, 'direct');
    await decide(only, 'reject', 'unfounded', 409);
    expect((await decide(only, 'remove', 'confirmed')).transfer).toEqual({ status: 'removed', quarantine: null });
  });

  it('keeps a takedown after a quarantine final', async () => {
    const { receipt, session } = await file();
    const id = await opened(receipt.url);
    await decide(id, 'quarantine', 'looks like malware');
    const removed = await decide(id, 'remove', 'confirmed');
    expect(removed).toMatchObject({ status: 'closed', outcome: 'removed' });
    expect((await record(session.uploadId)).status).toBe('removed');
    const gone = await call(pathOf(receipt.url));
    expect([gone.status, await codeOf(gone)]).toEqual([410, 'removed']);
    expect((await pageOf(await call(pathOf(receipt.url), { headers: html }))).data.reason).toBe('removed');
    for (const route of ['/api/admin/restore', '/api/admin/quarantine'])
      expect((await operator(route, { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'after the takedown' }) })).status).toBe(409);
    expect((await admin<View>(`/api/admin/transfers/${receipt.id}`)).status).toBe('removed');
  });
});

describe('operator reports', () => {
  it('lists, shows and decides cases, recording every step', async () => {
    const { receipt, payload, session } = await file(), metrics = dataset();
    const restore = await swap(reports(env), () => ({ METRICS: metrics.METRICS }));
    try {
      const id = await opened(receipt.url, { category: 'illegal' });
      const open = await admin<{ reports: Case[] }>('/api/admin/reports?status=open&limit=200');
      expect(open.reports.find(entry => entry.case === id)).toMatchObject({ transferId: receipt.id, category: 'illegal', status: 'open', priority: 3, fileAvailable: true });
      expect(open.reports).toEqual([...open.reports].sort(queued));
      expect((await admin<View>(`/api/admin/transfers/${receipt.id}`)).openReports).toBe(1);
      const quarantined = await decide(id, 'quarantine', 'checking');
      expect(quarantined).toMatchObject({ status: 'open', outcome: null });
      expect((await call(pathOf(receipt.url))).status).toBe(403);
      await decide(id, 'note', 'asked the sender');
      const restored = await decide(id, 'restore', 'lawful');
      expect(restored).toMatchObject({ status: 'closed', outcome: 'restored', closedAt: expect.any(Number) });
      expect(restored.events.map(({ action, note }) => [action, note])).toEqual([['received', ''], ['quarantine', 'checking'], ['note', 'asked the sender'], ['restore', 'lawful']]);
      expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
      // A closed case takes notes, no other decision.
      await decide(id, 'reject', 'decided twice', 409);
      expect((await decide(id, 'note', 'sender confirmed')).events).toHaveLength(5);
      expect((await admin<{ reports: Case[] }>('/api/admin/reports?status=closed&limit=200')).reports.some(entry => entry.case === id)).toBe(true);
      // Rejected: the file stays as it is.
      const rejected = await decide(await opened(receipt.url), 'reject', 'not a violation');
      expect(rejected).toMatchObject({ status: 'closed', outcome: 'rejected' });
      expect((await record(session.uploadId)).status).toBe('ready');
    } finally { await restore(); }
    expect(metrics.events).toEqual(['quarantine', 'restore']);
  });

  it('notes direct quarantines in the open cases of the transfer, and closes cases lazily once the transfer is gone', async () => {
    const expiring = await file(), takenDown = await file();
    const first = await opened(expiring.receipt.url), second = await opened(takenDown.receipt.url);
    await quarantine(expiring.receipt.id, 'direct');
    expect((await admin<Case>(`/api/admin/reports/${first}`)).events.map(event => event.action)).toEqual(['received', 'quarantine']);
    // The transfer expires through its alarm: the next read closes the case as expired.
    const stub = env.TRANSFERS.getByName(expiring.receipt.id);
    await edit(expiring.receipt.id, stored => { stored.expiresAt = Date.now() - 1; });
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const lapsed = await admin<Case>(`/api/admin/reports/${first}`);
    expect(lapsed).toMatchObject({ status: 'closed', outcome: 'expired' });
    expect(lapsed.events.at(-1)?.action).toBe('expired');
    await decide(first, 'quarantine', 'after it expired', 409);
    // A takedown outside the case records its reason there; the list closes it as removed, and the transfer view counts no open report.
    expect(await admin('/api/admin/takedown', { method: 'POST', body: JSON.stringify({ id: takenDown.receipt.id, note: 'confirmed malware' }) })).toEqual({ removed: true, existed: true });
    const all = await admin<{ reports: Case[] }>('/api/admin/reports?status=all&limit=200');
    expect(all.reports.find(entry => entry.case === second)).toMatchObject({ status: 'closed', outcome: 'removed' });
    expect((await admin<Case>(`/api/admin/reports/${second}`)).events.map(({ action, note }) => [action, note]))
      .toEqual([['received', ''], ['remove', 'confirmed malware'], ['removed', '']]);
    expect((await admin<View>(`/api/admin/transfers/${takenDown.receipt.id}`)).openReports).toBe(0);
    const open = await admin<{ reports: Case[] }>('/api/admin/reports?limit=200');
    expect(open.reports.every(entry => entry.status === 'open')).toBe(true);
  });

  it('queues open cases by priority, then oldest first, pages through all of them and lists one transfer\'s, so a flood buries none', async () => {
    const genuine = await file(), flooded = [await file(), await file()], phished = await file();
    const flood: string[] = [];
    for (let index = 0; index < 7; index++) flood.push(await opened(flooded[index % 2].receipt.url, { category: index % 3 ? 'other' : 'copyright' }));
    // Filed after the flood, yet ahead of it: CSAM first, then phishing.
    const phishing = await opened(phished.receipt.url, { category: 'phishing' });
    const real = await opened(genuine.receipt.url, { category: 'csam', name: undefined, email: undefined });
    expect(Object.entries(PRIORITY)).toEqual([['csam', 1], ['malware', 2], ['phishing', 2], ['illegal', 3], ['privacy', 3], ['copyright', 4], ['other', 4]]);
    // Following `next` (the last case of a page) reaches every open case once, in the order of the queue.
    const seen = await queue();
    expect(new Set(seen.map(entry => entry.case)).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort(queued));
    const at = (id: string) => seen.findIndex(entry => entry.case === id);
    expect(at(real)).toBeLessThan(at(phishing));
    expect(Math.max(at(real), at(phishing))).toBeLessThan(Math.min(...flood.map(at)));
    // The flood itself (copyright and other share a priority) in the order it was filed.
    expect(seen.filter(entry => flood.includes(entry.case)).map(entry => entry.case)).toEqual(flood);
    // Readiness names the most urgent open priority, and how many wait.
    expect(unwrap(await reports(env).summary())).toMatchObject({ open: seen.length, priority: 1 });
    // Closed and all cases page newest first.
    const first = await admin<Page>('/api/admin/reports?status=all&limit=3');
    expect(first.reports.map(entry => entry.case)).toEqual([real, phishing, flood[6]]);
    expect(first.next).toBe(flood[6]);
    expect((await admin<Page>(`/api/admin/reports?status=all&limit=3&after=${first.next}`)).reports.map(entry => entry.case)).toEqual([flood[5], flood[4], flood[3]]);
    // One transfer's cases directly, and the operator's view of the transfer names them in the order of the queue.
    expect(await admin<Page>(`/api/admin/reports?status=all&transfer=${genuine.receipt.id}`)).toEqual({ reports: [expect.objectContaining({ case: real })], next: null });
    expect(await admin<View>(`/api/admin/transfers/${genuine.receipt.id}`)).toMatchObject({ openReports: 1, openCases: [real] });
    expect((await admin<View>(`/api/admin/transfers/${flooded[0].receipt.id}`)).openCases).toEqual([flood[0], flood[2], flood[4], flood[6]]);
    for (const query of ['after=1', 'after=x', `after=${real}x`, 'transfer=short', `transfer=${genuine.receipt.id}!`])
      expect((await operator('/api/admin/reports?' + query)).status, query).toBe(400);
    const gone = await operator('/api/admin/reports?after=R-0000000000');
    expect([gone.status, await codeOf(gone)]).toEqual([400, 'invalid_cursor']);
  });

  it('wants a reason of at least 3 characters for every decision but a note, and changes nothing without one', async () => {
    const { receipt } = await file(), id = await opened(receipt.url);
    for (const [path, body] of [
      ['/api/admin/quarantine', { id: receipt.id }], ['/api/admin/quarantine', { id: receipt.id, note: ' ok ' }], ['/api/admin/restore', { id: receipt.id, note: '' }],
      ['/api/admin/takedown', { id: receipt.id }], ['/api/admin/takedown', { id: receipt.id, note: '\t\u00a0x ' }],
      [`/api/admin/reports/${id}`, { action: 'quarantine' }], [`/api/admin/reports/${id}`, { action: 'restore', note: 'no' }],
      [`/api/admin/reports/${id}`, { action: 'remove', note: '  \n ' }], [`/api/admin/reports/${id}`, { action: 'reject', note: null }],
    ] as const) {
      const refused = await operator(path, { method: 'POST', body: JSON.stringify(body) });
      expect([refused.status, await refused.json()], JSON.stringify(body)).toEqual([400,
        { error: 'Give the reason for this decision in a note of at least 3 characters.', code: 'note_required' }]);
    }
    expect(await admin<View>(`/api/admin/transfers/${receipt.id}`)).toMatchObject({ status: 'ready', quarantine: null });
    expect((await admin<Case>(`/api/admin/reports/${id}`)).events.map(event => event.action)).toEqual(['received']);
    // A note stays a note: it may be empty. Three characters (code points) give a reason.
    expect((await decide(id, 'note')).events.map(event => event.action)).toEqual(['received', 'note']);
    expect(await decide(id, 'reject', '🙂🙂🙂')).toMatchObject({ status: 'closed', outcome: 'rejected' });
  });

  it('closes open cases about transfers that must be gone in the daily alarm, read or not, so their retention starts', async () => {
    const stub = reports(env), day = 86400000, live = await file();
    await runInDurableObject(stub, (_instance, ctx) => {
      const insert = (id: string, createdAt: number, transfer: string) => ctx.storage.sql.exec(`INSERT INTO cases (id, created_at, transfer_id, category, details, name, email, network, status, outcome, updated_at, closed_at)
        VALUES (?, ?, ?, 'other', 'stale fixture details here', NULL, NULL, 'n', 'open', NULL, ?, NULL)`, id, createdAt, transfer, createdAt);
      // Filed 9 days ago: its transfer closed by now (24 h upload window + 7 days at most).
      insert('R-STALE00000', Date.now() - 9 * day, randomToken());
      // Recent: closed lazily on the next read, as before; and one about a live transfer, which stays open.
      insert('R-STALE00001', Date.now() - day, randomToken());
      insert('R-STALE00002', Date.now() - day, live.receipt.id);
      // Filed about a file already gone: open for the operator, until it is as old as the first.
      const gone = randomToken();
      insert('R-STALE00003', Date.now() - 9 * day, gone);
      insert('R-STALE00004', Date.now() - day, gone);
      ctx.storage.sql.exec(`UPDATE cases SET file_available = 0 WHERE id IN ('R-STALE00003', 'R-STALE00004')`);
      return ctx.storage.setAlarm(Date.now() + 60000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = () => runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec<{ id: string; status: string; outcome: string | null; events: number }>(
      `SELECT id, status, outcome, (SELECT COUNT(*) FROM events WHERE case_id = cases.id) AS events FROM cases WHERE id GLOB 'R-STALE*' ORDER BY id`).toArray());
    expect(await state()).toEqual([
      { id: 'R-STALE00000', status: 'closed', outcome: 'expired', events: 1 }, { id: 'R-STALE00001', status: 'open', outcome: null, events: 0 },
      { id: 'R-STALE00002', status: 'open', outcome: null, events: 0 }, { id: 'R-STALE00003', status: 'closed', outcome: 'expired', events: 1 },
      { id: 'R-STALE00004', status: 'open', outcome: null, events: 0 },
    ]);
  });

  it('shows the transfer and lets the operator take it down while Reports fails; a quarantine or takedown says its cases missed the event', async () => {
    const { receipt } = await file(), failed = async () => { throw new Error('Durable Object reset because its code was updated.'); };
    const down = { getByName: () => ({ forTransfer: failed, annotate: failed, openCount: failed }) } as unknown as Env['REPORTS'];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), metrics = dataset(), bindings = { REPORTS: down, METRICS: metrics.METRICS };
    try {
      const view = await operatorWith(`/api/admin/transfers/${receipt.id}`, bindings);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({ id: receipt.id, exists: true, status: 'ready', openReports: null, openCases: null });
      expect(metrics.events).toEqual(['fallback:reports_view']);
      // The upload switch works without the reports too.
      const status = await operatorWith('/api/admin/uploads', bindings);
      expect([status.status, (await status.json<{ openReports: number | null }>()).openReports]).toEqual([200, null]);
      expect(metrics.events).toEqual(['fallback:reports_view', 'fallback:reports_view']);
      metrics.events.length = 0;
      // The quarantine took effect even though no case could record it: 200, not a 503 that a retry would turn into 409.
      const quarantined = await operatorWith('/api/admin/quarantine', bindings, { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'outage' }) });
      expect(quarantined.status).toBe(200);
      expect(await quarantined.json()).toMatchObject({ quarantine: { note: 'outage' }, openReports: null, reportsUpdated: false });
      expect(errors.mock.calls.map(([line]) => String(line))).toContain(JSON.stringify({ event: 'reports_unavailable', action: 'quarantine' }));
      expect(metrics.events).toEqual(['quarantine', 'fallback:reports_view']);
      const removed = await operatorWith('/api/admin/takedown', bindings, { method: 'POST', body: JSON.stringify({ id: receipt.id, note: 'outage' }) });
      expect([removed.status, await removed.json()]).toEqual([200, { removed: true, existed: true, reportsUpdated: false }]);
      expect(errors.mock.calls.map(([line]) => String(line))).toContain(JSON.stringify({ event: 'reports_unavailable', action: 'remove' }));
      expect(metrics.events).toEqual(['quarantine', 'fallback:reports_view', 'takedown']);
    } finally { errors.mockRestore(); }
    expect((await admin<View>(`/api/admin/transfers/${receipt.id}`)).status).toBe('removed');
  });

  it('shows an id nothing was stored for without storing anything, and checks its parameters', async () => {
    const id = randomToken();
    expect(await admin<View>(`/api/admin/transfers/${id}`)).toEqual({ id, exists: false, status: null, name: null, size: null, createdAt: null, mode: null,
      expiresAt: null, once: null, protected: null, quarantine: null, clean: null, openReports: 0, openCases: [] });
    expect(await runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='transfer'").toArray())).toEqual([]);
    expect((await operator('/api/admin/quarantine', { method: 'POST', body: JSON.stringify({ id, note: 'no such file' }) })).status).toBe(404);
    expect((await operator(`/api/admin/transfers/${id}`, {}, '')).status).toBe(401);
    for (const query of ['status=bogus', 'limit=0', 'limit=201', 'limit=x']) expect((await operator('/api/admin/reports?' + query)).status, query).toBe(400);
    expect((await operator('/api/admin/reports/R-0000000000')).status).toBe(404);
    expect((await operator('/api/admin/reports/not-a-case')).status).toBe(404);
    const { receipt } = await file(), open = await opened(receipt.url);
    for (const body of [{ action: 'delete' }, { action: 'note', note: 'n'.repeat(1001) }, { action: 'note', note: 'bell\u0007' }])
      expect((await operator(`/api/admin/reports/${open}`, { method: 'POST', body: JSON.stringify(body) })).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    expect((await operator(`/api/admin/reports/${open}`, { method: 'PUT', body: '{}' })).status).toBe(405);
  });

  it('deletes closed cases with their events 183 days after closing, and keeps the rest', async () => {
    const stub = reports(env), day = 86400000;
    const live = await file();
    await runInDurableObject(stub, async (_instance, ctx) => {
      const insert = (id: string, status: string, closedAt: number | null, transfer = randomToken(), createdAt = Date.now() - 400 * day) => {
        ctx.storage.sql.exec(`INSERT INTO cases (id, created_at, transfer_id, category, details, name, email, network, status, outcome, updated_at, closed_at)
          VALUES (?, ?, ?, 'other', 'retention fixture details', NULL, NULL, 'n', ?, ?, ?, ?)`, id, createdAt, transfer, status,
          status === 'closed' ? 'rejected' : null, Date.now(), closedAt);
        ctx.storage.sql.exec(`INSERT INTO events (case_id, at, action, note) VALUES (?, ?, 'received', '')`, id, createdAt);
      };
      insert('R-RETAINOLD0', 'closed', Date.now() - 184 * day);
      insert('R-RETAINNEW0', 'closed', Date.now() - 182 * day);
      insert('R-RETAINOPEN', 'open', null, live.receipt.id, Date.now() - 1000);
      await ctx.storage.setAlarm(Date.now() + 60000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const left = (table: string, column: string) => ctx.storage.sql.exec<{ id: string }>(`SELECT ${column} AS id FROM ${table} WHERE ${column} GLOB 'R-RETAIN*' ORDER BY 1`).toArray().map(row => row.id);
      expect(left('cases', 'id')).toEqual(['R-RETAINNEW0', 'R-RETAINOPEN']);
      expect(left('events', 'case_id')).toEqual(['R-RETAINNEW0', 'R-RETAINOPEN']);
      expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });
});
