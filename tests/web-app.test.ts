import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PASSWORD_PAUSE_MS } from '../src/shared';
import { ENGLISH } from './english';
import { camel, Doc, El, Locks, MemoryStorage } from './fake-dom';
import { fakeAPI, type Session, type Upload } from './fake-api';

// dist/app.js (the upload page), dist/download.js (the download page) and dist/report.js (the report form) run here
// as a browser runs them, against a scripted page: an element exists once a script asks for it and keeps what the
// script sets, storage lives in memory and is shared by every page a test opens, and Web Locks behave like the
// browser's. Opening a page again is a reload: the previous page's timers stop and its locks are freed. A test plays
// another tab by holding a lock or changing storage. Time is fake, so a test decides when a countdown runs out.
const fail = (status: number, code: string, message = 'Refused.') => Object.assign(new Error(message), { status, code });
// "Custom…" in the receipt's expiry menu (static markup in i18n/templates/index.html).
const customExpiry = () => Object.assign(new El('expiry-custom'), { dataset: { action: 'edit-expiry' } });

const NOW = Date.UTC(2026, 9, 30, 12), MINUTE = 60000, HOUR = 3600000, DAY = 86400000, MB = 1048576;
const U = 'u'.repeat(43), U2 = 'v'.repeat(43), K = 'k'.repeat(43), R = 'r'.repeat(43), D = 'd'.repeat(43);
const realTimeout = setTimeout.bind(globalThis); // taken before a test fakes the timers
const pause = () => new Promise<void>(resolve => { realTimeout(resolve, 0); });
let local: MemoryStorage, session: MemoryStorage, locks: Locks, lockless: boolean, api: ReturnType<typeof fakeAPI>;
let fetcher: Mock<(path: string) => Promise<Response>>, reply: () => Response, pages = 0;
// window.FYL_CONFIG as the Worker's /config.js sets it (undefined: not loaded).
let config: Record<string, unknown> | undefined;
// What navigator has besides Web Locks (a service worker container, a clipboard), for the next page opened.
let navigatorExtras: Record<string, unknown> = {};

// Lets the page finish what it started: real promises (hashing a file, reading an answer) and timers due now.
async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round++) { await pause(); await vi.advanceTimersByTimeAsync(0); }
}
// Lets the page run, `ms` of fake time per round, until `check` passes.
async function until(check: () => void, ms = 0) {
  for (let round = 0; ; round++) {
    try { check(); return; } catch (error) { if (round === 300) throw error; }
    await pause(); await vi.advanceTimersByTimeAsync(ms);
  }
}

async function open(url: string, setup: (doc: Doc) => void, script: () => Promise<unknown>) {
  // Clearing the fake timers also resets their clock, so the time is set again.
  const now = Date.now();
  vi.clearAllTimers(); vi.setSystemTime(now);
  locks.close(pages); locks.page = ++pages;
  const doc = new Doc(), idle: (() => unknown)[] = [];
  doc.querySelector('input[name="lifetime"]:checked').value = '1440';
  // The page's messages (dist/i18n.js reads them first), in English.
  doc.getElementById('fyl-i18n').textContent = ENGLISH;
  setup(doc);
  let address = new URL(url);
  const win = Object.assign(new El(), { localStorage: local, sessionStorage: session, FylAPI: api, FYL_CONFIG: config, open: vi.fn(),
    requestIdleCallback: (callback: () => unknown) => { idle.push(callback); } });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', {
    get hash() { return address.hash; }, get pathname() { return address.pathname; }, get search() { return address.search; },
    get origin() { return address.origin; }, get host() { return address.host; }, get href() { return address.href; },
    replace: vi.fn(), assign: vi.fn(), reload: vi.fn(),
  });
  vi.stubGlobal('history', { state: null, replaceState: (_state: unknown, _title: string, next: string) => { address = new URL(next, address); } });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('navigator', { ...(lockless ? {} : { locks }), ...navigatorExtras });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('getComputedStyle', () => ({ opacity: '1' }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
  vi.stubGlobal('requestIdleCallback', win.requestIdleCallback);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('getSelection', () => ({ selectAllChildren() {} }));
  vi.resetModules();
  await script();
  await settle();
  const el = (id: string) => doc.getElementById(id);
  return {
    doc, win, el, location: () => address,
    text: (id: string) => el(id).textContent,
    // The Upload button's visible label: its action, or while it can't be pressed the reason.
    button: () => el(el('create-button').disabled ? 'go-a' : 'go-b').textContent,
    // The refresh of the recent uploads the page leaves for an idle moment.
    idle: () => Promise.all(idle.splice(0).map(callback => callback())),
    // The element in #id's markup that carries attribute="value", as a click target.
    find(id: string, attribute: string, value: string) {
      const tag = new RegExp(`<[a-z]+\\b[^>]*\\b${attribute}="${value}"[^>]*>`).exec(el(id).innerHTML)?.[0];
      if (!tag) throw new Error(`#${id} has no element with ${attribute}="${value}"`);
      const target = new El(/\bid="([^"]*)"/.exec(tag)?.[1]);
      for (const [, name, data] of tag.matchAll(/\bdata-([a-z-]+)(?:="([^"]*)")?/g)) target.dataset[camel(name)] = data ?? '';
      return target;
    },
  };
}
// @ts-expect-error: browser scripts without type declarations.
const openApp = (hash = '') => open('https://fyl.at/' + hash, () => {}, () => import('../dist/i18n.js').then(() => import('../dist/app.js')));
const openDownload = (state: Record<string, unknown>, hidden = false) => open(`https://fyl.at/d/${D}/report.pdf`, doc => {
  doc.getElementById('fyl-state').textContent = JSON.stringify(state); doc.hidden = hidden;
// @ts-expect-error: browser scripts without type declarations.
}, () => import('../dist/i18n.js').then(() => import('../dist/download.js')));
// The form's radio buttons are one list with the chosen value, as form.elements gives them.
const openReport = (search = '') => {
  vi.stubGlobal('scrollTo', () => {});
  return open('https://fyl.at/report' + search, doc => {
    Object.assign(doc.getElementById('report-form'), { elements: { category: Object.assign([new El()], { value: 'malware' }) } });
    doc.getElementById('done-view').hidden = true; doc.getElementById('done-gone').hidden = true;
  // @ts-expect-error: browser scripts without type declarations.
  }, () => import('../dist/i18n.js').then(() => import('../dist/report.js')));
};
type Page = Awaited<ReturnType<typeof openApp>>;
// docs/E2EE.md §9.5: every element whose text (or an attribute, such as a title) holds `key` on this page, which must
// carry translate="no" in the page's markup (`path`), so a browser translating the page never sends the key along.
async function untranslated(page: Page, key: string, path: string) {
  const holders = [...page.doc.elements.values()].filter(element =>
    [element.textContent, element.value, element.innerHTML, element.innerHTML.replace(/<[^>]*>/g, '')].some(text => text.includes(key))).map(element => element.id);
  const markup = await (await env.ASSETS.fetch('https://fyl.at/en' + path)).text();
  const opted = (id: string) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*\\btranslate="no"`).test(markup);
  return { holders, translated: holders.filter(id => !opted(id)) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  local = new MemoryStorage(); session = new MemoryStorage(); locks = new Locks(); lockless = false; api = fakeAPI(); config = undefined; navigatorExtras = {};
  reply = () => Response.json({});
  fetcher = vi.fn(async () => reply());
});
afterEach(async () => {
  vi.clearAllTimers(); vi.useRealTimers();
  await pause(); await pause();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const record = (id: string, changes: Record<string, unknown> = {}) => ({ id, ownerKey: K, name: 'report.pdf', size: 2048,
  url: `https://fyl.at/d/${id}/report.pdf`, expiresAt: Date.now() + DAY, createdAt: Date.now() - HOUR, minutes: 1500, once: false,
  protected: false, state: 'ready', ...changes });
const owned = (id: string, changes: Record<string, unknown> = {}) => {
  const { ownerKey: _, ...view } = record(id, changes);
  return { ...view, owner: true };
};
const store = (...records: object[]) => local.setItem('fyl-recent', JSON.stringify(records));
const file = () => new File(['fyl.at test file'], 'a.bin', { lastModified: NOW - DAY });
const receipt = () => ({ id: U, transferId: U, name: 'a.bin', size: 16, url: `https://fyl.at/d/${U}/a.bin`, expiresAt: Date.now() + DAY,
  createdAt: Date.now(), minutes: 1440, once: false, protected: false, state: 'ready', managementUrl: `https://fyl.at/#manage/${U}/${K}`, ownerKey: K });
const interrupted = () => Object.assign(new Error('Connection interrupted. Please try again.'), { resumable: true });
// What FylAPI.upload does around the transfer itself: it reports the session (new or resumed) first.
const started = (then: () => unknown): Upload => async (_file, _options, _controller, _progress, resume, onSession) => {
  await onSession(resume || { uploadId: U, key: K, url: `https://fyl.at/d/${U}` });
  return then();
};
const RESUME_HINT = 'The upload was interrupted. Your progress is saved: press "Resume upload" to continue.';

async function choose(page: Page, chosen: File) {
  page.el('file-input').files = [chosen];
  await page.el('file-input').fire('change');
  await settle();
}
// A first page uploads the file until the connection drops, so the upload is kept for a resume.
async function interrupt() {
  const first = await openApp();
  await choose(first, file());
  api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
  await first.el('create-button').fire('click');
  expect(first.text('form-error')).toBe(RESUME_HINT);
  api.upload.mockClear();
}

describe('recent uploads and passwords in this browser', () => {
  it('drops a password stored with a recent upload on the first load, whatever state the upload is in', async () => {
    const [live, expired, used, deleted] = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(43));
    store(record(live, { password: 'live-secret-1' }), record(expired, { expiresAt: Date.now() - HOUR, password: 'expired-secret-2' }),
      record(used, { state: 'consumed', password: 'consumed-secret-3' }), record(deleted, { state: 'deleted', password: 'deleted-secret-4' }));
    api.info.mockResolvedValue(owned(live));
    const page = await openApp();
    const kept = () => [...local.items.values()].join('\n');
    expect(kept()).not.toMatch(/secret/);
    expect(local.json('fyl-recent').map((stored: { id: string }) => stored.id)).toEqual([live, expired, used, deleted]);
    await page.idle();
    expect(api.info).toHaveBeenCalledTimes(1);
    expect(kept()).not.toMatch(/secret/);
  });

  it('keeps a download password in this tab only, unless the sender ticks Remember the password', async () => {
    store(record(R, { protected: true }));
    session.setItem('fyl-passwords', JSON.stringify({ [R]: 'tide-lamp-fern-41' }));
    api.info.mockResolvedValue(owned(R, { protected: true }));
    let page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('receipt-view').innerHTML).toContain('<span class="value" id="receipt-password" dir="ltr" translate="no">tide-lamp-fern-41</span>');
    expect(page.el('receipt-view').innerHTML).toContain('<input type="checkbox" id="remember-password">');
    const remember = (checked: boolean) => page.doc.fire('change', { target: { id: 'remember-password', checked } });
    await remember(true);
    expect(local.json('fyl-passwords')).toEqual({ [R]: 'tide-lamp-fern-41' });
    await remember(false);
    expect(local.getItem('fyl-passwords')).toBeNull();
    expect(session.json('fyl-passwords')).toEqual({ [R]: 'tide-lamp-fern-41' });
    // Another tab has its own session storage: it knows the password only once it was remembered.
    session.items.clear();
    page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('receipt-view').innerHTML).not.toContain('receipt-password');
    session.setItem('fyl-passwords', JSON.stringify({ [R]: 'tide-lamp-fern-41' }));
    page = await openApp(`#manage/${R}/${K}`);
    await remember(true);
    session.items.clear();
    page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('receipt-view').innerHTML).toContain('<input type="checkbox" id="remember-password" checked>');
    expect(local.getItem('fyl-recent')).not.toContain('tide-lamp');
  });

  it('forgets the recent uploads, the unfinished upload and every password on this device', async () => {
    await interrupt();
    store(record(R, { protected: true }));
    local.setItem('fyl-passwords', JSON.stringify({ [R]: 'tide-lamp-fern-41' }));
    session.setItem('fyl-passwords', JSON.stringify({ [R]: 'tide-lamp-fern-41' }));
    const page = await openApp();
    await page.doc.fire('click', { target: new El('forget-all') });
    expect(page.el('forget-text').innerHTML).toContain('the unfinished upload of <strong>a.bin</strong>');
    await page.el('confirm-forget').fire('click');
    expect(api.discard).toHaveBeenCalledWith({ uploadId: U, key: K });
    expect([...local.items.keys()]).toEqual([]);
    expect([...session.items.keys()]).toEqual([]);
    expect(page.el('recent-section').hidden).toBe(true);
  });

  it('leaves an upload another tab is running when forgetting this device', async () => {
    await interrupt();
    locks.take('fyl-upload:' + U);
    const page = await openApp();
    await page.doc.fire('click', { target: new El('forget-all') });
    expect(page.el('forget-text').innerHTML).not.toContain('unfinished');
    await page.el('confirm-forget').fire('click');
    expect(api.discard).not.toHaveBeenCalled();
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U });
  });
});

describe('interrupted uploads across tabs and reloads', () => {
  it('keeps an interrupted upload for a resume after a reload, and drops it only once the receipt is stored', async () => {
    await interrupt();
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U, key: K, name: 'a.bin', size: 16, minutes: 1440, once: false, protected: false,
      print: expect.any(String) });
    const page = await openApp();
    expect([page.el('pending-upload').hidden, page.text('pending-name')]).toEqual([false, 'a.bin']);
    await choose(page, file());
    // The same file chosen: Upload says Resume upload, and the notice asking for it has done its job.
    expect([page.button(), page.el('pending-upload').hidden]).toEqual(['Resume upload', true]);
    api.upload.mockImplementationOnce(started(receipt));
    local.log.length = 0;
    void page.el('create-button').fire('click');
    await until(() => expect(page.el('receipt-view').innerHTML).toContain('data-action="copy-private"'), 100);
    expect(api.upload.mock.calls[0][4]).toEqual({ uploadId: U, key: K, url: `https://fyl.at/d/${U}` });
    expect(local.getItem('fyl-upload')).toBeNull();
    expect(local.json('fyl-recent')).toMatchObject([{ id: U, ownerKey: K, state: 'ready' }]);
    const log = local.log.filter(entry => !entry.endsWith('fyl-passwords'));
    expect(log.indexOf('set fyl-recent')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('set fyl-recent')).toBeLessThan(log.indexOf('remove fyl-upload'));
  });

  it('keeps the unfinished upload when its receipt could not be stored with the recent uploads', async () => {
    const page = await openApp();
    await choose(page, file());
    api.upload.mockImplementationOnce(started(receipt));
    local.refuse.add('fyl-recent');
    void page.el('create-button').fire('click');
    await until(() => expect(page.el('lo').classList.contains('ready')).toBe(true));
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U, key: K });
  });

  it('shows an upload another tab runs as continuing there, and resumes it here once that tab let go', async () => {
    await interrupt();
    const release = locks.take('fyl-upload:' + U);
    const page = await openApp();
    await choose(page, file());
    expect([page.text('pending-lead'), page.text('pending-tail'), page.el('discard-pending').hidden]).toEqual(['The upload of ', ' continues in another tab.', true]);
    expect([page.button(), page.text('go-b'), page.el('create-button').disabled]).toEqual(['Continuing in another tab', 'Resume upload', true]);
    // A click that got through anyway (the other tab took the lock meanwhile) leaves the upload to that tab.
    await page.el('create-button').fire('click');
    expect(page.text('form-error')).toBe('This upload is continuing in another tab.');
    expect(api.upload).not.toHaveBeenCalled();
    release();
    await until(() => expect(page.el('create-button').disabled).toBe(false));
    expect([page.text('pending-tail'), page.text('form-error'), page.button()]).toEqual(['. Choose the same file to resume.', '', 'Resume upload']);
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.upload.mock.calls[0][4]).toEqual({ uploadId: U, key: K, url: `https://fyl.at/d/${U}` });
  });

  it('reads the unfinished upload again once it holds the lock, and stops if another tab replaced it meanwhile', async () => {
    await interrupt();
    const page = await openApp();
    await choose(page, file());
    expect(page.button()).toBe('Resume upload');
    const replaced = { ...local.json('fyl-upload'), uploadId: U2, lock: 'fyl-upload:' + U2 };
    locks.beforeGrant = name => { if (name === 'fyl-upload:' + U) local.setItem('fyl-upload', JSON.stringify(replaced)); };
    await page.el('create-button').fire('click');
    expect(page.text('form-error')).toBe('The unfinished upload changed in another tab. Choose the file again.');
    expect(api.upload).not.toHaveBeenCalled();
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U2 });
  });

  it('resumes at most once per page load without Web Locks', async () => {
    lockless = true;
    await interrupt();
    let page = await openApp();
    await choose(page, file());
    api.upload.mockImplementation(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    expect([page.text('form-error'), api.upload.mock.calls.length]).toEqual([RESUME_HINT, 1]);
    await page.el('create-button').fire('click');
    expect([page.text('form-error'), api.upload.mock.calls.length]).toEqual(['Reload the page to resume this upload again.', 1]);
    page = await openApp();
    await choose(page, file());
    await page.el('create-button').fire('click');
    expect([page.text('form-error'), api.upload.mock.calls.length]).toEqual([RESUME_HINT, 2]);
  });
});

describe('a transfer under review', () => {
  const underReview = () => fail(403, 'quarantined', 'This file is unavailable while a report about it is reviewed.');

  it('lets the owner delete it from the management link', async () => {
    store(record(R));
    api.info.mockRejectedValue(underReview());
    const page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('gone-view').innerHTML).toContain('<span class="tag-out">Under review</span>');
    expect(page.el('gone-view').innerHTML).toContain('<p class="gone-file" dir="auto">report.pdf</p>');
    await page.doc.fire('click', { target: page.find('gone-view', 'data-action', 'delete') });
    expect(page.el('delete-dialog').opened).toBe(1);
    expect(page.el('delete-text').innerHTML).toBe('<strong>report.pdf</strong> stays deleted even if the review clears it. This can’t be undone.');
    await page.el('confirm-delete').fire('click');
    expect(api.remove).toHaveBeenCalledWith(R, K);
    expect(page.el('gone-view').innerHTML).toContain('This file was deleted');
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, state: 'deleted' }]);
  });

  it('offers the same from the recent uploads and on a device that never stored the transfer', async () => {
    store(record(R));
    api.info.mockRejectedValue(underReview());
    let page = await openApp();
    await page.doc.fire('click', { target: page.find('recent-list', 'data-record', R) });
    expect(page.location().hash).toBe(`#manage/${R}/${K}`);
    expect(page.find('gone-view', 'data-action', 'delete').dataset).toEqual({ action: 'delete' });
    local.items.clear();
    page = await openApp(`#manage/${U}/${K}`);
    expect(page.el('gone-view').innerHTML).toContain('This file is under review');
    expect(page.el('gone-view').innerHTML).not.toMatch(/gone-file|undefined/);
    await page.doc.fire('click', { target: page.find('gone-view', 'data-action', 'delete') });
    expect(page.el('delete-text').innerHTML).toBe('This file stays deleted even if the review clears it. This can’t be undone.');
    await page.el('confirm-delete').fire('click');
    expect(api.remove).toHaveBeenCalledWith(U, K);
    expect(page.el('gone-view').innerHTML).toContain('This file was deleted');
    expect(local.getItem('fyl-recent')).toBeNull();
  });

  it('shows no controls to a wrong key, and the server refusing the delete keeps the dialog open', async () => {
    api.info.mockRejectedValue(fail(403, 'forbidden', 'The management key is not valid.'));
    let page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('gone-view').innerHTML).toContain('This private link doesn’t work');
    expect(page.el('gone-view').innerHTML).not.toContain('data-action="delete"');
    api.info.mockRejectedValue(underReview());
    api.remove.mockRejectedValue(fail(429, 'rate_limited', 'Too many requests. Wait a minute.'));
    page = await openApp(`#manage/${R}/${K}`);
    await page.doc.fire('click', { target: page.find('gone-view', 'data-action', 'delete') });
    await page.el('confirm-delete').fire('click');
    // The page says it by the code, in its language (the server's JSON stays English).
    expect([page.text('delete-error'), page.el('delete-error').hidden]).toEqual(['Too many requests. Please try again shortly.', false]);
    expect(page.el('gone-view').innerHTML).toContain('This file is under review');
  });

  it('marks a recent upload under review, also after a reload, until the review is over', async () => {
    const reviewing = 'review', sharing = 'ready';
    const states = (page: Page) => [...page.el('recent-list').innerHTML.matchAll(/<li class="row[^"]*" data-status="([a-z]+)">/g)].map(match => match[1]);
    store(record(R), record(U2, { name: 'other.pdf' }));
    api.info.mockImplementation(async id => { if (id === R) throw underReview(); return owned(U2, { name: 'other.pdf' }); });
    let page = await openApp();
    expect(states(page)).toEqual([sharing, sharing]);
    await page.idle();
    // Newest first: U2, then R.
    expect(states(page)).toEqual([sharing, reviewing]);
    expect(page.el('recent-list').innerHTML.match(/<span class="tag-out">Under review<\/span>/g)).toHaveLength(1);
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, review: true }, { id: U2, review: false }]);
    // Its countdown goes on: a review never extends the lifetime, and the file may come back.
    expect(page.el('recent-list').innerHTML).toContain(`data-countdown="${R}"`);
    page = await openApp();
    expect(states(page)).toEqual([sharing, reviewing]);
    api.info.mockImplementation(async id => owned(id, id === U2 ? { name: 'other.pdf' } : {}));
    await page.idle();
    expect(states(page)).toEqual([sharing, sharing]);
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, review: false }, { id: U2, review: false }]);
    // Opening the management link finds it under review again; a closed transfer is no longer under review.
    api.info.mockImplementation(async id => { if (id === R) throw underReview(); return owned(id); });
    page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('gone-view').innerHTML).toContain('This file is under review');
    expect(states(page)).toEqual([sharing, reviewing]);
    await page.doc.fire('click', { target: page.find('gone-view', 'data-action', 'delete') });
    await page.el('confirm-delete').fire('click');
    expect(states(page)).toEqual([sharing, 'deleted']);
  });

  it('shows a transfer that went under review meanwhile when its expiry is changed', async () => {
    store(record(R));
    api.info.mockResolvedValue(owned(R));
    const page = await openApp(`#manage/${R}/${K}`);
    api.expiry.mockRejectedValueOnce(underReview());
    expect(page.el('mt-change').hidden).toBe(false);
    await page.doc.fire('click', { target: customExpiry() });
    await page.el('save-expiry').fire('click');
    expect(api.expiry).toHaveBeenCalledOnce();
    expect(page.el('gone-view').innerHTML).toContain('<span class="tag-out">Under review</span>');
    expect(page.el('gone-view').innerHTML).toContain('data-action="delete"');
    expect([page.text('expiry-error'), page.text('toast-text')]).toEqual(['', '']);
    expect(page.el('recent-list').innerHTML).toContain('data-status="review"');
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, state: 'ready', review: true }]);
  });
});

// The sender lifts a pause that wrong passwords caused, at once and without a confirmation.
describe('a link paused by wrong passwords', () => {
  // The owner info as the server gives it: when the pause of everyone ends, and how many networks are paused.
  const pausedView = (until: number | null, networks = 0, serverTime: number | undefined = Date.now()) =>
    owned(R, { protected: true, passwordPause: { until, networks }, serverTime });
  const pausedFor = (ms: number, serverTime = Date.now()) => pausedView(serverTime + ms, 0, serverTime);
  const lift = (page: Page) => page.doc.fire('click', { target: page.find('receipt-view', 'data-action', 'lift-pause') });
  const liftable = (page: Page) => page.el('receipt-view').innerHTML.includes('data-action="lift-pause"');
  // Draws the receipt again as changing the expiry does: that answer has neither the server's time nor the pauses.
  async function changeExpiry(page: Page) {
    api.expiry.mockResolvedValueOnce(owned(R, { protected: true }));
    expect(page.el('mt-change').hidden).toBe(false);
    await page.doc.fire('click', { target: customExpiry() });
    expect(page.el('expiry-dialog').opened).toBeGreaterThan(0);
    await page.el('save-expiry').fire('click');
    expect(page.text('toast-text')).toBe('Expires 25 hours after the upload. Your link stays the same.');
  }

  it('offers the sender to lift the pause, lifts it on the first click and says so', async () => {
    store(record(R, { protected: true }));
    api.info.mockResolvedValue(pausedFor(10 * MINUTE));
    const page = await openApp(`#manage/${R}/${K}`);
    expect(page.el('receipt-view').innerHTML).toContain('<p class="meta pause-note" id="pause-note">Too many wrong passwords have paused this link.</p>');
    expect(page.el('receipt-view').innerHTML).toContain('data-action="lift-pause" aria-describedby="pause-note"');
    await lift(page);
    expect(api.unpause).toHaveBeenCalledExactlyOnceWith(R, K);
    expect(page.text('toast-text')).toBe('Pause lifted. The password works again.');
    expect(page.el('receipt-view').innerHTML).not.toMatch(/lift-pause|pause-note/);
    expect(page.el('receipt-view').innerHTML).toContain('data-action="copy-private"');
    expect(page.el('delete-dialog').opened).toBe(0);
    // The answer replaced the pauses: drawn again, the receipt still has no button.
    await changeExpiry(page);
    expect(liftable(page)).toBe(false);
  });

  it('shows the button only while the server says the link is paused, by the server clock', async () => {
    store(record(R, { protected: true }));
    for (const [answer, shown] of [
      [owned(R, { protected: true }), false], // a server that doesn't report pauses
      [owned(R, { protected: true, pausedUntil: NOW + MINUTE, serverTime: NOW }), false], // nor in this shape
      [owned(R, { protected: true, passwordPause: null, serverTime: NOW }), false],
      [pausedView(null), false],
      [pausedFor(MINUTE), true],
      [pausedFor(-MINUTE), false],
      // This device is two hours behind: by its clock the pause would run for two more hours, but it ended.
      [pausedFor(-MINUTE, NOW + 2 * HOUR), false],
      // And two hours ahead: by its clock the pause ended long ago, but it runs for ten more minutes.
      [pausedFor(10 * MINUTE, NOW - 2 * HOUR), true],
      // Without the server's time this device's clock decides.
      [pausedView(NOW + MINUTE, 0, undefined), true],
      [pausedView(NOW - MINUTE, 0, undefined), false],
      // Paused networks have no end the owner is told; their pauses ran as the server answered.
      [pausedView(null, 1), true],
      [pausedView(null, 3, NOW - 2 * HOUR), true],
      [owned(R, { protected: false, passwordPause: { until: NOW + MINUTE, networks: 1 }, serverTime: NOW }), false],
    ] as const) {
      api.info.mockResolvedValue(answer);
      const page = await openApp(`#manage/${R}/${K}`);
      expect([answer, liftable(page)]).toEqual([answer, shown]);
    }
  });

  // The receipt is drawn again later (a changed expiry), by when the pause may be over.
  it('drops the button once the pause of everyone is over, by the server clock of the first answer', async () => {
    store(record(R, { protected: true }));
    // This device is two hours behind the server: by its own clock the pause would last two more hours.
    api.info.mockResolvedValue(pausedFor(15 * MINUTE, NOW + 2 * HOUR));
    const page = await openApp(`#manage/${R}/${K}`);
    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    await changeExpiry(page);
    expect(liftable(page)).toBe(true);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await changeExpiry(page);
    expect(page.el('receipt-view').innerHTML).not.toMatch(/lift-pause|pause-note/);
    expect(api.info).toHaveBeenCalledOnce();
  });

  it('drops the button once the networks paused at the answer must be free again', async () => {
    store(record(R, { protected: true }));
    api.info.mockResolvedValue(pausedView(null, 2, NOW - 2 * HOUR));
    const page = await openApp(`#manage/${R}/${K}`);
    // A network's pause lasts as long as the server's PASSWORD_PAUSE_MS from its last wrong try.
    await vi.advanceTimersByTimeAsync(PASSWORD_PAUSE_MS - MINUTE);
    await changeExpiry(page);
    expect(liftable(page)).toBe(true);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await changeExpiry(page);
    expect(liftable(page)).toBe(false);
  });

  it('keeps the button when lifting fails, and shows a link that closed meanwhile', async () => {
    store(record(R, { protected: true }));
    api.info.mockResolvedValue(pausedFor(10 * MINUTE));
    const page = await openApp(`#manage/${R}/${K}`);
    api.unpause.mockRejectedValueOnce(fail(429, 'rate_limited', 'Too many requests. Please try again shortly.'));
    await lift(page);
    expect(page.text('toast-text')).toBe('Too many requests. Please try again shortly.');
    expect(page.el('receipt-view').innerHTML).toContain('data-action="lift-pause"');
    api.unpause.mockRejectedValueOnce(fail(410, 'deleted', 'This link has been deleted.'));
    await lift(page);
    expect(page.el('gone-view').innerHTML).toContain('This file was deleted');
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, state: 'deleted' }]);
  });

  it('shows a link that went under review meanwhile, which the owner may still delete', async () => {
    store(record(R, { protected: true }));
    api.info.mockResolvedValue(pausedFor(10 * MINUTE));
    const page = await openApp(`#manage/${R}/${K}`);
    api.unpause.mockRejectedValueOnce(fail(403, 'quarantined', 'This file is unavailable while a report about it is reviewed.'));
    await lift(page);
    expect(page.el('gone-view').innerHTML).toContain('<span class="tag-out">Under review</span>');
    expect(page.el('gone-view').innerHTML).toContain('<p class="gone-file" dir="auto">report.pdf</p>');
    expect(page.text('toast-text')).toBe('');
    expect(page.el('recent-list').innerHTML).toContain('data-status="review"');
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, state: 'ready', review: true }]);
    await page.doc.fire('click', { target: page.find('gone-view', 'data-action', 'delete') });
    expect(page.el('delete-text').innerHTML).toBe('<strong>report.pdf</strong> stays deleted even if the review clears it. This can’t be undone.');
    await page.el('confirm-delete').fire('click');
    expect(api.remove).toHaveBeenCalledWith(R, K);
    expect(local.json('fyl-recent')).toMatchObject([{ id: R, state: 'deleted' }]);
  });
});

// A file pasted into the page is chosen like a dropped one.
describe('pasting a file', () => {
  const paste = (page: Page, clipboardData: object, target: El = page.doc.body) => page.doc.fire('paste', { clipboardData, target });
  const chosen = (page: Page) => page.el('selected-name').title;
  const image = (name: string, type = 'image/png') => new File(['png bytes'], name, { type, lastModified: NOW });

  it('chooses a pasted file, and names a pasted image that came without a useful name', async () => {
    const page = await openApp();
    await paste(page, { files: [image('image.png')] }); await settle();
    // Named from the time it was pasted (this device's clock) and its type.
    expect([chosen(page), page.button(), page.el('create-button').disabled]).toEqual(['pasted-image-20261030-120000.png', 'Upload and get link', false]);
    expect(page.text('live-status')).toBe('pasted-image-20261030-120000.png selected.');
    await paste(page, { files: [image('blob', 'image/jpeg')] }); await settle();
    expect(chosen(page)).toBe('pasted-image-20261030-120000.jpg');
    // A real name stays, and so does a file that isn't an image.
    await paste(page, { files: [image('Screenshot 2026-10-30 at 11.58.04.png')] }); await settle();
    expect(chosen(page)).toBe('Screenshot 2026-10-30 at 11.58.04.png');
    await paste(page, { files: [new File(['x'], 'image.txt', { type: 'text/plain' })] }); await settle();
    expect(chosen(page)).toBe('image.txt');
    // Some browsers give the file only as a clipboard item.
    await paste(page, { files: [], items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => file() }] }); await settle();
    expect(chosen(page)).toBe('a.bin');
  });

  it('refuses several files like a drop, ignores pasted text and pasting into a field', async () => {
    const page = await openApp();
    await paste(page, { files: [file(), image('image.png')] });
    expect([page.text('file-error'), chosen(page)]).toEqual(['Choose one file at a time. Put multiple files in an archive first.', '']);
    await paste(page, { files: [], items: [{ kind: 'string', getAsFile: () => null }] });
    expect(chosen(page)).toBe('');
    const field = Object.assign(new El('password-input'), { matches: (selector: string) => selector.includes('input:not(') });
    await paste(page, { files: [file()] }, field);
    expect(chosen(page)).toBe('');
    await paste(page, { files: [file()] }); await settle();
    expect(chosen(page)).toBe('a.bin');
  });

  it('refuses a pasted file while an upload runs, as a drop is', async () => {
    const page = await openApp();
    await choose(page, file());
    api.upload.mockImplementationOnce(started(() => new Promise(() => {})));
    void page.el('create-button').fire('click');
    await settle();
    expect(page.doc.getElementById('main').dataset.view).toBe('progress');
    await paste(page, { files: [image('image.png')] }); await settle();
    expect([chosen(page), page.text('file-error'), api.upload.mock.calls.length]).toEqual(['a.bin', '', 1]);
  });

  it('chooses nothing pasted or dropped while a dialog covers the form, and the drop zone shows no target', async () => {
    const page = await openApp();
    const drop = (type: string) => page.win.fire(type, { dataTransfer: { types: ['Files'], files: [file()], items: [] } });
    page.el('cli-dialog').open = true;
    await paste(page, { files: [image('image.png')] }); await drop('dragenter'); await drop('drop'); await settle();
    expect([chosen(page), page.el('dropzone').classList.contains('drag-over'), page.text('file-error')]).toEqual(['', false, '']);
    page.el('cli-dialog').open = false;
    await drop('dragenter');
    expect(page.el('dropzone').classList.contains('drag-over')).toBe(true);
    await drop('drop'); await settle();
    expect([chosen(page), page.el('dropzone').classList.contains('drag-over')]).toEqual(['a.bin', false]);
  });
});

// A folder becomes one zip (docs/FOLDER-ZIP.md). dist/zip.js builds it (tests/folder-zip.test.ts holds it to the
// vectors); here the page: the card while the folder is read, refusals, what the upload and its resume record get.
describe('folders', () => {
  // @ts-expect-error: browser scripts without type declarations.
  const openFolders = () => open('https://fyl.at/', () => {}, () => import('../dist/i18n.js').then(() => import('../dist/zip.js')).then(() => import('../dist/app.js')));
  // A file as the folder input lists it; Chromium writes a "\" in a name as "/" in webkitRelativePath.
  const inFolder = (path: string, text = path, name = path.split('/').at(-1) as string) =>
    Object.defineProperty(new File([text], name, { lastModified: NOW - DAY }), 'webkitRelativePath', { value: path });
  const photos = () => [inFolder('photos/a.txt', 'hello\n'), inFolder('photos/sub/b.txt', 'second\n'), inFolder('photos/back/slash.txt', 'x', 'back\\slash.txt')];
  const pick = async (page: Page, files: File[]) => { page.el('folder-input').files = files; await page.el('folder-input').fire('change'); await settle(); };
  const meta = (page: Page) => page.el('selected-size').innerHTML;

  it('shows the folder as <folder>.zip while it is read, then uploads its zip, and a resume asks for the same folder', async () => {
    let finish: (crcs: number[]) => void = () => {};
    api.crcPass.mockImplementationOnce((_files, _signal, progress) => { progress(3); return new Promise(resolve => { finish = resolve; }); });
    const page = await openFolders();
    await pick(page, photos());
    // The name skipped for its backslash doesn't count; the card shows it in a quiet line.
    expect([page.el('selected-name').title, page.el('dropzone').hidden, page.el('chosen-file').hidden]).toEqual(['photos.zip', true, false]);
    expect(meta(page)).toBe('279\u00a0bytes · Folder · 2\u00a0files');
    expect([page.button(), page.el('create-button').disabled]).toEqual(['Preparing the folder… 23 %', true]); // 3 of the 13 bytes in its two files
    expect([page.el('selected-note').hidden, page.text('selected-note')]).toEqual([false, 'Left out 1 item with an unsafe name.']);
    // The row's buttons say folder, and the one a screen reader stays on also reads what was left out.
    expect([page.el('repick').getAttribute('aria-label'), page.el('repick').getAttribute('aria-describedby'), page.el('remove-file').getAttribute('aria-label')])
      .toEqual(['Choose a different folder', 'selected-name selected-size selected-note', 'Remove folder']);
    expect(page.text('live-status')).toBe('Preparing the folder…');
    expect(page.text('cli-upload-command')).toBe("fyl './photos'");
    expect(api.crcPass.mock.calls[0][0].map(file => (file as File).name)).toEqual(['a.txt', 'b.txt']);
    finish([0x363a3020, 0x2c2c2a2a]); await settle();
    expect([meta(page), page.button(), page.text('live-status')])
      .toEqual(['279\u00a0bytes · Folder · 2\u00a0files', 'Upload and get link', 'photos.zip selected. Folder · 2\u00a0files. Left out 1 item with an unsafe name.']);
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    const [zip, options] = api.upload.mock.calls[0] as unknown as [File, { folder: { crcs: number[]; ranges: number[][] } }];
    expect([zip.name, options.folder.crcs, options.folder.ranges.length]).toEqual(['photos.zip', [0x363a3020, 0x2c2c2a2a], 2]);
    // The record keeps the folder's fingerprint F where a file's keeps its date (FOLDER-ZIP §9).
    const record = local.json('fyl-upload');
    expect([record.name, record.size, typeof record.lastModified, record.lastModified.length]).toEqual(['photos.zip', zip.size, 'string', 22]);
    expect([page.text('form-error'), page.text('pending-tail')]).toEqual([RESUME_HINT, '. Choose the same folder to resume.']);
    // After a reload, the same folder chosen again continues it.
    const again = await openFolders();
    expect(again.text('pending-tail')).toBe('. Choose the same folder to resume.');
    api.crcPass.mockResolvedValueOnce([0x363a3020, 0x2c2c2a2a]);
    await pick(again, photos());
    expect([again.button(), again.el('pending-upload').hidden]).toEqual(['Resume upload', true]);
    // A file touched to another second is another folder.
    api.crcPass.mockResolvedValueOnce([0x363a3020, 0x2c2c2a2a]);
    await pick(again, [...photos().slice(0, 2), Object.defineProperty(new File(['x'], 'c.txt', { lastModified: NOW }), 'webkitRelativePath', { value: 'photos/c.txt' })]);
    expect(again.button()).toBe('Upload and discard the unfinished one');
    // The notice no longer asks for the same folder: it says why this one can't continue the upload.
    expect([again.el('pending-upload').hidden, again.text('pending-tail')]).toEqual([false, '. This folder changed since the upload started, so it can’t be resumed.']);
  });

  it('shows the folder card again after Cancel upload: its files, what it left out, and buttons that say folder', async () => {
    const page = await openFolders();
    await pick(page, photos());
    api.upload.mockImplementationOnce(async (_file, _options, controller, _progress, _resume, onSession) => {
      await onSession({ uploadId: U, key: K, url: `https://fyl.at/d/${U}/photos.zip` });
      return new Promise((_resolve, reject) => { controller.signal.addEventListener('abort', () => reject(new DOMException('Upload cancelled.', 'AbortError'))); });
    });
    void page.el('create-button').fire('click');
    await settle();
    // While it uploads, the row shows the size and the options it was sent with.
    expect([page.doc.getElementById('main').dataset.view, meta(page), page.el('selected-note').hidden]).toEqual(['progress', '279\u00a0bytes', true]);
    await page.el('cancel-button').fire('click');
    await settle();
    expect([page.doc.getElementById('main').dataset.view, meta(page), page.el('selected-note').hidden, page.el('repick').getAttribute('aria-label'), page.el('remove-file').getAttribute('aria-label')])
      .toEqual(['setup', '279\u00a0bytes · Folder · 2\u00a0files', false, 'Choose a different folder', 'Remove folder']);
  });

  it('refuses a folder too large to encrypt before reading its files, with the folder\'s own message', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openFolders();
    page.el('e2ee-toggle').checked = true; await page.el('e2ee-toggle').fire('change'); await settle();
    // Its zip fits 50 GiB, but not once encryption adds its 16 bytes per 64 KiB.
    const big = Object.defineProperty(inFolder('big/a.bin'), 'size', { value: 50 * 1024 ** 3 - 4 * MB });
    await pick(page, [big]);
    expect([page.text('file-error'), page.el('dropzone').hidden, api.crcPass.mock.calls.length]).toEqual(['This folder is too large to encrypt. Turn encryption off, or choose a folder whose zip is a little smaller than 50\u00a0GB.', false, 0]);
  });

  it('refuses a folder as a whole and goes back to the drop zone: nothing to send, a collision, too large, a file that changed', async () => {
    const page = await openFolders();
    const refused = async (files: File[]) => {
      await pick(page, files);
      return [page.text('file-error'), page.el('dropzone').hidden, page.el('create-button').disabled];
    };
    expect(await refused([inFolder('empty/tab\there.txt')])).toEqual(['The folder has no files to send.', false, true]);
    expect(await refused([inFolder('clash/a.txt'), inFolder('clash/a‎.txt')])).toEqual(['Two items in the folder would get the same name: clash/a.txt.', false, true]);
    // A file and a folder of the same name once the bidi control is dropped.
    expect(await refused([inFolder('clash/a‎'), inFolder('clash/a-b.txt'), inFolder('clash/a/b.txt')])).toEqual(['Two items in the folder would get the same name: clash/a.', false, true]);
    const huge = Object.defineProperty(inFolder('big/a.bin'), 'size', { value: 50 * 1024 ** 3 });
    expect(await refused([huge])).toEqual(['The folder makes a zip larger than 50\u00a0GB.', false, true]);
    api.crcPass.mockRejectedValueOnce(Object.assign(new Error('file_changed'), { code: 'file_changed', index: 1 }));
    expect(await refused(photos())).toEqual(['A file changed while the folder was read: photos/sub/b.txt. Choose the folder again.', false, true]);
    // Removing a folder that is being read stops reading it.
    let signal: AbortSignal | null = null;
    api.crcPass.mockImplementationOnce((_files, given) => { signal = given; return new Promise(() => {}); });
    await pick(page, photos());
    await page.el('remove-file').fire('click'); await settle();
    expect([(signal as AbortSignal | null)?.aborted, page.el('dropzone').hidden]).toEqual([true, false]);
    expect(page.text('live-status')).toBe('Folder removed. Choose another folder when you are ready.');
    // A file chosen next gets the file's labels back.
    page.el('file-input').files = [new File(['abc'], 'a.bin', { lastModified: NOW })];
    await page.el('file-input').fire('change'); await settle();
    expect([page.el('repick').getAttribute('aria-label'), page.el('repick').getAttribute('aria-describedby'), page.el('remove-file').getAttribute('aria-label')])
      .toEqual(['Choose a different file', 'selected-name selected-size', 'Remove file']);
    await page.el('remove-file').fire('click'); await settle();
    expect(page.text('live-status')).toBe('File removed. Choose another file when you are ready.');
  });

  it('zips exactly one dropped folder; several items with a folder among them stay one file at a time', async () => {
    const page = await openFolders();
    // A FileSystemDirectoryEntry whose reader gives one entry per call, then none.
    const file = (name: string, text: string) => ({ name, isFile: true, isDirectory: false, file: (done: (file: File) => void) => done(new File([text], name, { lastModified: NOW })) });
    const dir = (name: string, children: object[]): object => ({ name, isFile: false, isDirectory: true, createReader: () => {
      let at = 0;
      return { readEntries: (done: (batch: object[]) => void) => done(children.slice(at, ++at)) };
    } });
    const entry = dir('Mappe', [file('a.txt', 'a'), dir('sub', [file('b.txt', 'b')]), dir('leer', [])]);
    const drop = (items: object[]) => page.win.fire('drop', { dataTransfer: { types: ['Files'], files: items.map(() => new File([], 'x')), items } });
    await drop([{ kind: 'file', webkitGetAsEntry: () => entry }]); await settle();
    expect([page.el('selected-name').title, meta(page)]).toEqual(['Mappe.zip', meta(page).replace(/ · .*/, '') + ' · Folder · 2\u00a0files']);
    expect(api.crcPass.mock.calls.at(-1)?.[0].map(found => (found as File).name)).toEqual(['a.txt', 'b.txt']);
    await drop([{ kind: 'file', webkitGetAsEntry: () => entry }, { kind: 'file', webkitGetAsEntry: () => file('c.txt', 'c') }]);
    expect(page.text('file-error')).toBe('Choose one file at a time. Put multiple files in an archive first.');
  });

  it('where the browser can pick folders, several files are pointed to a folder, and a folder input that lists plain files says so', async () => {
    const page = await open('https://fyl.at/', (doc: Doc) => { const create = doc.createElement.bind(doc); doc.createElement = () => Object.assign(create(), { webkitdirectory: false }); },
      // @ts-expect-error: browser scripts without type declarations.
      () => import('../dist/i18n.js').then(() => import('../dist/zip.js')).then(() => import('../dist/app.js')));
    // The zone says "file or folder", and its picker opens the menu (Choose a file, Choose a folder) instead of the file picker.
    const picker = page.el('pick-file');
    // Until something is chosen, Upload says what it waits for: a file or a folder.
    expect([page.button(), page.el('create-button').getAttribute('aria-label')]).toEqual(['Choose a file or folder first', 'Choose a file or folder first']);
    expect([page.doc.documentElement.classList.contains('no-folders'), picker.getAttribute('aria-haspopup'), picker.getAttribute('popovertarget'), picker.dataset.align]).toEqual([false, 'menu', 'pick-menu', 'center']);
    let clicked = 0;
    page.el('file-input').click = () => { clicked++; };
    await page.el('pick-file').fire('click'); expect(clicked).toBe(0);
    await page.el('pick-menu-file').fire('click'); expect(clicked).toBe(1);
    await page.win.fire('drop', { dataTransfer: { types: ['Files'], files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], items: [] } });
    expect(page.text('file-error')).toBe('Choose one file at a time. For several, put them in a folder and drop the folder here.');
    // A browser that ignores webkitdirectory hands over the files themselves, without a folder in their path.
    await pick(page, [inFolder('a.txt'), inFolder('b.txt')]);
    expect([page.text('file-error'), page.el('dropzone').hidden, api.crcPass.mock.calls.length]).toEqual(['This browser can’t choose folders. Zip the folder first, or drag it here.', false, 0]);
  });

  it('encrypts a folder like a file: its zip goes through the encrypted upload after the CRC pass, and the receipt carries the key', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const KEY = 'yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4', link = `https://fyl.at/d/${U}`;
    api.crcPass.mockResolvedValueOnce([0x363a3020, 0x2c2c2a2a]);
    const page = await openFolders();
    await pick(page, photos());
    page.el('e2ee-toggle').checked = true; await page.el('e2ee-toggle').fire('change'); await settle();
    expect(page.text('cli-upload-command')).toBe("fyl './photos' --encrypt");
    api.upload.mockImplementationOnce(async (_file, _options, _controller, _progress, resume, onSession) => {
      await onSession({ ...(resume || { uploadId: U, key: K, url: link }), e2eeKey: KEY, share: `${link}#${KEY}` } as Session);
      return { ...receipt(), name: 'photos.zip', url: link, mode: 'e2ee', e2eeKey: KEY };
    });
    void page.el('create-button').fire('click');
    await until(() => expect(page.doc.getElementById('main').dataset.view).toBe('receipt'), 100);
    const [zip, options] = api.upload.mock.calls[0] as unknown as [File, { e2ee: boolean; folder: { crcs: number[]; ranges: number[][] } }];
    expect([zip.name, options.e2ee, options.folder.crcs, options.folder.ranges.length]).toEqual(['photos.zip', true, [0x363a3020, 0x2c2c2a2a], 2]);
    expect(api.crcPass).toHaveBeenCalledTimes(1);
    expect([page.el('link-url').dataset.copy, meta(page)]).toEqual([`${link}#${KEY}`, expect.stringContaining('Encrypted')]);
    expect(session.json('fyl-keys')).toEqual({ [U]: KEY });
    expect([...local.items.values()].join('\n')).not.toContain(KEY);
  });
});

// End-to-end encryption on the upload page (docs/E2EE.md §2.5, §7, §8.4). FylAPI is scripted here; the client itself is
// tested in web-client.test.ts.
describe('end-to-end encryption on the upload page', () => {
  const KEY = 'yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4', plainLink = `https://fyl.at/d/${U}`, share = `${plainLink}#${KEY}`;
  type Records = { get(id: string): Record<number, string>; put(id: string, part: number, md5: string): boolean | 'replaced' };
  const encryptedReceipt = () => ({ ...receipt(), url: plainLink, name: 'a.bin', size: 16, mode: 'e2ee', e2eeKey: KEY });
  // FylAPI.upload as the encrypted client runs it: the session with the keyed link first, then `then`.
  const encrypting = (then: (records: Records) => unknown): Upload => async (_file, options, _controller, _progress, resume, onSession) => {
    await onSession({ ...(resume || { uploadId: U, key: K, url: plainLink }), e2eeKey: KEY, share } as Session);
    return then((options as { records: Records }).records);
  };
  const turnOn = async (page: Page) => { page.el('e2ee-toggle').checked = true; await page.el('e2ee-toggle').fire('change'); await settle(); };
  const stored = () => [...local.items.values()].join('\n');
  async function uploaded() {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openApp();
    await choose(page, file());
    await turnOn(page);
    api.upload.mockImplementationOnce(encrypting(() => encryptedReceipt()));
    void page.el('create-button').fire('click');
    await until(() => expect(page.doc.getElementById('main').dataset.view).toBe('receipt'), 100);
    return page;
  }

  it('stays hidden without the Worker\'s switch', async () => {
    const page = await openApp();
    expect(page.el('e2ee-option').hidden).toBe(true);
    config = { maxFileBytes: 53687091200, e2ee: 'yes' };
    expect((await openApp()).el('e2ee-option').hidden).toBe(true);
  });

  it('encrypts when on: the keyed link shows, the key stays in this tab, and no stored record holds it', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openApp();
    expect(page.el('e2ee-option').hidden).toBe(false);
    await choose(page, file());
    await turnOn(page);
    expect(page.text('cli-upload-command')).toBe("fyl './a.bin' --encrypt");
    let pending: unknown = null;
    api.upload.mockImplementationOnce(encrypting(records => {
      // Each part's MD5 goes into the pending upload's record before it is pinned (§8.2); the key never does.
      expect(records.put(U, 1, 'a'.repeat(32))).toBe(true);
      pending = local.json('fyl-upload');
      return encryptedReceipt();
    }));
    void page.el('create-button').fire('click');
    await until(() => expect(page.doc.getElementById('main').dataset.view).toBe('receipt'), 100);
    expect(api.upload.mock.calls[0][1]).toMatchObject({ e2ee: true });
    expect(pending).toMatchObject({ uploadId: U, e2ee: true, md5: { 1: 'a'.repeat(32) }, url: plainLink });
    expect(JSON.stringify(pending)).not.toContain(KEY);
    expect(page.el('link-url').dataset.copy).toBe(share);
    // The field cuts the key like the key rows do (screens get shared); the link's target and the clipboard keep it whole.
    expect(page.el('link-url').innerHTML).toContain(`<span class="key">#${KEY.slice(0, 3)}…${KEY.slice(-4)}</span>`);
    expect(page.el('link-url').getAttribute('href')).toBe(share);
    expect([page.el('keysplit').hidden, page.el('keywarn').hidden, page.el('keyremember').hidden]).toEqual([false, false, false]);
    // The link with the key is the default; the "Safest: …" line opens the two parts (like MEGA) and closes them again.
    expect([page.el('keyrows-wrap').classList.contains('open'), page.el('key-split').getAttribute('aria-expanded')]).toEqual([false, 'false']);
    await page.el('key-split').fire('click');
    expect([page.el('keyrows-wrap').classList.contains('open'), page.el('key-split').getAttribute('aria-expanded')]).toEqual([true, 'true']);
    await page.el('key-split').fire('click');
    expect(page.el('keyrows-wrap').classList.contains('open')).toBe(false);
    // The key rows hold the link without the key and the key, without tooltips; the terminal companion's command has no key.
    expect([page.el('key-nokey').dataset.full, page.el('key-key').dataset.full, page.el('key-key').innerHTML.includes('title=')]).toEqual([plainLink.replace('https://', ''), KEY, false]);
    expect(page.el('file-curl').innerHTML).not.toContain(KEY);
    expect(page.el('copy-menu').innerHTML).toContain('data-menu-copy="nokeycli"');
    expect(page.el('selected-size').innerHTML).toContain('Encrypted');
    expect(session.json('fyl-keys')).toEqual({ [U]: KEY });
    expect(local.json('fyl-recent')).toMatchObject([{ id: U, url: plainLink, mode: 'e2ee', name: 'a.bin', size: 16 }]);
    expect(stored()).not.toContain(KEY);
  });

  it('copies the link with or without the key, the key and both terminal commands, and only what holds the key ends the warning', async () => {
    const page = await uploaded();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { locks, clipboard: { writeText } });
    const menu = (name: string) => page.el('copy-menu').fire('click', { target: page.find('copy-menu', 'data-menu-copy', name) });
    for (const name of ['nokey', 'nokeycli', 'key', 'curl', 'link']) await menu(name);
    expect(writeText.mock.calls.map(([text]) => text)).toEqual([plainLink, `fyl download '${plainLink}'`, KEY, `fyl download '${share}'`, share]);
    // Leaving the tab asks first until something with the key was copied.
    const page2 = await uploaded();
    const leave = async () => { let asked = false; await page2.win.fire('beforeunload', { preventDefault: () => { asked = true; } }); return asked; };
    vi.stubGlobal('navigator', { locks, clipboard: { writeText } });
    expect(await leave()).toBe(true);
    await page2.el('copy-menu').fire('click', { target: page2.find('copy-menu', 'data-menu-copy', 'nokey') });
    expect(await leave()).toBe(true);
    await page2.el('copy-menu').fire('click', { target: page2.find('copy-menu', 'data-menu-copy', 'key') });
    expect(await leave()).toBe(false);
  });

  it('keeps every element that shows the key out of machine translation on the upload page', async () => {
    const page = await uploaded();
    const { holders, translated } = await untranslated(page, KEY, '/');
    expect(holders).toEqual(expect.arrayContaining(['key-key']));
    expect(translated).toEqual([]);
    // The link field shows only a cut key but carries the whole link in its target.
    expect(await (await env.ASSETS.fetch('https://fyl.at/en/')).text()).toMatch(/<a class="url notranslate" id="link-url"[^>]*\btranslate="no"/);
  });

  it('keeps keys in local storage only while "Remember keys on this device" is ticked, and forgets them with the device', async () => {
    let page = await uploaded();
    page.el('remember-keys').checked = true;
    await page.el('remember-keys').fire('change');
    expect([local.json('fyl-keys'), local.getItem('fyl-remember-keys')]).toEqual([{ [U]: KEY }, '1']);
    // Another tab: the key comes from local storage, the name from this browser's record (the server has none).
    session.items.clear();
    api.info.mockResolvedValue({ ...owned(U, { url: plainLink, mode: 'e2ee', size: 216 }), name: null });
    page = await openApp(`#manage/${U}/${K}`);
    expect([page.el('link-url').dataset.copy, page.text('selected-name') || page.el('selected-name').innerHTML]).toEqual([share, 'a.bin']);
    expect(local.json('fyl-recent')[0]).toMatchObject({ name: 'a.bin', size: 16 });
    page.el('remember-keys').checked = false;
    await page.el('remember-keys').fire('change');
    expect([local.getItem('fyl-keys'), local.getItem('fyl-remember-keys'), session.json('fyl-keys')]).toEqual([null, null, { [U]: KEY }]);
    page.el('remember-keys').checked = true;
    await page.el('remember-keys').fire('change');
    await page.doc.fire('click', { target: page.el('forget-all') });
    await page.el('confirm-forget').fire('click');
    expect([local.getItem('fyl-keys'), local.getItem('fyl-remember-keys'), session.getItem('fyl-keys')]).toEqual([null, null, null]);
  });

  it('shows a tab without the key the link without it, and says that only the copied link opens the file', async () => {
    await uploaded();
    session.items.clear();
    api.info.mockResolvedValue({ ...owned(U, { url: plainLink, mode: 'e2ee', size: 216 }), name: null });
    const page = await openApp(`#manage/${U}/${K}`);
    expect([page.el('link-url').dataset.copy, page.el('keysplit').hidden, page.el('keywarn').hidden]).toEqual([plainLink, true, false]);
    expect(page.text('keywarn-text')).toMatch(/^This tab doesn’t have the key/);
    expect(page.el('copy-menu').innerHTML).not.toContain('data-menu-copy="key"');
    expect(page.el('file-curl').innerHTML).toContain('fyl download');
  });

  it('resumes an encrypted upload with its key, asking for the link or key in a tab that doesn\'t have it', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    let page = await openApp();
    await choose(page, file());
    await turnOn(page);
    api.upload.mockImplementationOnce(encrypting(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    expect(page.text('form-error')).toBe(RESUME_HINT);
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U, e2ee: true });
    // A new tab has no key: the form asks for the link or the key, and checks its form before resuming.
    session.items.clear(); api.upload.mockClear();
    page = await openApp();
    await choose(page, file());
    await turnOn(page);
    expect([page.button(), page.el('resume-key-wrap').hidden]).toEqual(['Resume upload', false]);
    for (const [entry, message] of [['', 'Paste the link or the key you got when this upload started.'], ['not a key', 'Paste the link or the key you got when this upload started.'],
      [`https://fyl.at/d/${'w'.repeat(43)}#${KEY}`, 'This link is for another upload. Paste the link you got when this one started.']]) {
      page.el('resume-key').value = entry;
      await page.el('create-button').fire('click');
      expect([page.text('form-error'), api.upload.mock.calls.length]).toEqual([message, 0]);
    }
    page.el('resume-key').value = ` ${share} `;
    api.upload.mockImplementationOnce(encrypting(() => encryptedReceipt()));
    void page.el('create-button').fire('click');
    await until(() => expect(page.doc.getElementById('main').dataset.view).toBe('receipt'), 100);
    expect(api.upload.mock.calls[0][4]).toMatchObject({ uploadId: U, key: K, url: plainLink, e2eeKey: KEY });
    expect(page.el('link-url').dataset.copy).toBe(share);
  });

  it('keeps the unfinished upload after a refusal and says why, and refuses records it can\'t keep', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openApp();
    await choose(page, file());
    await turnOn(page);
    const answers: (boolean | 'replaced')[] = [];
    api.upload.mockImplementationOnce(encrypting(records => {
      answers.push(records.put(U, 1, 'a'.repeat(32)), records.put(U, 1, 'b'.repeat(32)));
      local.refuse.add('fyl-upload');
      answers.push(records.put(U, 2, 'c'.repeat(32)));
      local.refuse.clear();
      throw Object.assign(new Error('The file changed since this upload started. Start a new upload.'), { kind: 'refused', code: 'file_changed' });
    }));
    await page.el('create-button').fire('click');
    await settle();
    expect(answers).toEqual([true, false, false]);
    expect([page.doc.getElementById('main').dataset.view, page.text('form-error')]).toEqual(['setup', 'The file changed since this upload started. Start a new upload.']);
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U, e2ee: true, md5: { 1: 'a'.repeat(32) } });
    expect(api.discard).not.toHaveBeenCalled();
  });

  it('stops and discards an encrypted upload whose record an upload started in another tab replaced, as 2.3.0 does', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openApp();
    await choose(page, file());
    await turnOn(page);
    const answers: unknown[] = [];
    let release = () => {};
    api.upload.mockImplementationOnce(encrypting(records => {
      answers.push(records.put(U, 1, 'a'.repeat(32)));
      // Another tab, which sees this upload running here, starts its own: it holds that upload's lock and its record
      // takes the place of this one's.
      release = locks.take('fyl-upload:' + U2);
      local.setItem('fyl-upload', JSON.stringify({ ...local.json('fyl-upload'), uploadId: U2, key: R, lock: 'fyl-upload:' + U2, md5: {} }));
      answers.push(records.put(U, 2, 'b'.repeat(32)));
      // What FylAPI.upload makes of that answer: it stops like an interrupted upload (tests/web-client.test.ts).
      throw Object.assign(new Error('The upload was interrupted, and an upload started in another tab has replaced it. Start it again.'),
        { kind: 'replaced', code: 'record_replaced', resumable: true });
    }));
    await page.el('create-button').fire('click');
    await settle();
    expect(answers).toEqual([true, 'replaced']);
    expect([page.doc.getElementById('main').dataset.view, page.text('form-error')])
      .toEqual(['setup', 'The upload was interrupted, and an upload started in another tab has replaced it. Start it again.']);
    // Without its record it can never be resumed, so its session goes; the other tab's record stays as it was.
    expect(api.discard).toHaveBeenCalledExactlyOnceWith({ uploadId: U, key: K });
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U2, key: R, md5: {} });
    release();
  });

  it('keeps the name and the file\'s own size of an encrypted upload when the server answers without them', async () => {
    store(record(U, { mode: 'e2ee', name: 'secret.pdf', size: 16, url: plainLink }));
    api.info.mockResolvedValue({ ...owned(U, { url: plainLink, mode: 'e2ee', size: 216 }), name: null });
    const page = await openApp();
    await page.idle();
    expect(local.json('fyl-recent')[0]).toMatchObject({ name: 'secret.pdf', size: 16, mode: 'e2ee' });
    expect(page.el('recent-list').innerHTML).toContain('secret.pdf');
    expect(page.el('recent-list').innerHTML).toContain('Encrypted');
  });
});

describe('the link while the file uploads', () => {
  type Progress = (value: number | null, stage: string, sent?: number, step?: string) => void;
  it('greys while a part is retried and says so, then goes on to the ready beat', async () => {
    const page = await openApp();
    await choose(page, file());
    let progress: Progress = () => {}, done: (value: unknown) => void = () => {};
    api.upload.mockImplementationOnce(async (_file, _options, _controller, onProgress, _resume, onSession) => {
      progress = onProgress as Progress;
      await onSession({ uploadId: U, key: K, url: `https://fyl.at/d/${U}/a.bin` });
      return new Promise(resolve => { done = resolve; });
    });
    void page.el('create-button').fire('click');
    await settle();
    expect(page.el('link-url').innerHTML).toBe(`<span class="host">fyl.at/d/</span><span class="id">${U}</span><span class="sep">/</span><bdi class="name" dir="auto">a.bin</bdi>`);
    expect(page.el('copy-inline').hidden).toBe(false);
    expect([page.text('cancel-button'), page.el('cancel-button').classList.contains('btn-cancel')]).toEqual(['Cancel upload', true]);
    // The link is a real link while the file uploads (recipients can open it now).
    expect(page.el('link-url').getAttribute('href')).toBe(`https://fyl.at/d/${U}/a.bin`);
    expect([page.text('head-a'), page.text('mt-then'), page.el('lo-actions').hidden]).toEqual(['Your link works already', 'Then open for 1 day', false]);
    // "This file in a terminal" appears with the link, while the file still uploads.
    expect(page.el('side-file').hidden).toBe(false);
    progress(null, 'Connection interrupted. Retrying…', undefined, 'retrying');
    expect([page.el('lo').classList.contains('stalled'), page.text('head-a'), page.text('chip-a'), page.text('mt-then')]).toEqual([true, 'Upload paused', 'Paused', 'Waiting for the network']);
    expect(page.text('live-status')).toBe('Upload paused. It continues when the connection is back.');
    progress(40, 'Uploading your file', 6, 'uploading');
    expect([page.el('lo').classList.contains('stalled'), page.text('head-a'), page.text('mt-main'), page.text('mt-sub')]).toEqual([false, 'Your link works already', '40 %', '6 of 16\u00a0bytes']);
    done(receipt());
    await until(() => expect(page.el('lo').classList.contains('ready')).toBe(true));
    // Cancel upload fades in place at the ready beat (the panel keeps its height) and goes with the receipt.
    expect([page.el('cancel-button').disabled, page.el('cancel-row').classList.contains('leaving')]).toEqual([true, true]);
    // The receipt's sections enter once, right after the ready beat; drawn again after a reload they just appear.
    await until(() => expect(page.el('receipt-view').innerHTML).toContain('<section class="private enter d1"'), 100);
    expect([page.el('cancel-row').hidden, page.el('cancel-row').classList.contains('leaving')]).toEqual([true, false]);
    api.info.mockResolvedValue(owned(U, { name: 'a.bin' }));
    const again = await openApp(`#manage/${U}/${K}`);
    expect(again.el('receipt-view').innerHTML).toContain('<section class="private" aria-labelledby="private-heading">');
    expect(again.el('receipt-view').innerHTML).not.toContain(' enter');
  });

  it('waits for the network in place when the retries run out offline, and resumes once it is back', async () => {
    const page = await openApp();
    await choose(page, file());
    vi.stubGlobal('navigator', { locks, onLine: false });
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    // Still the link object, paused, with Retry now; the upload is kept for a resume.
    expect([page.doc.getElementById('main').dataset.view, page.el('lo').classList.contains('stalled'), page.text('head-a'), page.el('retry-now').hidden, page.text('mt-then')])
      .toEqual(['progress', true, 'Upload paused', false, 'Waiting for the network']);
    expect(page.text('form-error')).toBe('');
    expect(local.json('fyl-upload')).toMatchObject({ uploadId: U, key: K });
    // Retry now while still offline: interrupted again, waiting again.
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('retry-now').fire('click');
    await settle();
    expect(api.upload.mock.calls[1][4]).toEqual({ uploadId: U, key: K, url: `https://fyl.at/d/${U}` });
    expect([page.doc.getElementById('main').dataset.view, page.el('retry-now').hidden]).toEqual(['progress', false]);
    // Back online: the upload resumes by itself, its link shown at once, and finishes.
    vi.stubGlobal('navigator', { locks, onLine: true });
    let done: (value: unknown) => void = () => {};
    api.upload.mockImplementationOnce(started(() => new Promise(resolve => { done = resolve; })));
    void page.win.fire('online');
    await settle();
    expect([page.el('retry-now').hidden, page.text('live-status')]).toEqual([true, 'Upload resumed. Your link works already.']);
    expect(page.el('link-url').innerHTML).toContain(U);
    done(receipt());
    await until(() => expect(page.el('lo').classList.contains('ready')).toBe(true), 100);
    expect(api.upload.mock.calls[2][4]).toEqual({ uploadId: U, key: K, url: `https://fyl.at/d/${U}` });
    await until(() => expect(local.getItem('fyl-upload')).toBeNull());
  });

  it('discards an upload waiting for the network when it is cancelled, and won’t resume one another tab replaced', async () => {
    let page = await openApp();
    await choose(page, file());
    vi.stubGlobal('navigator', { locks, onLine: false });
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    await page.el('cancel-button').fire('click');
    await settle();
    expect([page.doc.getElementById('main').dataset.view, local.getItem('fyl-upload')]).toEqual(['setup', null]);
    expect(api.discard).toHaveBeenCalledWith({ uploadId: U, key: K });
    page = await openApp();
    await choose(page, file());
    vi.stubGlobal('navigator', { locks, onLine: false });
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await page.el('create-button').fire('click');
    local.setItem('fyl-upload', JSON.stringify({ ...local.json('fyl-upload'), uploadId: U2 }));
    await page.win.fire('online');
    await settle();
    expect([page.doc.getElementById('main').dataset.view, page.text('form-error')]).toEqual(['setup', 'The unfinished upload changed in another tab. Choose the file again.']);
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('shows that the link won’t work when the upload fails for good, keeps the file and uploads again from there', async () => {
    const page = await openApp();
    await choose(page, file());
    api.upload.mockImplementationOnce(started(() => { throw fail(413, 'too_large', 'This file is too large.'); }));
    await page.el('create-button').fire('click');
    expect([page.el('lo').classList.contains('failed'), page.text('head-a'), page.text('chip-a'), page.el('lo-actions').hidden, page.el('upload-again').hidden, page.text('cancel-button')])
      .toEqual([true, 'Upload failed', 'Failed', true, false, 'Change options']);
    expect(page.text('lo-hint')).toBe('The upload can’t continue, so this link won’t open. Your file and options are kept.');
    // Struck through and no longer a link.
    expect(page.el('link-url').getAttribute('href')).toBeNull();
    expect(page.el('copy-inline').hidden).toBe(true);
    // "Change options" is a quiet button again, not the red cancel.
    expect(page.el('cancel-button').classList.contains('btn-cancel')).toBe(false);
    expect(page.el('side-file').hidden).toBe(true);
    expect(local.getItem('fyl-upload')).toBeNull();
    api.upload.mockImplementationOnce(started(receipt));
    void page.el('upload-again').fire('click');
    await until(() => expect(page.el('lo').classList.contains('ready')).toBe(true), 100);
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('goes back to the form on Cancel upload, keeping the file and options, and on Change options after a failure', async () => {
    const page = await openApp();
    await choose(page, file());
    const seen: { signal?: AbortSignal } = {};
    api.upload.mockImplementationOnce(async (_file, _options, controller, _progress, _resume, onSession) => {
      seen.signal = controller.signal;
      await onSession({ uploadId: U, key: K, url: `https://fyl.at/d/${U}/a.bin` });
      return new Promise((_resolve, reject) => { controller.signal.addEventListener('abort', () => reject(new DOMException('Upload cancelled.', 'AbortError'))); });
    });
    void page.el('create-button').fire('click');
    await settle();
    expect(page.doc.getElementById('main').dataset.view).toBe('progress');
    await page.el('cancel-button').fire('click');
    await settle();
    expect([seen.signal?.aborted, page.doc.getElementById('main').dataset.view, page.el('chosen-file').hidden, page.button(), page.text('live-status')])
      .toEqual([true, 'setup', false, 'Upload and get link', 'Upload cancelled. Your file and options are kept.']);
    expect(local.getItem('fyl-upload')).toBeNull();
    // A failure after the link was shown: Change options is the same button and leads back to the form too.
    api.upload.mockImplementationOnce(started(() => { throw fail(409, 'part_limit', 'This part has reached its retry limit.'); }));
    await page.el('create-button').fire('click');
    expect([page.el('lo').classList.contains('failed'), page.text('cancel-button')]).toEqual([true, 'Change options']);
    await page.el('cancel-button').fire('click');
    await settle();
    expect([page.doc.getElementById('main').dataset.view, page.el('chosen-file').hidden, page.button()]).toEqual(['setup', false, 'Upload and get link']);
  });

  it('shows a percent-encoded name as written, and still copies the encoded link', async () => {
    const page = await openApp();
    await choose(page, new File(['fyl.at test file'], 'Wiśniewska überarbeitet.pdf', { lastModified: NOW - DAY }));
    const url = `https://fyl.at/d/${U}/Wi%C5%9Bniewska%20%C3%BCberarbeitet.pdf`;
    api.upload.mockImplementationOnce(async (_file, _options, _controller, _progress, _resume, onSession) => {
      await onSession({ uploadId: U, key: K, url });
      return new Promise(() => {});
    });
    void page.el('create-button').fire('click');
    await settle();
    // The name shows as written, not percent-encoded (the field cuts it only when it is too narrow).
    expect(page.el('link-url').innerHTML).toBe(`<span class="host">fyl.at/d/</span><span class="id">${U}</span><span class="sep">/</span><bdi class="name" dir="auto">Wiśniewska überarbeitet.pdf</bdi>`);
    expect(page.el('link-url').getAttribute('href')).toBe(url);
    expect(page.el('copy-menu').innerHTML).toContain('…erarbeitet.pdf</small>');
    expect(page.el('copy-menu').innerHTML).not.toContain('%C3');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { locks, clipboard: { writeText } });
    await page.el('copy-link').fire('click');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
    // The copy button at the end of the field copies the same link.
    await page.el('copy-inline').fire('click');
    expect(writeText).toHaveBeenLastCalledWith(url);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('goes back to the form, with the reason, when the upload is refused before its link exists', async () => {
    const page = await openApp();
    await choose(page, file());
    api.upload.mockImplementationOnce(async () => { throw fail(400, 'invalid_size', 'This file is too large.'); });
    await page.el('create-button').fire('click');
    expect([page.doc.getElementById('main').dataset.view, page.text('form-error'), page.button()]).toEqual(['setup', 'This file is too large.', 'Upload and get link']);
  });

  it('names an expiry it can’t use and keeps Upload off until it is fixed', async () => {
    const page = await openApp();
    await choose(page, file());
    page.doc.querySelector('input[name="lifetime"]:checked').value = 'custom';
    page.el('custom-minutes').value = '2'; page.el('custom-unit').value = '1';
    await page.el('custom-minutes').fire('input');
    expect([page.el('expiry-summary').innerHTML, page.button(), page.el('create-button').disabled])
      .toEqual(['<span class="err-text">2 minutes is too short. Choose at least 5 minutes.</span>', 'Set an expiry from 5 min to 7 days', true]);
    page.el('custom-minutes').value = '8'; page.el('custom-unit').value = '1440';
    await page.el('custom-minutes').fire('input');
    expect(page.el('expiry-summary').innerHTML).toBe('<span class="err-text">8 days is too long. Choose 7 days or less.</span>');
    page.el('custom-minutes').value = '45'; page.el('custom-unit').value = '1';
    await page.el('custom-minutes').fire('input');
    expect([page.el('expiry-summary').innerHTML, page.button()]).toEqual(['Expires <strong>45 minutes</strong> after the upload.', 'Upload and get link']);
  });
});

describe('the live command beside the form', () => {
  // The elements the page creates from now on, so a test sees what is added and what is only rewritten.
  const track = (page: Page) => {
    const made: El[] = [], create = page.doc.createElement.bind(page.doc);
    page.doc.createElement = () => { const element = create(); made.push(element); return element; };
    return made;
  };
  const expiry = async (page: Page, amount: string, unit: string) => {
    page.doc.querySelector('input[name="lifetime"]:checked').value = 'custom';
    page.el('custom-minutes').value = amount; page.el('custom-unit').value = unit;
    await page.el('custom-minutes').fire('input');
  };

  it('rewrites a changed flag in place and adds a new one, so nothing already shown is drawn again or blinks', async () => {
    const page = await openApp();
    await choose(page, file());
    const made = track(page);
    await expiry(page, '3', '1440');
    // One flag appeared: its wrapper and the flag itself, which fades in once.
    expect(made).toHaveLength(2);
    const [, flag] = made;
    expect([flag.textContent, flag.className]).toEqual(['--expires 3d', 'flag new']);
    // 3 days to 7 days: the same element gets the new value; nothing is created.
    await expiry(page, '7', '1440');
    expect(made).toHaveLength(2);
    expect(flag.textContent).toBe('--expires 7d');
    page.el('once-toggle').checked = true;
    await page.el('once-toggle').fire('change');
    expect(made.map(element => element.textContent)).toEqual(['', '--expires 7d', '', '--once']);
    expect(page.text('cli-upload-command')).toBe("fyl './a.bin' --expires 7d --once");
  });

  it('fades a flag in only the first time, so passing through 1 day or an unfinished value brings it back without a blink', async () => {
    const page = await openApp();
    await choose(page, file());
    await expiry(page, '7', '1440');
    const made = track(page);
    // 1 day is the default, so the flag goes; coming back it is simply there.
    await expiry(page, '1', '1440');
    expect(page.text('cli-upload-command')).toBe("fyl './a.bin'");
    await expiry(page, '3', '1440');
    // The field cleared while typing a new value: the command keeps the default, then the flag returns as it went.
    await expiry(page, '', '60');
    await expiry(page, '4', '60');
    expect(made.filter(element => element.textContent).map(element => [element.textContent, element.className])).toEqual([['--expires 3d', 'flag'], ['--expires 4h', 'flag']]);
    expect(page.text('cli-upload-command')).toBe("fyl './a.bin' --expires 4h");
  });
});

// The options (DESIGN.md, Options): a toggle per option, a section in the block under them for each one that is on, in
// the toggles' order, and with none on the line "Anyone with the link…" instead (#option-details without .any).
describe('the options under the form', () => {
  const toggle = async (page: Page, name: string, on: boolean) => {
    page.el(name + '-toggle').checked = on; await page.el(name + '-toggle').fire('change'); await settle();
  };
  const sections = (page: Page) => ['once-wrap', 'password-wrap', 'e2ee-wrap'].filter(id => page.el(id).classList.contains('open'));
  const block = (page: Page) => page.el('option-details').classList.contains('any');

  it('opens a section for each option that is on and shows the line only while none is', async () => {
    config = { maxFileBytes: 53687091200, e2ee: true };
    const page = await openApp();
    expect([sections(page), block(page)]).toEqual([[], false]);
    await toggle(page, 'password', true);
    expect([sections(page), block(page), page.el('password-input').value]).toEqual([['password-wrap'], true, 'tide-lamp-fern-41']);
    await toggle(page, 'e2ee', true); await toggle(page, 'once', true);
    expect([sections(page), block(page)]).toEqual([['once-wrap', 'password-wrap', 'e2ee-wrap'], true]);
    expect(page.text('cli-upload-command')).toBe('fyl ./archive.zip --once --password --encrypt');
    await toggle(page, 'password', false); await toggle(page, 'once', false);
    expect([sections(page), block(page)]).toEqual([['e2ee-wrap'], true]);
    await toggle(page, 'e2ee', false);
    expect([sections(page), block(page), page.text('cli-upload-command')]).toEqual([[], false, 'fyl ./archive.zip']);
  });

  it('hides the encryption toggle and its section without the Worker\'s switch, and never opens that section', async () => {
    const page = await openApp();
    expect([page.el('e2ee-option').hidden, page.el('e2ee-wrap').hidden]).toEqual([true, true]);
    // The hidden toggle ticked (as a resumed encrypted upload does): its section and the block stay closed.
    await toggle(page, 'e2ee', true);
    expect([sections(page), block(page), page.text('cli-upload-command')]).toEqual([[], false, 'fyl ./archive.zip']);
    await toggle(page, 'once', true);
    expect([sections(page), block(page)]).toEqual([['once-wrap'], true]);
    config = { maxFileBytes: 53687091200, e2ee: true };
    const shown = await openApp();
    expect([shown.el('e2ee-option').hidden, shown.el('e2ee-wrap').hidden]).toEqual([false, false]);
  });

  it('opens the sections of the options an unfinished upload brings back when its file is chosen again', async () => {
    const first = await openApp();
    await choose(first, file());
    await toggle(first, 'once', true); await toggle(first, 'password', true);
    api.upload.mockImplementationOnce(started(() => { throw interrupted(); }));
    await first.el('create-button').fire('click');
    expect(first.text('form-error')).toBe(RESUME_HINT);
    const page = await openApp();
    expect([sections(page), block(page)]).toEqual([[], false]);
    await choose(page, file());
    expect([page.button(), sections(page), block(page), page.el('password-input').value]).toEqual(['Resume upload', ['once-wrap', 'password-wrap'], true, 'tide-lamp-fern-41']);
  });

  it('builds each toggle as a native checkbox followed by its face, with no role=switch, and opens "Why?" in a new tab', async () => {
    const markup = await (await env.ASSETS.fetch('https://fyl.at/en/')).text();
    // The face follows the checkbox, so the on state is styled with input:checked + .opt-face (styles.css), not :has().
    for (const name of ['once', 'password', 'e2ee']) {
      expect(markup).toMatch(new RegExp(`<label class="opt-toggle"[^>]*><input type="checkbox" id="${name}-toggle" aria-describedby="${name}-description" aria-controls="${name}-wrap"><span class="opt-face">`));
      expect(markup).toMatch(new RegExp(`<div class="reveal opt-sec" id="${name}-wrap"[^>]*>`));
    }
    expect(markup).not.toContain('role="switch"');
    // A new tab, so the chosen file and options stay where they are.
    expect(markup).toMatch(/<p class="hint" id="e2ee-hint">[^<]*<a href="\/en\/privacy#encrypted" target="_blank" rel="noopener">Why\?<\/a><\/p>/);
  });
});

describe('the management link', () => {
  it('says the link is loading, instead of showing the empty form, until the owner info answers', async () => {
    let answer: (value: unknown) => void = () => {};
    api.info.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const page = await openApp(`#manage/${R}/${K}`);
    const state = () => [page.doc.getElementById('main').dataset.view, page.el('transfer').getAttribute('aria-busy'), page.el('setup-view').hidden, page.el('tool-head').hidden];
    expect([...state(), page.text('head-a')]).toEqual(['loading', 'true', true, false, 'Loading your link…']);
    answer(owned(R));
    await settle();
    expect(state()).toEqual(['receipt', null, true, false]);
  });

  it('breaks a file name at its separators but never right before the extension', async () => {
    const page = await openApp();
    await choose(page, new File(['fyl.at test file'], 'site-photos-2026-10.zip', { lastModified: NOW - DAY }));
    expect(page.el('selected-name').innerHTML).toBe('site-<wbr>photos-<wbr>2026-<wbr>10.zip');
  });
});

describe('recent uploads as a board', () => {
  it('lists live links first with the time left rounded down, and closed ones after with the reason', async () => {
    store(record(U, { expiresAt: Date.now() + 3 * DAY - 1000, createdAt: Date.now() }), record(D, { state: 'consumed', once: true }),
      record(R, { expiresAt: Date.now() + 90 * MINUTE - 1, protected: true }));
    const page = await openApp(), html = page.el('recent-list').innerHTML;
    // Newest first among the live ones (R, then U); the used one (D) below them.
    expect([...html.matchAll(/data-record="([a-z])/g)].map(match => match[1])).toEqual(['r', 'u', 'd']);
    expect([...html.matchAll(/data-status="([a-z]+)"/g)].map(match => match[1])).toEqual(['ready', 'ready', 'consumed']);
    expect(html).toContain(`<span data-countdown="${R}">1 h 29 min left</span>`);
    expect(html).toContain(`<span data-countdown="${U}">2 days 23 h left</span>`);
    expect(html).toContain('<span class="tag-out">Used</span>');
    expect(html).toContain('<span class="sep"><span class="dot" aria-hidden="true">·</span><span>Downloaded once · link closed</span></span>');
    const rows = html.split('<li ');
    expect(rows.find(row => row.includes(`data-record="${D}"`))).not.toContain('One download');
    expect(rows.find(row => row.includes(`data-record="${R}"`))).toContain('<span class="sep"><span class="dot" aria-hidden="true">·</span><span class="on">');
    expect(html).toContain(`aria-label="Manage report.pdf"`);
  });

  it('forgets one upload at once and brings it back with Undo, its password too', async () => {
    store(record(R, { protected: true }), record(U2, { name: 'other.pdf' }));
    session.setItem('fyl-passwords', JSON.stringify({ [R]: 'tide-lamp-fern-41' }));
    const page = await openApp();
    await page.doc.fire('click', { target: page.find('recent-list', 'data-forget', R) });
    expect(local.json('fyl-recent').map((stored: { id: string }) => stored.id)).toEqual([U2]);
    expect(session.getItem('fyl-passwords')).toBeNull();
    expect([page.text('toast-text'), page.el('toast-action').hidden, page.text('live-status')]).toEqual(['Forgot report.pdf on this device.', false, 'Forgot report.pdf on this device.']);
    await page.el('toast-action').fire('click');
    expect(local.json('fyl-recent').map((stored: { id: string }) => stored.id)).toEqual([U2, R]);
    expect(session.json('fyl-passwords')).toEqual({ [R]: 'tide-lamp-fern-41' });
    expect(page.el('recent-list').innerHTML).toContain(`data-record="${R}"`);
  });

  it('brings an encrypted upload\'s key back with Undo too, kept where it was: fyl.at can\'t give it again', async () => {
    const KEY = 'yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4', link = `https://fyl.at/d/${U}`;
    for (const remember of [false, true]) {
      local.items.clear(); session.items.clear();
      store(record(U, { mode: 'e2ee', url: link }));
      session.setItem('fyl-keys', JSON.stringify({ [U]: KEY }));
      if (remember) { local.setItem('fyl-remember-keys', '1'); local.setItem('fyl-keys', JSON.stringify({ [U]: KEY })); }
      const page = await openApp();
      await page.doc.fire('click', { target: page.find('recent-list', 'data-forget', U) });
      expect([local.getItem('fyl-recent'), session.getItem('fyl-keys'), local.getItem('fyl-keys')]).toEqual([null, null, null]);
      await page.el('toast-action').fire('click');
      expect(local.json('fyl-recent')).toMatchObject([{ id: U, mode: 'e2ee', url: link }]);
      expect([session.json('fyl-keys'), local.json('fyl-keys')]).toEqual([{ [U]: KEY }, remember ? { [U]: KEY } : null]);
      // Its receipt shows the keyed link again, not the link without the key.
      api.info.mockResolvedValue({ ...owned(U, { url: link, mode: 'e2ee', size: 216 }), name: null });
      const again = await openApp(`#manage/${U}/${K}`);
      expect([again.el('link-url').dataset.copy, again.el('keysplit').hidden]).toEqual([`${link}#${KEY}`, false]);
    }
  });
});

describe('report form on its page', () => {
  const D_LINK = `https://fyl.at/d/${D}/report.pdf`;
  async function send(page: Page, answer: () => Response) {
    reply = answer;
    page.el('report-link').value = D_LINK; page.el('report-details').value = 'The archive contains a trojan that steals passwords.';
    page.el('report-name').value = 'Alex Example'; page.el('report-email').value = 'alex@example.org'; page.el('report-good-faith').checked = true;
    await page.el('report-form').fire('submit');
    expect(fetcher).toHaveBeenLastCalledWith('/api/reports', expect.objectContaining({ method: 'POST' }));
  }
  const refused = (status: number, code: string, error: string) => () => Response.json({ error, code }, { status });

  it('tells a network at its daily report limit to come back tomorrow, and one over the rate limit to wait a minute, on the report page', async () => {
    for (const [answer, message] of [
      [refused(429, 'report_limit', 'This network has sent too many reports today. Please try again tomorrow.'), 'Your network has sent too many reports today. Please try again tomorrow.'],
      [refused(429, 'rate_limited', 'Too many requests. Please try again shortly.'), 'Too many reports from your network. Please wait a minute and try again.'],
    ] as const) {
      const page = await openReport(`?link=${encodeURIComponent(D_LINK)}`);
      expect(page.el('report-link').value).toBe(D_LINK);
      await send(page, answer);
      expect([page.text('report-error'), page.el('report-error').hidden, page.el('done-view').hidden]).toEqual([message, false, true]);
      expect([page.el('report-submit').disabled, page.el('report-submit').querySelector('span').textContent]).toEqual([false, 'Send report']);
    }
  });

  it('alerts the count of marked fields when sending, and follows quietly while they are fixed', async () => {
    const page = await openReport();
    await page.el('report-form').fire('submit');
    expect([page.el('report-alert').hidden, page.el('report-alert').getAttribute('role'), page.text('report-alert-text')]).toEqual([false, 'alert', 'Check the 5 marked fields.']);
    expect(fetcher).not.toHaveBeenCalled();
    page.el('report-details').value = 'Too short';
    await page.el('report-form').fire('input', { target: { name: 'details' } });
    expect([page.el('report-alert').getAttribute('role'), page.text('report-alert-text')]).toEqual([null, 'Check the 5 marked fields.']);
    page.el('report-name').value = 'Alex Example';
    await page.el('report-form').fire('input', { target: { name: 'name' } });
    expect([page.el('report-alert').getAttribute('role'), page.text('report-alert-text')]).toEqual([null, 'Check the 4 marked fields.']);
    await page.el('report-form').fire('submit');
    expect(page.el('report-alert').getAttribute('role')).toBe('alert');
  });

  it('counts the details against the maximum only, with the minimum as its own line that ticks once it is reached', async () => {
    const page = await openReport();
    const state = () => [page.text('report-count'), page.el('report-details-min').classList.contains('met'), page.el('report-count').classList.contains('over')];
    expect(state()).toEqual(['0 / 4,000', false, false]);
    const type = async (text: string) => { page.el('report-details').value = text; await page.el('report-form').fire('input', { target: { name: 'details' } }); };
    await type('Too short');
    expect(state()).toEqual(['9 / 4,000', false, false]);
    // Never "/ 20" first and "/ 4,000" later: the same counter goes on, and the minimum line turns satisfied.
    await type('The archive contains a trojan.');
    expect(state()).toEqual(['30 / 4,000', true, false]);
    await type('x'.repeat(4001));
    expect(state()).toEqual(['4,001 / 4,000', true, true]);
    // Sent too short, the field still says why.
    await type('Too short');
    await page.el('report-form').fire('submit');
    expect(page.el('report-details-error').querySelector('span').textContent).toBe('Write at least 20 characters. You have 9.');
  });

  it('confirms a report about a file that is already gone without promising to pause it', async () => {
    const accepted = (extra: object) => () => Response.json({ case: 'R-0123456789', received: NOW, ...extra }, { status: 201 });
    for (const [extra, available] of [[{ fileAvailable: false }, false], [{}, true], [{ fileAvailable: true }, true]] as const) {
      const page = await openReport();
      await send(page, accepted(extra));
      expect([page.el('done-view').hidden, page.el('report-view').hidden, page.text('case-id')]).toEqual([false, true, 'R-0123456789']);
      expect([extra, page.el('done-next').hidden, page.el('done-gone').hidden]).toEqual([extra, !available, available]);
      expect(page.text('live-status')).toBe('Report received. Case R-0123456789.' + (available ? '' : ' The file is no longer available.'));
    }
  });
});

describe('download page clock and polling on the page', () => {
  const ready = (changes: Record<string, unknown> = {}) => ({ state: 'ready', id: D, name: 'report.pdf', ext: 'PDF', size: 2048,
    url: `https://fyl.at/d/${D}/report.pdf`, once: false, protected: false, ...changes });
  const status = (changes: Record<string, unknown> = {}) => ({ id: D, state: 'ready', name: 'report.pdf', size: 2048, once: false, protected: false, ...changes });
  const json = (code: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: code, headers });
  const state = (page: Page) => page.doc.documentElement.dataset.state;

  it('counts down on the server clock when this device is two hours off either way', async () => {
    for (const skew of [2 * HOUR, -2 * HOUR]) {
      const server = NOW - skew, page = await openDownload(ready({ now: server, expiresAt: server + HOUR }));
      expect([state(page), page.text('expires-in'), page.text('expires-at')]).toEqual(['ready', '1 h left', `Until Fri 30 Oct, ${skew > 0 ? '11' : '15'}:00`]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks the server when an old page without the server time counts down to zero, and stays open while it may', async () => {
    const server = NOW - 2 * HOUR;
    // The answer's serverTime sets the clock; without it, the Date header does.
    // The Date header has whole seconds, so it is read as half a second later: the time left rounds down to 59 min.
    for (const [answer, left] of [[() => json(200, status({ expiresAt: server + HOUR, serverTime: server })), '1 h left'],
      [() => json(200, status({ expiresAt: server + HOUR }), { Date: new Date(server).toUTCString() }), '59 min left']] as const) {
      reply = answer; fetcher.mockClear();
      const page = await openDownload(ready({ expiresAt: server + HOUR }));
      await until(() => expect(page.text('expires-in')).toBe(left));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe('/api/transfers/' + D);
      expect(state(page)).toBe('ready');
    }
  });

  it('never closes on its own clock: with no server time at all it keeps asking until the server answers 404 or 410', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const server = NOW - 2 * HOUR;
    reply = () => json(200, status({ expiresAt: server + HOUR }));
    const page = await openDownload(ready({ expiresAt: server + HOUR }));
    await until(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await settle();
    expect([state(page), page.text('expires-in')]).toEqual(['ready', 'Expiring now']);
    await vi.advanceTimersByTimeAsync(3000); await settle();
    expect([state(page), fetcher.mock.calls.length]).toEqual(['ready', 2]);
    reply = () => json(410, { error: 'This link has expired.', code: 'expired' });
    await vi.advanceTimersByTimeAsync(4500); await settle();
    expect([state(page), page.text('file-title'), page.text('gone-tag'), fetcher.mock.calls.length]).toEqual(['gone', 'This link has expired', 'Expired', 3]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('asks when the countdown of an open page runs out, and closes only on the server\'s answer', async () => {
    for (const [answer, expected] of [
      [() => json(200, status({ expiresAt: NOW + DAY, serverTime: NOW + 3000 })), ['ready', '23 h 59 min left']],
      [() => json(404, { error: 'This file is not here.', code: 'not_found' }), ['gone', 'This link doesn’t work']],
      [() => json(410, { error: 'This link has been deleted.', code: 'deleted' }), ['gone', 'The sender deleted this file']],
      [() => json(403, { error: 'This file is unavailable while a report about it is reviewed.', code: 'quarantined' }), ['gone', 'This file is under review']],
    ] as const) {
      reply = answer; fetcher.mockClear();
      const page = await openDownload(ready({ now: NOW, expiresAt: NOW + 3000 }));
      expect(page.text('expires-in')).toBe('Under 1 min left');
      await vi.advanceTimersByTimeAsync(2999); await settle();
      expect(fetcher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await settle();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect([state(page), page.text(expected[0] === 'gone' ? 'file-title' : 'expires-in')]).toEqual(expected);
    }
    // A page the server rendered as gone takes its reason too.
    const reviewed = await openDownload({ state: 'gone', reason: 'quarantined' });
    expect([reviewed.text('file-title'), reviewed.text('file-meta'), reviewed.text('gone-tag'), reviewed.text('gone-line'), reviewed.el('gone-life').hidden])
      .toEqual(['This file is under review', 'fyl.at link · paused', 'Under review', 'Paused until a person has checked it', false]);
    // A transfer of a mode only a newer fyl.at serves: the Worker renders it gone with reason unsupported_mode and mode
    // null (docs/E2EE.md §12.2), and the page says so and starts nothing; a poll answering 503 unsupported_mode too.
    const newer = await openDownload({ state: 'gone', id: D, reason: 'unsupported_mode', mode: null, head: null, meta: null });
    expect([state(newer), newer.text('file-title'), newer.text('file-meta'), newer.text('gone-tag'), newer.text('gone-text')])
      .toEqual(['gone', 'This file needs a newer fyl.at', 'fyl.at link', 'Newer format', 'fyl.at can’t open this kind of file yet. Try the link again later.']);
    reply = () => json(503, { error: 'This file needs a newer fyl.at.', code: 'unsupported_mode' }); fetcher.mockClear();
    const polled = await openDownload(ready({ now: NOW, expiresAt: NOW + 3000 }));
    await vi.advanceTimersByTimeAsync(3000); await settle();
    expect([fetcher.mock.calls.length, state(polled), polled.text('file-title')]).toEqual([1, 'gone', 'This file needs a newer fyl.at']);
  });

  it('polls an upload less often while nothing changes, waits as long as a 429 asks, and not at all while hidden', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    reply = () => json(200, status({ state: 'uploading', size: 1000 * MB, received: 0, updatedAt: NOW }));
    let page = await openDownload({ state: 'uploading', id: D, size: 1000 * MB, received: 0, updatedAt: NOW, now: NOW });
    const polls = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); return fetcher.mock.calls.length; };
    expect([await polls(1999), await polls(1)]).toEqual([0, 1]);
    expect([await polls(2999), await polls(1)]).toEqual([1, 2]);
    expect([await polls(4499), await polls(1)]).toEqual([2, 3]);
    reply = () => json(429, { error: 'Too many requests.', code: 'rate_limited' }, { 'Retry-After': '120' });
    expect([await polls(6749), await polls(1)]).toEqual([3, 4]);
    expect([await polls(119999), await polls(1)]).toEqual([4, 5]);
    // While the last four parts are open it asks at least every 3 s, so the download starts soon after the upload.
    fetcher.mockClear();
    reply = () => json(200, status({ state: 'uploading', size: 100 * MB, received: 0, updatedAt: NOW }));
    const uploading = { state: 'uploading', id: D, size: 100 * MB, received: 0, updatedAt: NOW, now: NOW };
    page = await openDownload(uploading);
    expect([await polls(2000), await polls(3000), await polls(3000), await polls(3000)]).toEqual([1, 2, 3, 4]);
    fetcher.mockClear();
    page = await openDownload(uploading, true);
    expect(await polls(5 * MINUTE)).toBe(0);
    reply = () => json(200, status({ state: 'uploading', size: 100 * MB, received: 50 * MB, updatedAt: Date.now() }));
    page.doc.hidden = false;
    await page.doc.fire('visibilitychange');
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([page.text('progress-text'), page.text('progress-number')]).toEqual(['Uploading · 50.0 of 100.0\u00a0MB', '50 %']);
  });
});

describe('download page title', () => {
  it('lets a long name break at its separators before it breaks inside a word', async () => {
    const page = await openDownload({ state: 'ready', id: D, name: 'Jahresabschluss_überarbeitet-final.pdf', ext: 'PDF', size: 2048, url: `https://fyl.at/d/${D}/x.pdf`, once: false, protected: false, now: NOW, expiresAt: NOW + DAY });
    expect(page.el('file-title').innerHTML).toBe('Jahresabschluss_<wbr>überarbeitet-<wbr>final.pdf');
  });
});

describe('download page terminal command', () => {
  it('lets the link break at its separators and copies the command whole', async () => {
    const page = await openDownload({ state: 'protected', id: D, name: null, size: 2048, url: `https://fyl.at/d/${D}`, once: false, protected: true, now: NOW, expiresAt: NOW + DAY });
    expect(page.el('curl-command').innerHTML).toBe(`curl -fOJ -u fyl &#39;https:/<wbr>/<wbr>fyl.<wbr>at/<wbr>d/<wbr>${D.slice(0, -7)}<span class="nowrap">${D.slice(-7)}&#39;</span>`);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await page.el('copy-command').fire('click');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`curl -fOJ -u fyl 'https://fyl.at/d/${D}'`);
    expect(page.text('live-status')).toBe('Command copied.');
  });
});

describe('download page after a pause and a one-time start', () => {
  // @ts-expect-error: browser scripts without type declarations.
  const scripts = () => import('../dist/i18n.js').then(() => import('../dist/download.js'));
  const paused = { state: 'protected', id: D, name: null, size: 2048, url: `https://fyl.at/d/${D}`, once: false, protected: true, error: 'paused', triesLeft: 0,
    pausedUntil: NOW + 15 * MINUTE, now: NOW, expiresAt: NOW + DAY };

  it('reads out why a paused link is locked, asks without a password whether the sender lifted the pause, and opens the field once they did', async () => {
    const focused: string[] = [];
    const page = await open(`https://fyl.at/d/${D}`, doc => {
      doc.getElementById('fyl-state').textContent = JSON.stringify(paused);
      for (const id of ['password-message', 'password']) doc.getElementById(id).focus = () => { focused.push(id); doc.activeElement = doc.getElementById(id); };
    }, scripts);
    // Every control is disabled, so focus goes to the reason, which takes focus for that only.
    expect([focused, page.el('password-message').getAttribute('tabindex'), page.el('password').disabled]).toEqual([['password-message'], '-1', true]);
    reply = () => new Response(null, { status: 429 });
    await vi.advanceTimersByTimeAsync(60000); await settle();
    expect(fetcher.mock.calls).toEqual([[`/d/${D}?dl=1`, { method: 'HEAD', cache: 'no-store', credentials: 'omit' }]]);
    expect(page.doc.documentElement.dataset.error).toBe('paused');
    // The sender lifted it: the next question, here on coming back to the tab, gets the password challenge instead.
    reply = () => new Response(null, { status: 401 });
    await page.doc.fire('visibilitychange'); await settle();
    expect([page.doc.documentElement.dataset.error, page.el('password').disabled, page.text('live-status'), focused.at(-1)])
      .toEqual([undefined, false, 'You can enter the password again.', 'password']);
    // Nothing asks any more.
    fetcher.mockClear();
    await vi.advanceTimersByTimeAsync(120000); await settle();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns a one-time link\'s Download into the button for a download that broke once its one download started', async () => {
    const once = { state: 'ready', id: D, name: 'report.pdf', ext: 'PDF', size: 2048, url: `https://fyl.at/d/${D}/report.pdf`, downloadUrl: `https://fyl.at/d/${D}/report.pdf?dl=1`,
      once: true, protected: false, now: NOW, expiresAt: NOW + DAY };
    const page = await openDownload(once);
    expect([page.text('download-label'), page.el('download').classList.contains('btn-secondary')]).toEqual(['Download · 2.0\u00a0KB', false]);
    await page.el('download').fire('click');
    expect([page.text('download-label'), page.el('download').classList.contains('btn-secondary'), page.el('download').classList.contains('btn-primary'), page.text('once-note'), page.text('live-status')])
      .toEqual(['Download again (only if it broke)', true, false, ...Array(2).fill('Your one download has started. If it breaks, download again from this network within 15 minutes; the link closes once the file is complete.')]);
    // An unlocked one starts by itself once the page has loaded, and says the same.
    const unlocked = await openDownload({ ...once, state: 'unlocked', protected: true, downloadUrl: `https://fyl.at/d/${D}/report.pdf?grant=${NOW + HOUR}.x` });
    await unlocked.win.fire('load');
    expect([(globalThis as unknown as { location: { assign: Mock } }).location.assign.mock.calls.length, unlocked.text('download-label')]).toEqual([1, 'Download again (only if it broke)']);
    // A link for any number of downloads keeps its button.
    const plain = await openDownload({ ...once, once: false });
    await plain.el('download').fire('click');
    expect([plain.text('download-label'), plain.el('download').classList.contains('btn-secondary')]).toEqual(['Download · 2.0\u00a0KB', false]);
  });
});

// The download page of an encrypted link (docs/E2EE.md §9, §11, §13), with real ciphertext from the browser core. Every
// request the page makes is recorded: none may carry the key or a fragment, and nothing that could use up the link is
// sent before a click.
describe('encrypted download page', () => {
  interface Core {
    prepareUpload(name: string, size: number): Promise<{ identity: Uint8Array; key: string; head: Uint8Array; meta: Uint8Array; ciphertextSize: number; content: object }>;
    encryptPart(content: object, source: Uint8Array, part: number, options: { partSize: number }): Promise<Uint8Array>;
    encodeBlob(data: Uint8Array): string; decodeBlob(text: string): Uint8Array; encodeAgeIdentity(identity: Uint8Array): string;
  }
  interface Fixture { key: string; identity: Uint8Array; head: string; meta: string; C: number; P: number; ciphertext: Uint8Array; plaintext: Uint8Array }
  const NAME = 'Invoice «2026».pdf';
  let age: Core, fx: Fixture, big: Fixture, long: Fixture;
  const build = async (size: number, full = true): Promise<Fixture> => {
    const plaintext = Uint8Array.from({ length: full ? size : 0 }, (_, i) => i % 251), prepared = await age.prepareUpload(NAME, size);
    return { key: prepared.key, identity: prepared.identity, head: age.encodeBlob(prepared.head), meta: age.encodeBlob(prepared.meta), C: prepared.ciphertextSize, P: size,
      ciphertext: full ? await age.encryptPart(prepared.content, plaintext, 1, { partSize: prepared.ciphertextSize }) : new Uint8Array(), plaintext };
  };
  const stateOf = (f: Fixture, changes: Record<string, unknown> = {}) => ({ state: 'ready', id: D, mode: 'e2ee', name: null, type: null, ext: null, risky: false,
    size: f.C, expiresAt: NOW + DAY, once: false, protected: false, url: `https://fyl.at/d/${D}`, downloadUrl: null, received: null, updatedAt: null, reason: null,
    error: null, triesLeft: null, pausedUntil: null, now: NOW, head: f.head, meta: f.meta, ...changes });
  const openEncrypted = (state: Record<string, unknown>, address = `/d/${D}`) => open('https://fyl.at' + address, doc => {
    doc.getElementById('fyl-state').textContent = JSON.stringify(state);
  // @ts-expect-error: browser scripts without type declarations.
}, () => import('../dist/i18n.js').then(() => import('../dist/download.js')));
  const shown = (page: Page) => page.doc.documentElement.dataset.state;
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  const file = (f: Fixture, bytes = f.ciphertext) => new Response(bytes as BodyInit, { status: 200, headers: { 'Content-Length': String(bytes.length), ETag: '"etag-1"' } });
  type Init = { method?: string; headers?: Record<string, string>; cache?: string; credentials?: string };
  const requests = () => fetcher.mock.calls.map(call => { const [path, init] = call as unknown as [string, Init]; return { path: String(path), ...init }; });
  // The page's location and history, as open() stubbed them.
  const navigation = () => (globalThis as unknown as { location: { replace: Mock; assign: Mock; reload: Mock } }).location;
  // §2.2, §16: no request URL, header or body holds the key, and none a fragment.
  const keyless = (key: string) => expect(requests().filter(request => JSON.stringify(request).includes(key) || request.path.includes('#'))).toEqual([]);
  const keyIn = (page: Page, value: string) => { page.el('key').value = value; return page.el('open-file').fire('click'); };
  const blobs: Blob[] = [];
  const saving = () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:https://fyl.at/1'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  };
  const anchors = (page: Page) => page.doc.created.filter(element => element.download);
  // A MessageChannel as browsers have it: workerd's takes no transfer list. Messages arrive in a later microtask.
  class Port {
    other: Port | null = null; closed = false; onmessage: ((event: { data: unknown }) => unknown) | null = null;
    postMessage(data: unknown) { const target = this.other; if (!this.closed && target) void Promise.resolve().then(() => { if (!target.closed) target.onmessage?.({ data }); }); }
    close() { this.closed = true; }
    start() {}
  }
  class Channel { port1 = new Port(); port2 = new Port(); constructor() { this.port1.other = this.port2; this.port2.other = this.port1; } }
  // The page's dedicated decryption worker (dist/e2ee/worker.js) as Chromium runs it: what it posts to the page comes
  // as a task of its own, after what it posts on a MessagePort at the same moment, and terminate() drops what hasn't
  // arrived yet (`dropped`).
  class DecryptWorker {
    static dropped: string[] = [];
    onmessage: ((event: { data: unknown }) => unknown) | null = null;
    onerror: (() => unknown) | null = null;
    private terminated = false;
    private scope = {
      onmessage: null as ((event: { data: unknown; ports: unknown[] }) => unknown) | null,
      postMessage: (data: unknown) => {
        realTimeout(() => { if (this.terminated) DecryptWorker.dropped.push((data as { type: string }).type); else this.onmessage?.({ data }); }, 0);
      },
    };
    constructor() {
      // @ts-expect-error: a browser script without type declarations.
      void import('../dist/e2ee/jobs.js').then((jobs: { serve(scope: object): void }) => jobs.serve(this.scope));
    }
    postMessage(data: unknown, transfer: unknown[] = []) { void Promise.resolve().then(() => this.scope.onmessage?.({ data, ports: transfer })); }
    terminate() { this.terminated = true; }
  }

  beforeAll(async () => {
    // @ts-expect-error: dist/e2ee is plain browser ES modules without type declarations.
    age = await import('../dist/e2ee/age.js');
    fx = await build(70000);
    big = await build(300 * MB, false);
    long = await build(400000);
  });
  beforeEach(() => { blobs.length = 0; vi.stubGlobal('MessageChannel', Channel); });

  it('reads the key from the address once, drops a crafted name and query, and names the file only after the key check', async () => {
    const page = await openEncrypted(stateOf(fx), `/d/${D}/Invoice.pdf?dl=1#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    expect(page.location().href).toBe(`https://fyl.at/d/${D}#${fx.key}`);
    expect([page.el('file-title').innerHTML, page.el('file-title').translate, page.doc.title]).toEqual(['Invoice_<wbr>«2026».pdf'.replace('_<wbr>', ' '), false, 'Encrypted file · fyl.at']);
    expect([page.text('file-meta'), page.text('file-ext'), page.el('save-box').hidden, page.text('save-label')]).toEqual(['68.4\u00a0KB · PDF document', 'PDF', false, 'Download · 68.4\u00a0KB']);
    expect(page.text('after-text')).toBe('fyl.at can’t check encrypted files or who sent them. Only open files you expected.');
    // The form's address comes from the page (report.fyl.at/<lang>/); the script only adds the link without its key.
    expect(new URL(page.el('report-link').href).search).toBe('?' + new URLSearchParams({ link: `https://fyl.at/d/${D}` }));
    expect(page.el('curl-command').innerHTML).toContain('fyl download');
    expect(page.text('curl-hint')).toBe('Needs the fyl tool, which decrypts and saves the file. curl would get only encrypted data.');
    expect(page.el('live-status').translate).toBe(false);
    // Nothing was asked of fyl.at: not the file, not even the info route.
    expect(fetcher).not.toHaveBeenCalled();
    expect(page.doc.documentElement.attributes.has('data-e2ee') || page.doc.documentElement.attributes.get('data-e2ee') === '').toBe(true);
  });

  it('uses a key sent in the path after %23, cleans the address, warns, and keeps the key for this tab', async () => {
    let page = await openEncrypted(stateOf(fx), `/d/${D}%23${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    expect([page.location().href, page.el('key-exposed').hidden]).toEqual([`https://fyl.at/d/${D}`, false]);
    expect(session.json('fyl-open-keys')).toEqual({ [D]: fx.key });
    page = await openEncrypted(stateOf(fx));
    await until(() => expect(shown(page)).toBe('ready'));
    expect(page.el('key-exposed').hidden).toBe(true);
    // A path segment is never a key, not even a KEY-shaped one.
    session.items.clear();
    page = await openEncrypted(stateOf(fx), `/d/${D}/${fx.key}`);
    await settle();
    expect([shown(page), page.location().href]).toEqual(['key', `https://fyl.at/d/${D}`]);
  });

  it('asks for a missing key and takes a KEY, the whole link or the age identity; another file\'s link and a wrong key are refused', async () => {
    const page = await openEncrypted(stateOf(fx));
    await settle();
    expect([shown(page), page.el('key-box').hidden, page.text('file-title'), page.text('file-meta')]).toEqual(['key', false, 'Key required', '68.4\u00a0KB · Encrypted']);
    const refused = async (value: string, code: string, message: string) => {
      await keyIn(page, value);
      await until(() => expect(page.doc.documentElement.dataset.keyError).toBe(code));
      expect([shown(page), page.el('key-message').innerHTML.includes(message), page.el('key').getAttribute('aria-invalid')]).toEqual(['key', true, 'true']);
    };
    await refused('', 'key_invalid', 'This key is incomplete or damaged.');
    await refused(fx.key.slice(1), 'key_invalid', 'This key is incomplete or damaged.');
    await refused(`https://fyl.at/d/${'w'.repeat(43)}#${fx.key}`, 'other_transfer', 'This link is for another file.');
    await refused(big.key, 'key_wrong', 'This key doesn’t open this file. Check that you copied the whole link.');
    await keyIn(page, ` ${age.encodeAgeIdentity(fx.identity).toLowerCase()}\n`);
    await until(() => expect(shown(page)).toBe('ready'));
    expect(page.location().href).toBe(`https://fyl.at/d/${D}`); // a typed key never goes into the address
    expect(session.json('fyl-open-keys')).toEqual({ [D]: fx.key });
    keyless(fx.key);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('says a file is damaged or needs a newer fyl instead of asking for another key', async () => {
    const meta = age.decodeBlob(fx.meta); meta[300] ^= 1;
    let page = await openEncrypted(stateOf(fx, { meta: age.encodeBlob(meta) }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('gone'));
    expect([page.text('file-title'), page.text('gone-text')]).toEqual(['This file can’t be opened', 'The file is damaged or was changed. It can’t be decrypted safely. Ask the sender to upload it again.']);
    const head = age.decodeBlob(fx.head); head[20] = 0x32; // age-encryption.org/v2
    page = await openEncrypted(stateOf(fx, { head: age.encodeBlob(head) }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('gone'));
    expect(page.text('file-title')).toBe('This file needs a newer fyl');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('says the decryption code didn\'t load instead of calling the file damaged, and reloads on Try again, keeping the key', async () => {
    // Browsers keep a failed module import for the page's life, so Try again reloads the page (the key stays in its address).
    const failing = async (address: string, typed = '') => {
      vi.doMock('../dist/e2ee/age.js', () => { throw new TypeError('Failed to fetch dynamically imported module.'); });
      try {
        const page = await openEncrypted(stateOf(fx), address);
        await settle();
        if (typed) await keyIn(page, typed);
        await until(() => expect(page.doc.documentElement.dataset.keyError).toBe('load'));
        return page;
      } finally { vi.doUnmock('../dist/e2ee/age.js'); }
    };
    const page = await failing(`/d/${D}#${fx.key}`);
    // No field, only a retry. Nothing says the file is damaged or the key is wrong; nothing was asked of fyl.at.
    expect([shown(page), page.text('file-title'), page.el('key-box').hidden, page.el('key-field').hidden, page.text('open-file-label'), page.text('gone-text')])
      .toEqual(['key', 'Encrypted file', false, true, 'Try again', '']);
    expect(page.el('key-message').innerHTML).toContain('Couldn’t load the decryption code. Check your connection, then try again.');
    expect(page.text('key-lead')).toBe('The link has its key, but this page couldn’t load what it needs to open the file.');
    await page.el('open-file').fire('click');
    expect(navigation().reload).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    // The reload, with the code back: the key from the address opens the file.
    const reloaded = await openEncrypted(stateOf(fx), page.location().pathname + page.location().hash);
    await until(() => expect(shown(reloaded)).toBe('ready'));
    expect(reloaded.el('file-title').innerHTML).toBe('Invoice «2026».pdf');
    // A typed key whose check can't load its code: the same retry, without a field.
    const typed = await failing(`/d/${D}`, fx.key);
    expect([typed.el('key-field').hidden, typed.text('open-file-label'), typed.text('key-lead')]).toEqual([true, 'Try again', 'This page couldn’t load what it needs to open the file.']);
    expect(session.getItem('fyl-open-keys')).toBeNull();
  });

  it('tells a browser that can\'t decrypt so, without a key field, and keeps the terminal command with the key', async () => {
    const subtle = crypto.subtle, importKey = subtle.importKey.bind(subtle) as (...args: unknown[]) => Promise<CryptoKey>;
    vi.spyOn(subtle, 'importKey').mockImplementation(((...args: unknown[]) => (args[2] as { name?: string })?.name === 'X25519'
      ? Promise.reject(new DOMException('Not supported.', 'NotSupportedError')) : importKey(...args)) as never);
    const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('gone'));
    expect([page.text('file-title'), page.text('gone-text'), page.el('key-box').hidden, page.text('gone-tag')])
      .toEqual(['This browser can’t decrypt files', 'Update it or open the link in another browser, or use the fyl tool below.', true, 'Not supported here']);
    expect(page.doc.documentElement.attributes.has('data-platform')).toBe(true);
    expect(page.el('curl-command').innerHTML.replace(/<[^>]*>/g, '').replaceAll('&#39;', "'")).toBe(`fyl download 'https://fyl.at/d/${D}#${fx.key}'`);
    expect(page.text('curl-hint')).toBe('Needs the fyl tool, which decrypts and saves the file. curl would get only encrypted data.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps every element that shows the key out of machine translation on the download page', async () => {
    const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    const { holders, translated } = await untranslated(page, fx.key, '/download');
    expect(holders).toContain('curl-command');
    expect(translated).toEqual([]);
  });

  it('saves into memory without a service worker: one request without the key, a Blob only after the file verified, through <a download>', async () => {
    saving();
    const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async () => { await held; return file(fx); });
    // Keyboard focus on the button: it stays focusable while it runs, and moves to Save again when the button goes.
    page.doc.activeElement = page.el('save');
    const focused = vi.spyOn(page.el('save-again'), 'focus');
    void page.el('save').fire('click');
    await settle();
    expect([page.text('save-label'), page.el('save').getAttribute('aria-disabled'), page.el('save').disabled]).toEqual(['Decrypting…', 'true', false]);
    release();
    await until(() => expect(page.el('saved-line').hidden).toBe(false));
    expect([page.el('save').getAttribute('aria-disabled'), focused.mock.calls.length]).toEqual(['false', 1]);
    expect(requests()).toMatchObject([{ path: `https://fyl.at/d/${D}?dl=1`, cache: 'no-store', credentials: 'omit' }]);
    expect(requests()[0].headers).toEqual({});
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(fx.plaintext);
    expect(blobs[0].type).toBe('application/octet-stream');
    expect(anchors(page).map(anchor => [anchor.download, anchor.href, anchor.clicks])).toEqual([[NAME, 'blob:https://fyl.at/1', 1]]);
    expect([page.text('saved-text'), page.el('save-again').hidden, page.el('save').hidden]).toEqual([`Decrypted and verified: ${NAME}.`, false, true]);
    await page.el('save-again').fire('click');
    expect(anchors(page).map(anchor => anchor.clicks)).toEqual([1, 1]);
    keyless(fx.key);
  });

  it('closes a one-time link with done once the file verified, and never saves a damaged one', async () => {
    saving();
    let page = await openEncrypted(stateOf(fx, { once: true }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    fetcher.mockImplementation(async path => String(path).endsWith('/done') ? new Response(null, { status: 204 }) : file(fx));
    await page.el('save').fire('click');
    await until(() => expect(page.el('saved-line').hidden).toBe(false));
    expect(requests().map(request => [request.method || 'GET', request.path])).toEqual([['GET', `https://fyl.at/d/${D}?dl=1`], ['POST', `/api/transfers/${D}/done`]]);
    fetcher.mockReset();
    const damaged = fx.ciphertext.slice(); damaged[184 + 65552 + 10] ^= 1;
    fetcher.mockImplementation(async () => file(fx, damaged));
    page = await openEncrypted(stateOf(fx, { once: true }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    blobs.length = 0;
    await page.el('save').fire('click');
    await until(() => expect(page.el('save-error').innerHTML).not.toBe(''));
    expect(page.el('save-error').innerHTML).toContain('The file is damaged or was changed. It can’t be decrypted safely. You can try again from this network for 15 minutes.');
    expect([blobs.length, page.text('save-label'), requests().filter(request => request.path.endsWith('/done')).length]).toEqual([0, 'Try again', 0]);
  });

  it('closes a one-time link on the verified end, also when stopping the decryption worker drops its last messages', async () => {
    saving();
    DecryptWorker.dropped = [];
    vi.stubGlobal('Worker', DecryptWorker);
    const page = await openEncrypted(stateOf(fx, { once: true }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    fetcher.mockImplementation(async path => String(path).endsWith('/done') ? new Response(null, { status: 204 }) : file(fx));
    await page.el('save').fire('click');
    await until(() => expect(page.el('saved-line').hidden).toBe(false));
    await until(() => expect(DecryptWorker.dropped).toContain('done'));
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(fx.plaintext);
    expect(requests().map(request => [request.method || 'GET', request.path])).toEqual([['GET', `https://fyl.at/d/${D}?dl=1`], ['POST', `/api/transfers/${D}/done`]]);
    keyless(fx.key);
  });

  it('gives a file over 256 MiB without the service worker the terminal instead, before any request', async () => {
    const page = await openEncrypted(stateOf(big), `/d/${D}#${big.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    page.doc.activeElement = page.el('save');
    const focused = vi.spyOn(page.el('e2ee-note'), 'focus');
    await page.el('save').fire('click');
    await settle();
    expect([fetcher.mock.calls.length, page.el('save').hidden, page.text('e2ee-note-text'), focused.mock.calls.length]).toEqual([0, true,
      'This browser can save encrypted files of up to 256\u00a0MB. Use Download in a terminal below, or another browser.', 1]);
  });

  describe('with the download service worker', () => {
    interface Posted { message: { type: string; token?: string; name?: string; size?: number }; transfer: Port[] }
    let posted: Posted[] = [];
    const worker = { state: 'activated', postMessage: (message: Posted['message'], transfer: Port[] = []) => { posted.push({ message, transfer }); } };
    const register = vi.fn(async (): Promise<object> => ({ active: worker }));
    // Chromium, the one engine the streaming path runs on until the browser matrix is measured (§9.4).
    const chromium = { brands: [{ brand: 'Chromium', version: '156' }, { brand: 'Google Chrome', version: '156' }] };
    beforeEach(() => { posted = []; register.mockClear(); navigatorExtras = { serviceWorker: { register }, userAgentData: chromium }; });

    it('registers /_dl/sw.js for /_dl/ only, and asks nothing of fyl.at before the browser pulls; no pull in 10 s falls back', async () => {
      saving();
      const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
      await until(() => expect(shown(page)).toBe('ready'));
      expect(register).toHaveBeenCalledExactlyOnceWith('/_dl/sw.js', { scope: '/_dl/' });
      fetcher.mockImplementation(async () => file(fx));
      void page.el('save').fire('click');
      await settle();
      const [start] = posted;
      expect(start.message).toMatchObject({ type: 'download', name: NAME, size: fx.P });
      expect(start.message.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(start.transfer).toHaveLength(1);
      expect(page.doc.created.find(element => element.src)?.src).toBe('/_dl/' + start.message.token);
      expect(JSON.stringify(start.message)).not.toContain(fx.key);
      await vi.advanceTimersByTimeAsync(9999); await settle();
      expect(fetcher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await settle();
      await until(() => expect(page.el('saved-line').hidden).toBe(false));
      expect(posted.map(item => item.message)).toContainEqual({ type: 'cancel', token: start.message.token });
      expect(requests()).toHaveLength(1);
      expect(page.text('saved-text')).toBe(`Decrypted and verified: ${NAME}.`);
    });

    it('streams to the worker after its first pull, and says the file was saved only once it verified and the stream closed', async () => {
      const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
      await until(() => expect(shown(page)).toBe('ready'));
      fetcher.mockImplementation(async () => file(fx));
      void page.el('save').fire('click');
      await settle();
      // The service worker's side of the port: it acks each chunk and reports the stream closed after the end.
      const port = posted[0].transfer[0], chunks: Uint8Array[] = [];
      let ended = false;
      port.onmessage = ({ data }) => {
        const message = data as { type: string; data: ArrayBuffer };
        if (message.type === 'chunk') { chunks.push(new Uint8Array(message.data)); port.postMessage({ type: 'ack' }); }
        if (message.type === 'end') ended = true;
      };
      port.postMessage({ type: 'started' });
      await settle();
      expect(fetcher).not.toHaveBeenCalled();
      port.postMessage({ type: 'pulled' });
      await until(() => expect(ended).toBe(true));
      expect(page.el('saved-line').hidden).toBe(true);
      // The page decrypts, so leaving it would stop the download: the browser asks first while it runs.
      const leave = async () => { let asked = false; await page.win.fire('beforeunload', { preventDefault: () => { asked = true; } }); return asked; };
      expect(await leave()).toBe(true);
      port.postMessage({ type: 'closed' });
      await until(() => expect(page.el('saved-line').hidden).toBe(false));
      expect(page.text('saved-text')).toBe(`Decrypted and verified, saved by your browser as ${NAME}.`);
      expect(await leave()).toBe(false);
      expect(new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer())).toEqual(fx.plaintext);
      keyless(fx.key);
    });

    it('closes a one-time link only once the browser has the whole stream, so a cancel after the last chunk still offers a retry', async () => {
      for (const last of ['cancel', 'closed']) {
        posted = [];
        const page = await openEncrypted(stateOf(fx, { once: true }), `/d/${D}#${fx.key}`);
        await until(() => expect(shown(page)).toBe('ready'));
        fetcher.mockReset();
        fetcher.mockImplementation(async path => String(path).endsWith('/done') ? new Response(null, { status: 204 }) : file(fx));
        void page.el('save').fire('click');
        await settle();
        const port = posted[0].transfer[0];
        let ended = false;
        port.onmessage = ({ data }) => {
          const message = data as { type: string };
          if (message.type === 'chunk') port.postMessage({ type: 'ack' });
          if (message.type === 'end') ended = true;
        };
        port.postMessage({ type: 'pulled' });
        await until(() => expect(ended).toBe(true));
        await settle();
        // The final chunk verified, but the browser doesn't have all of it yet: the link stays open.
        const done = () => requests().filter(request => request.path.endsWith('/done')).length;
        expect(done()).toBe(0);
        port.postMessage({ type: last });
        if (last === 'cancel') {
          await until(() => expect(page.el('save-error').innerHTML).not.toBe(''));
          expect(page.el('save-error').innerHTML).toContain('The download was cancelled. You can try again from this network for 15 minutes.');
          await settle();
          expect([page.text('save-label'), page.el('save').hidden, done()]).toEqual(['Try again', false, 0]);
        } else {
          await until(() => expect(page.el('saved-line').hidden).toBe(false));
          expect(requests().map(request => [request.method || 'GET', request.path])).toEqual([['GET', `https://fyl.at/d/${D}?dl=1`], ['POST', `/api/transfers/${D}/done`]]);
        }
      }
    });

    it('stops the download when the browser cancels it, during or after the stream, and says the saved file is incomplete', async () => {
      for (const f of [long, fx]) {
        posted = [];
        const page = await openEncrypted(stateOf(f), `/d/${D}#${f.key}`);
        await until(() => expect(shown(page)).toBe('ready'));
        fetcher.mockReset();
        fetcher.mockImplementation(async () => file(f));
        void page.el('save').fire('click');
        await settle();
        // This side never acks: a long file stops after four chunks, a short one ends before the cancel.
        const port = posted[0].transfer[0], seen: string[] = [];
        port.onmessage = ({ data }) => { seen.push((data as { type: string }).type); };
        port.postMessage({ type: 'pulled' });
        await until(() => expect(seen.length).toBeGreaterThanOrEqual(f === long ? 4 : 3));
        port.postMessage({ type: 'cancel' });
        await until(() => expect(page.el('save-error').innerHTML).not.toBe(''));
        expect(page.el('save-error').innerHTML).toContain('The download failed, so the saved file is incomplete. The download was cancelled.');
        expect([seen.filter(type => type === 'chunk').length, page.el('saved-line').hidden]).toEqual([f === long ? 4 : 2, true]);
        // #save-error is an alert: the live region doesn't announce the failure a second time.
        expect(page.text('live-status')).not.toContain('cancelled');
      }
    });
  });

  describe('choosing the streaming path', () => {
    interface Posted { message: { type: string; token?: string; size?: number }; transfer: Port[] }
    let posted: Posted[] = [];
    const chromium = { brands: [{ brand: 'Chromium', version: '156' }, { brand: 'Google Chrome', version: '156' }] };
    const activated = { state: 'activated', postMessage: (message: Posted['message'], transfer: Port[] = []) => { posted.push({ message, transfer }); } };
    const register = vi.fn(async (): Promise<object> => ({ active: activated }));
    beforeEach(() => { posted = []; register.mockReset(); register.mockImplementation(async () => ({ active: activated })); });

    it('streams only in Chromium: another browser, an Android WebView or an iPad saves through memory and never registers', async () => {
      saving();
      const webview = { brands: [{ brand: 'Chromium', version: '156' }, { brand: 'Android WebView', version: '156' }] };
      for (const extras of [{}, { userAgentData: webview }, { userAgentData: chromium, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }]) {
        navigatorExtras = { serviceWorker: { register }, ...extras };
        const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
        await until(() => expect(shown(page)).toBe('ready'));
        fetcher.mockReset();
        fetcher.mockImplementation(async () => file(fx));
        await page.el('save').fire('click');
        await until(() => expect(page.el('saved-line').hidden).toBe(false));
        expect([register.mock.calls.length, posted.length, page.text('saved-text')], JSON.stringify(extras)).toEqual([0, 0, `Decrypted and verified: ${NAME}.`]);
      }
    });

    it('waits up to 5 s for a worker still installing at the click, offers the button again, and registers again after a failure', async () => {
      // A first visit: the worker installs while the page loads and activates 2 s after the click.
      const installing = Object.assign(new EventTarget(), { state: 'installing', postMessage: activated.postMessage });
      const registration: { active: object | null; installing: object | null } = { active: null, installing };
      register.mockImplementationOnce(async () => registration);
      navigatorExtras = { serviceWorker: { register }, userAgentData: chromium };
      const page = await openEncrypted(stateOf(big), `/d/${D}#${big.key}`);
      await until(() => expect(shown(page)).toBe('ready'));
      void page.el('save').fire('click');
      await vi.advanceTimersByTimeAsync(2000); await settle();
      expect(posted).toEqual([]);
      Object.assign(installing, { state: 'activated' }); Object.assign(registration, { active: installing, installing: null });
      installing.dispatchEvent(new Event('statechange'));
      await settle();
      expect(posted[0]?.message).toMatchObject({ type: 'download', size: big.P });
      // The browser never pulls: nothing was asked of fyl.at, and the button stays for another try.
      await vi.advanceTimersByTimeAsync(10000); await settle();
      expect([fetcher.mock.calls.length, page.el('save').hidden, page.text('save-label'), page.text('e2ee-note-text')])
        .toEqual([0, false, 'Try again', 'Your browser didn’t start the download. Try again, or use Download in a terminal below.']);
      // A registration that failed on load is tried again at the click.
      register.mockImplementationOnce(async () => { throw new Error('Registration failed.'); });
      posted = [];
      const second = await openEncrypted(stateOf(big), `/d/${D}#${big.key}`);
      await until(() => expect(shown(second)).toBe('ready'));
      void second.el('save').fire('click');
      await settle();
      expect([register.mock.calls.length, posted[0]?.message.type]).toEqual([3, 'download']);
    });

    it('fails the browser\'s download at once when the decryption code doesn\'t load, and says so', async () => {
      navigatorExtras = { serviceWorker: { register }, userAgentData: chromium };
      const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
      await until(() => expect(shown(page)).toBe('ready'));
      vi.doMock('../dist/e2ee/jobs.js', () => { throw new TypeError('Failed to fetch dynamically imported module.'); });
      try {
        void page.el('save').fire('click');
        await settle();
        const port = posted[0].transfer[0], seen: string[] = [];
        port.onmessage = ({ data }) => { seen.push((data as { type: string }).type); };
        port.postMessage({ type: 'pulled' });
        await until(() => expect(page.el('save-error').innerHTML).not.toBe(''));
        expect(page.el('save-error').innerHTML).toContain('Couldn’t load the decryption code. Check your connection, then try again.');
        expect([seen, fetcher.mock.calls.length, page.text('save-label')]).toEqual([['error'], 0, 'Try again']);
      } finally { vi.doUnmock('../dist/e2ee/jobs.js'); }
    });
  });

  it('protected: checks the key\'s form first, sends the password as Basic to the info route, and sends it again for the download', async () => {
    saving();
    const page = await openEncrypted(stateOf(fx, { state: 'protected', protected: true, head: null, meta: null, triesLeft: 5 }));
    await settle();
    expect([shown(page), page.el('key-box').hidden, page.text('file-title'), page.text('file-meta')]).toEqual(['protected', false, 'Password required', '68.4\u00a0KB · Name hidden until unlocked']);
    const unlock = (password: string, key = '') => { page.el('password').value = password; page.el('key').value = key; return page.el('unlock-form').fire('submit'); };
    // The key check runs on WebCrypto, asynchronously: wait for its outcome instead of a fixed number of ticks.
    await unlock('tide-lamp-fern-41');
    await until(() => expect([page.doc.documentElement.dataset.keyError, fetcher.mock.calls.length]).toEqual(['key_missing', 0]));
    await unlock('tide-lamp-fern-41', 'nonsense');
    await until(() => expect([page.doc.documentElement.dataset.keyError, fetcher.mock.calls.length]).toEqual(['key_invalid', 0]));
    fetcher.mockImplementationOnce(async () => json(401, { error: 'Wrong password.', code: 'password_wrong', triesLeft: 4 }));
    await unlock('wrong-pass-00', fx.key);
    await until(() => expect([page.doc.documentElement.dataset.error, page.el('password-message').innerHTML.includes('Wrong password. 4 tries left.'), page.el('password').value]).toEqual(['wrong', true, '']));
    const basic = 'Basic ' + btoa('fyl:tide-lamp-fern-41');
    fetcher.mockImplementationOnce(async () => json(200, { id: D, state: 'ready', mode: 'e2ee', name: null, size: fx.C, protected: true, e2ee: { head: fx.head, meta: fx.meta } }));
    await unlock('tide-lamp-fern-41', fx.key);
    await until(() => expect(shown(page)).toBe('ready'));
    expect(requests().map(request => [request.path, request.headers?.Authorization])).toEqual([[`/api/transfers/${D}`, 'Basic ' + btoa('fyl:wrong-pass-00')], [`/api/transfers/${D}`, basic]]);
    expect([page.el('file-title').innerHTML, page.location().href]).toEqual(['Invoice «2026».pdf', `https://fyl.at/d/${D}`]);
    fetcher.mockImplementation(async () => file(fx));
    await page.el('save').fire('click');
    await until(() => expect(page.el('saved-line').hidden).toBe(false));
    expect(requests()[2]).toMatchObject({ path: `https://fyl.at/d/${D}?dl=1`, headers: { Authorization: basic } });
    keyless(fx.key);
  });

  it('protected: a paused link says so and counts down', async () => {
    const page = await openEncrypted(stateOf(fx, { state: 'protected', protected: true, head: null, meta: null }), `/d/${D}#${fx.key}`);
    await settle();
    expect(page.el('key-box').hidden).toBe(true);
    fetcher.mockImplementationOnce(async () => json(429, { error: 'Paused.', code: 'password_paused', pausedUntil: Date.now() + 15 * MINUTE }));
    page.el('password').value = 'tide-lamp-fern-41';
    await page.el('unlock-form').fire('submit');
    await until(() => expect([page.doc.documentElement.dataset.error, page.text('unlock-label')]).toEqual(['paused', 'Try again in 15:00']));
  });

  it('focuses the key field when the link has no key, and nothing while a key from the address is checked', async () => {
    const focused: string[] = [];
    const watch = (address: string) => open('https://fyl.at' + address, doc => {
      doc.getElementById('fyl-state').textContent = JSON.stringify(stateOf(fx));
      doc.getElementById('key').focus = () => { focused.push('key'); };
    // @ts-expect-error: browser scripts without type declarations.
    }, () => import('../dist/i18n.js').then(() => import('../dist/download.js')));
    await watch(`/d/${D}`);
    expect(focused).toEqual(['key']);
    focused.length = 0;
    const page = await watch(`/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('ready'));
    expect(focused).toEqual([]);
  });

  it('checks a key changed in the address again', async () => {
    const page = await openEncrypted(stateOf(fx), `/d/${D}#${big.key}`);
    await until(() => expect(page.doc.documentElement.dataset.keyError).toBe('key_wrong'));
    (globalThis as unknown as { history: { replaceState(state: unknown, title: string, url: string): void } }).history.replaceState(null, '', `/d/${D}#${fx.key}`);
    await page.win.fire('hashchange');
    await until(() => expect(shown(page)).toBe('ready'));
  });

  it('changes in place when an early upload finishes and waits for a click', async () => {
    const page = await openEncrypted(stateOf(fx, { state: 'uploading', received: 0, updatedAt: NOW, expiresAt: null }), `/d/${D}#${fx.key}`);
    await until(() => expect(shown(page)).toBe('uploading'));
    expect(page.text('auto-text')).toBe('Keep this page open. You can download the file once the upload is done.');
    reply = () => json(200, { id: D, state: 'ready', mode: 'e2ee', name: null, size: fx.C, once: false, protected: false, expiresAt: NOW + DAY });
    await vi.advanceTimersByTimeAsync(6000); await settle();
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(shown(page)).toBe('ready');
    expect([navigation().replace.mock.calls, navigation().assign.mock.calls, requests().map(request => request.path)]).toEqual([[], [], [`/api/transfers/${D}`]]);
  });

  it('moves focus with the skip link without touching the fragment', async () => {
    const page = await openEncrypted(stateOf(fx), `/d/${D}#${fx.key}`);
    let prevented = false;
    await page.doc.querySelector('.skip').fire('click', { preventDefault: () => { prevented = true; } });
    expect([prevented, page.location().hash]).toEqual([true, '#' + fx.key]);
  });

  it('sends no Referer once it runs: the page\'s same-origin policy, kept for the raw unlock form, becomes no-referrer', async () => {
    // tests/download-page.test.ts checks that what <head> loads before any script runs carries no-referrer itself.
    const referrer = (page: Page) => page.doc.querySelector('meta[name="referrer"]').getAttribute('content');
    expect(referrer(await openEncrypted(stateOf(fx), `/d/${D}%23${fx.key}`))).toBe('no-referrer');
    expect(referrer(await openEncrypted(stateOf(fx, { state: 'protected', protected: true, head: null, meta: null })))).toBe('no-referrer');
    // A raw page keeps the policy its unlock form needs (the page's meta, untouched here).
    expect(referrer(await openDownload({ state: 'protected', id: D, size: 2048, protected: true, now: NOW, expiresAt: NOW + DAY }))).toBeNull();
  });

  it('refuses a raw file asked for with a key: a link with a key never yields an unencrypted file', async () => {
    const page = await open(`https://fyl.at/d/${D}/report.pdf#${fx.key}`, doc => {
      doc.getElementById('fyl-state').textContent = JSON.stringify({ state: 'unlocked', id: D, name: 'report.pdf', size: 2048, url: `https://fyl.at/d/${D}/report.pdf`,
        downloadUrl: `https://fyl.at/d/${D}/report.pdf?grant=1.x`, once: false, protected: true, now: NOW, expiresAt: NOW + DAY });
    // @ts-expect-error: browser scripts without type declarations.
    }, () => import('../dist/i18n.js').then(() => import('../dist/download.js')));
    await page.win.fire('load');
    expect([shown(page), page.text('file-title'), navigation().assign.mock.calls]).toEqual(['gone', 'This link doesn’t fit the file', []]);
  });
});

describe('every page', () => {
  it('drops an unfinished upload\'s record once its 24-hour upload window has closed, and keeps one still in it (docs/E2EE.md §2.5)', async () => {
    // dist/theme.js, which every page loads in <head>: the report and privacy pages too, which load nothing else of fyl.
    vi.stubGlobal('addEventListener', () => {});
    const theme = () => open('https://fyl.at/privacy', () => {}, () => {
      vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
      // @ts-expect-error: a browser script without type declarations.
      return import('../dist/theme.js');
    });
    const live = { uploadId: U, created: Date.now() - 23 * HOUR, e2ee: true, md5: { 1: 'a'.repeat(32) } };
    local.setItem('fyl-upload', JSON.stringify(live));
    await theme();
    expect(local.json('fyl-upload')).toEqual(live);
    local.setItem('fyl-upload', JSON.stringify({ ...live, created: Date.now() - DAY }));
    await theme();
    expect(local.getItem('fyl-upload')).toBeNull();
  });
});
