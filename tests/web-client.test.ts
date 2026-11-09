import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { englishText } from './english';

// dist/api.js is the website's upload client, a plain browser script. It runs here against a scripted
// XMLHttpRequest that behaves like the browser's, a scripted fetch, and a Worker that hashes like dist/md5-worker.js.
type Handler = (() => void) | null;
type Script = (xhr: FakeXHR) => void;
let script: Script = xhr => xhr.respond();
const requests: FakeXHR[] = [];

class FakeXHR {
  status = 0; responseText = ''; timeout = 0; url = ''; sent: Blob | null = null; headers: Record<string, string> = {}; requestHeaders: Record<string, string> = {};
  onload: Handler = null; onerror: Handler = null; onabort: Handler = null; onloadend: Handler = null; ontimeout: Handler = null;
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  private done = false; private timers: ReturnType<typeof setTimeout>[] = [];
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader(name: string, value: string) { this.requestHeaders[name.toLowerCase()] = value; }
  getResponseHeader(name: string) { return this.headers[name.toLowerCase()] ?? null; }
  get partNumber() { return Number(new URL(this.url, 'https://fyl.at').searchParams.get('partNumber')); }
  send(blob: Blob) {
    this.sent = blob; requests.push(this);
    if (this.timeout) this.later(this.timeout, () => this.end(this.ontimeout));
    script(this);
  }
  abort() { this.end(this.onabort); }
  later(ms: number, step: () => void) { this.timers.push(setTimeout(() => { if (!this.done) step(); }, ms)); }
  progress(loaded: number) { this.upload.onprogress?.({ loaded }); }
  respond(status = 200, body: unknown = { etag: 'etag-' + requests.indexOf(this) }, headers: Record<string, string> = {}) {
    this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.headers = headers;
    this.end(this.onload);
  }
  private end(handler: Handler) {
    if (this.done) return;
    this.done = true; this.timers.forEach(clearTimeout);
    handler?.(); this.onloadend?.();
  }
}

// Hashes what it gets like dist/md5-worker.js, with the same vendored SparkMD5 (tests/web-md5.test.ts checks both).
let spark: { ArrayBuffer: { hash(buffer: ArrayBuffer): string } };
// The E2EE part worker (dist/e2ee/worker.js, a module worker) runs dist/e2ee/jobs.js on the same messages here.
class FakeWorker {
  static created = 0; static broken = false; static modules: string[] = [];
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null; onerror: Handler = null;
  private stopped = false;
  constructor(public url: string, options: { type?: string } = {}) {
    FakeWorker.created++;
    if (options.type === 'module') FakeWorker.modules.push(url);
    if (url === '/e2ee/worker.js' && !FakeWorker.broken) {
      const scope = { onmessage: null as ((event: { data: unknown; ports: unknown[] }) => unknown) | null,
        postMessage: (data: Record<string, unknown>) => { setTimeout(() => { if (!this.stopped) this.onmessage?.({ data }); }, 0); } };
      jobs.serve(scope);
      this.postMessage = (message: unknown) => { void scope.onmessage?.({ data: message, ports: [] }); };
    }
  }
  postMessage(blob: Blob) {
    if (FakeWorker.broken) { setTimeout(() => this.onerror?.(), 0); return; }
    blob.arrayBuffer().then(bytes => {
      if (this.stopped) return;
      this.onmessage?.({ data: { read: blob.size } });
      this.onmessage?.({ data: { hash: spark.ArrayBuffer.hash(bytes) } });
    });
  }
  terminate() { this.stopped = true; }
}

interface Options { minutes: number; once: boolean; password?: string }
interface Session { uploadId: string; key: string; url: string }
type Progress = (value: number | null, stage: string, sent?: number) => void;
interface Failure { resumable?: boolean; kind?: string; status?: number; name?: string }
interface Upload {
  upload(file: Blob, options: Options, controller: AbortController, onProgress: Progress, resume?: Session | null, onSession?: (session: Session) => void): Promise<{ id: string; ownerKey: string; url: string }>;
  passphrase(): string;
  validPassword(text: string): boolean;
  classify(status: number, code?: string): string;
  validReceipt(body: unknown, uploadId: string, size: number): boolean;
  unpause(id: string, key: string): Promise<unknown>;
}
interface Call { path: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> }
let api: Upload;
let jobs: { serve(scope: object): void };
const U = 'u'.repeat(43), K = 'k'.repeat(43), PART = 50 * 1024 * 1024;
const calls: Call[] = [];
const called = (path: string) => calls.filter(call => call.path.split('?')[0] === path);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const receipt = (size: number) => ({ id: U, transferId: U, name: 'a.bin', size, url: `https://fyl.at/d/${U}/a.bin`, expiresAt: Date.now() + 86400000, state: 'ready', managementUrl: `https://fyl.at/#manage/${U}/${K}`, deleteToken: K });
let size = 7;
let server: (call: Call) => Response | Promise<Response>;
const standard = (call: Call) => {
  const path = call.path.split('?')[0];
  if (path === '/api/upload/init') return json({ uploadId: U, key: K, url: 'https://fyl.at/d/' + U }, 201);
  if (path === '/api/upload/complete') return json(receipt(size));
  if (path === '/api/upload/abort') return json({ aborted: true });
  return json({ error: 'API endpoint not found.', code: 'not_found' }, 404);
};
const options = { minutes: 1440, once: false };
const payload = () => new Blob(['payload']);
const run = (file: Blob, resume: Session | null = null, controller = new AbortController(), stages: string[] = []) =>
  api.upload(file, options, controller, (_value, stage) => { stages.push(stage); }, resume);
const md5 = (bytes: Uint8Array) => spark.ArrayBuffer.hash(bytes.buffer as ArrayBuffer);
// A file of tests/vectors/, shared with the server and the CLI, or null while the server package hasn't added it. A file
// that exists but doesn't parse fails the test that reads it instead of passing for a missing one.
const sharedVectors = async (name: string) => {
  try { return (await import(/* @vite-ignore */ './vectors/' + name)).default as unknown; }
  catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null;
    throw new Error(`tests/vectors/${name} could not be read: ${(error as Error).message}`);
  }
};

beforeAll(async () => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { origin: 'https://fyl.at' });
  await englishText();
  // @ts-expect-error: a browser module without type declarations.
  jobs = await import('../dist/e2ee/jobs.js');
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    const call = { path, method: init.method || 'GET', body: init.body ? JSON.parse(String(init.body)) : null, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    calls.push(call);
    return server(call);
  });
  // @ts-expect-error: a browser script without type declarations; it defines window.FylAPI.
  await import('../dist/api.js');
  // @ts-expect-error: a browser script without type declarations; vitest loads it as a CommonJS module.
  spark = (await import('../dist/vendor/spark-md5-3.0.2.js')).default;
  api = (globalThis as unknown as { FylAPI: Upload }).FylAPI;
});
afterEach(() => {
  vi.useRealTimers(); requests.length = 0; calls.length = 0; size = 7; server = standard; script = xhr => xhr.respond();
  FakeWorker.created = 0; FakeWorker.broken = false; FakeWorker.modules = [];
});
afterAll(() => { vi.unstubAllGlobals(); });
server = standard;

describe('web upload client', () => {
  it('finishes a part on a slow uplink, however long it takes, while data keeps moving', async () => {
    vi.useFakeTimers();
    // 50 MiB at 1 Mbit/s: about seven minutes, with progress every minute.
    script = xhr => { for (let minute = 1; minute <= 7; minute++) xhr.later(minute * 60000, () => (minute < 7 ? xhr.progress(minute) : xhr.respond())); };
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(8 * 60000);
    await expect(result).resolves.toMatchObject({ id: U, ownerKey: K });
    expect(requests).toHaveLength(1);
  });

  it('retries a part whose connection sends nothing for two minutes, like a dropped connection', async () => {
    vi.useFakeTimers();
    script = xhr => { if (requests.length > 1) xhr.later(1000, () => xhr.respond()); };
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(119000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ id: U });
    expect(requests).toHaveLength(2);
  });

  it('keeps the session for a resume when every attempt stalls, and cancels without retrying', async () => {
    vi.useFakeTimers();
    script = () => {};
    const stalled = run(payload());
    const failure = expect(stalled).rejects.toMatchObject({ resumable: true, status: 0 });
    await vi.advanceTimersByTimeAsync(10 * 60000);
    await failure;
    expect(requests).toHaveLength(3);
    expect(called('/api/upload/abort')).toHaveLength(0);

    requests.length = 0;
    const controller = new AbortController();
    const cancelled = run(payload(), null, controller);
    const cancel = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await cancel;
    expect(requests).toHaveLength(1);
    expect(called('/api/upload/abort')).toHaveLength(1);
  });

  it('sends the password at init and hands over the link before the file is uploaded', async () => {
    vi.useFakeTimers();
    script = xhr => xhr.later(60000, () => xhr.respond());
    const links: string[] = [];
    const result = api.upload(payload(), { ...options, password: 'tide-lamp-fern-41' }, new AbortController(), () => {}, null, session => { links.push(session.url); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(links).toEqual(['https://fyl.at/d/' + U]);
    expect(called('/api/upload/init').map(call => call.body)).toMatchObject([{ password: 'tide-lamp-fern-41', expiresIn: 86400, oneTime: false }]);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(result).resolves.toMatchObject({ id: U });

    // Without a password the field is left out, so the upload is not protected.
    script = xhr => xhr.respond();
    await run(payload());
    expect(called('/api/upload/init')[1].body).not.toHaveProperty('password');
  });

  it('generates passphrases of three words and two digits that the server accepts', () => {
    const phrases = Array.from({ length: 2000 }, () => api.passphrase());
    for (const phrase of phrases) {
      expect(phrase).toMatch(/^[a-z]{3,5}-[a-z]{3,5}-[a-z]{3,5}-\d{2}$/);
      expect(api.validPassword(phrase)).toBe(true);
    }
    // 256 words: two thousand draws of three see nearly all of them, and repeat a whole phrase almost never.
    expect(new Set(phrases.flatMap(phrase => phrase.split('-').slice(0, 3))).size).toBeGreaterThan(240);
    expect(new Set(phrases).size).toBeGreaterThan(1990);
  });
});

describe('shared vectors', () => {
  it('tells a vector file not added yet from one that exists', async () => {
    await expect(sharedVectors('not-added-yet.json')).resolves.toBeNull();
    await expect(sharedVectors('errors.json')).resolves.not.toBeNull();
  });
});

// The error classes of the protocol (contract §1): the client's table must match tests/vectors/errors.json.
describe('retry classes', () => {
  it('classifies statuses and codes like the shared table', async () => {
    const table: [number, string, string][] = [[0, '', 'retry'], [408, '', 'retry'], [429, 'rate_limited', 'retry'], [500, '', 'retry'],
      [502, '', 'retry'], [503, 'part_busy', 'retry'], [504, '', 'retry'], [400, '', 'permanent'], [401, '', 'permanent'], [403, 'quarantined', 'permanent'],
      [404, 'not_found', 'permanent'], [409, '', 'permanent'], [410, 'expired', 'permanent'], [413, '', 'permanent'], [415, '', 'permanent'],
      [426, 'upgrade_required', 'permanent'], [409, 'part_limit', 'permanent'], [429, 'part_limit', 'permanent']];
    for (const [status, code, kind] of table) expect([status, code, api.classify(status, code)]).toEqual([status, code, kind]);
    const shared = await sharedVectors('errors.json');
    if (!shared) { console.warn('tests/vectors/errors.json is missing (the server package adds it); checked the built-in table only.'); return; }
    const rows = (Array.isArray(shared) ? shared : Object.values(shared as object).find(Array.isArray) || []) as Record<string, unknown>[];
    const cases = rows.filter(row => typeof row?.class === 'string' && row.class !== 'unclear' && (typeof row.status === 'number' || row.status === null || row.status === 'network'));
    expect(cases.length).toBeGreaterThan(0);
    for (const row of cases) {
      const status = typeof row.status === 'number' ? row.status : 0, code = typeof row.code === 'string' ? row.code : '';
      expect([status, code, api.classify(status, code)]).toEqual([status, code, row.class]);
    }
  });

  it('retries a part that timed out (408) and stays resumable when it keeps failing', async () => {
    vi.useFakeTimers();
    script = xhr => (requests.length === 1 ? xhr.respond(408, { error: 'Request timeout.' }) : xhr.respond());
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ id: U });
    expect(requests).toHaveLength(2);

    requests.length = 0;
    script = xhr => xhr.respond(408, { error: 'Request timeout.' });
    const failing = run(payload()), failure = expect(failing).rejects.toMatchObject({ resumable: true, status: 408 });
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
    expect(requests).toHaveLength(3);
    expect(called('/api/upload/abort')).toHaveLength(0);
  });

  it('gives up at once on an exhausted part limit, whatever its status, and ends the session', async () => {
    script = xhr => xhr.respond(409, { error: 'This part was retried too often.', code: 'part_limit' });
    const failure: Failure = await run(payload()).catch(error => error);
    expect(failure).toMatchObject({ status: 409, kind: 'permanent' });
    expect(failure.resumable).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(called('/api/upload/abort')).toHaveLength(1);
  });

  it('waits as long as Retry-After asks before trying a busy part again', async () => {
    vi.useFakeTimers();
    script = xhr => (requests.length === 1 ? xhr.respond(503, { error: 'Busy.', code: 'part_busy' }, { 'retry-after': '10' }) : xhr.respond());
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(9900);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(2);
    await expect(result).resolves.toMatchObject({ id: U });
  });

  it('asks again with the same idempotency key when the init answer is garbled', async () => {
    vi.useFakeTimers();
    let first = true;
    server = call => {
      if (call.path === '/api/upload/init' && first) { first = false; return json('{"uploadId":"' + U, 201); }
      return standard(call);
    };
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ id: U });
    const inits = called('/api/upload/init');
    expect(inits).toHaveLength(2);
    expect(inits[1].headers['idempotency-key']).toBe(inits[0].headers['idempotency-key']);
    expect(inits[1].body?.clientKey).toBe(inits[0].body?.clientKey);
  });
});

// A 2xx answer to the completion is a receipt only when it passes the schema (contract §4); anything else is
// unclear and must never lose the upload.
describe('completion receipts', () => {
  it('accepts only a complete receipt for this upload', () => {
    const good = receipt(7);
    expect(api.validReceipt(good, U, 7)).toBe(true);
    expect(api.validReceipt({ ...good, url: `http://localhost:8787/d/${U}` }, U, 7)).toBe(true);
    for (const bad of [null, [], 'text', {}, { ...good, url: undefined }, { ...good, url: 'https://fyl.at/d/short' }, { ...good, url: `https://fyl.at/x/${U}` },
      { ...good, url: `https://fyl.at/d/${U}?grant=1` }, { ...good, transferId: 'v'.repeat(43) }, { ...good, transferId: undefined }, { ...good, expiresAt: '1' },
      { ...good, expiresAt: Number.NaN }, { ...good, size: 8 }, { ...good, managementUrl: undefined }])
      expect(api.validReceipt(bad, U, 7)).toBe(false);
  });

  // tests/vectors/receipts.json: [{note, receipt, uploadId?, size?, valid}], shared with the server and the CLI. The site
  // always completes with the management key, so it also needs the management link that a receipt for a completion
  // without the key may leave out.
  it('agrees with the shared receipt vectors', async ({ skip }) => {
    const vectors = await sharedVectors('receipts.json');
    skip(!vectors, 'tests/vectors/receipts.json is missing (the server package adds it)');
    const cases = (Array.isArray(vectors) ? vectors : (vectors as { cases?: unknown }).cases) as
      { note?: string; receipt?: unknown; body?: unknown; uploadId?: string; size?: number; valid: boolean }[];
    expect(Array.isArray(cases) && cases.length > 0).toBe(true);
    for (const vector of cases) {
      const body = 'receipt' in vector ? vector.receipt : vector.body, fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const expected = vector.valid && typeof fields.managementUrl === 'string';
      expect([vector.note, api.validReceipt(body, vector.uploadId ?? String(fields.transferId), vector.size ?? Number(fields.size))])
        .toEqual([vector.note, expected]);
    }
  });

  it('asks again after a truncated receipt and returns the same transfer', async () => {
    vi.useFakeTimers();
    let broken = 2;
    server = call => call.path === '/api/upload/complete' && broken-- > 0 ? json(JSON.stringify(receipt(size)).slice(0, 40)) : standard(call);
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toMatchObject({ id: U, ownerKey: K, url: `https://fyl.at/d/${U}/a.bin` });
    expect(called('/api/upload/complete')).toHaveLength(3);
    expect(called('/api/upload/init')).toHaveLength(1);
    expect(called('/api/upload/abort')).toHaveLength(0);
  });

  it('checks the status after repeated drops and completes again once the server finished it', async () => {
    vi.useFakeTimers();
    let drops = 5;
    server = call => {
      if (call.path === '/api/upload/complete' && drops-- > 0) throw new TypeError('Failed to fetch');
      if (call.path.startsWith('/api/upload/status')) return json({ status: 'ready', size, parts: [{ partNumber: 1, etag: 'etag-0' }] });
      return standard(call);
    };
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(60000);
    await expect(result).resolves.toMatchObject({ id: U, ownerKey: K });
    expect(called('/api/upload/complete')).toHaveLength(6);
    expect(called('/api/upload/status')).toHaveLength(1);
  });

  it('keeps the session when the receipt stays unreadable, and never aborts it', async () => {
    vi.useFakeTimers();
    server = call => {
      if (call.path === '/api/upload/complete') return json({ url: `https://fyl.at/d/${U}` });
      if (call.path.startsWith('/api/upload/status')) return json({ status: 'completing', size, parts: [] });
      return standard(call);
    };
    const result = run(payload()), failure = expect(result).rejects.toMatchObject({ resumable: true, kind: 'unclear' });
    await vi.advanceTimersByTimeAsync(120000);
    await failure;
    expect(called('/api/upload/complete')).toHaveLength(10);
    expect(called('/api/upload/abort')).toHaveLength(0);
  });

  it('honours Retry-After on a busy completion, up to a minute', async () => {
    vi.useFakeTimers();
    let busy = 1;
    server = call => call.path === '/api/upload/complete' && busy-- > 0 ? json({ error: 'Busy.', code: 'temporarily_unavailable' }, 503, { 'Retry-After': '600' }) : standard(call);
    const result = run(payload());
    await vi.advanceTimersByTimeAsync(59000);
    expect(called('/api/upload/complete')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toMatchObject({ id: U });
    expect(called('/api/upload/complete')).toHaveLength(2);
  });
});

describe('management requests', () => {
  // The server's contract: PATCH /api/transfers/<id> with {"clearPause": true} on its own answers the owner info.
  it('lifts the password pauses with the management key, as a request of its own', async () => {
    const view = { id: U, owner: true, protected: true, passwordPause: { until: null, networks: 0 } };
    server = call => call.path === `/api/transfers/${U}` ? json(view) : standard(call);
    await expect(api.unpause(U, K)).resolves.toEqual(view);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: `/api/transfers/${U}`, method: 'PATCH', body: { clearPause: true },
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + K } });
  });
});

// A resume checks every finished part against the file: R2's ETag for a part is the MD5 of its bytes.
describe('resume verification', () => {
  const file = (...fills: number[]) => new Blob(fills.map((fill, index) => new Uint8Array(index < fills.length - 1 ? PART : 1000).fill(fill)));
  const part = (fill: number, length = PART) => new Uint8Array(length).fill(fill);
  const session = { uploadId: U, key: K, url: 'https://fyl.at/d/' + U };

  it('uploads again only the parts that changed or cannot be checked', async () => {
    // The file changed in its second part since; the third part's ETag is no MD5 (the local R2 simulator).
    const current = file(1, 9, 3);
    size = current.size;
    server = call => call.path.startsWith('/api/upload/status')
      ? json({ status: 'uploading', size, parts: [{ partNumber: 1, etag: `"${md5(part(1))}"` }, { partNumber: 2, etag: md5(part(2)) }, { partNumber: 3, etag: 'local-etag' }] })
      : standard(call);
    const stages: string[] = [];
    await expect(run(current, session, new AbortController(), stages)).resolves.toMatchObject({ id: U });
    expect(requests.map(xhr => xhr.partNumber).sort()).toEqual([2, 3]);
    const sent = await requests.find(xhr => xhr.partNumber === 2)?.sent?.arrayBuffer();
    expect(sent && md5(new Uint8Array(sent))).toBe(md5(part(9)));
    expect(stages).toContain('Checking uploaded parts… 0 %');
    expect(stages).toContain('Checking uploaded parts… 100 %');
    expect(called('/api/upload/complete')[0].body?.parts).toEqual([
      { partNumber: 1, etag: `"${md5(part(1))}"` }, { partNumber: 2, etag: expect.stringMatching(/^etag-/) }, { partNumber: 3, etag: expect.stringMatching(/^etag-/) }]);
  });

  it('keeps every part of an unchanged file', async () => {
    const current = file(4, 5);
    size = current.size;
    server = call => call.path.startsWith('/api/upload/status')
      ? json({ status: 'uploading', size, parts: [{ partNumber: 1, etag: md5(part(4)) }, { partNumber: 2, etag: md5(part(5, 1000)).toUpperCase() }] })
      : standard(call);
    await expect(run(current, session)).resolves.toMatchObject({ id: U });
    expect(requests).toHaveLength(0);
    expect(FakeWorker.created).toBe(1);
  });

  it('uploads the parts again when they cannot be checked at all', async () => {
    FakeWorker.broken = true;
    server = call => call.path.startsWith('/api/upload/status') ? json({ status: 'uploading', size, parts: [{ partNumber: 1, etag: md5(new TextEncoder().encode('payload')) }] }) : standard(call);
    await expect(run(payload(), session)).resolves.toMatchObject({ id: U });
    expect(requests).toHaveLength(1);
  });

  it('replays the completion of an upload the server already finished, without reading the file', async () => {
    server = call => call.path.startsWith('/api/upload/status') ? json({ status: 'ready', size, parts: [{ partNumber: 1, etag: 'etag-7', extra: true }] }) : standard(call);
    await expect(run(payload(), session)).resolves.toMatchObject({ id: U, ownerKey: K });
    expect(FakeWorker.created).toBe(0);
    expect(requests).toHaveLength(0);
    expect(called('/api/upload/complete')[0].body?.parts).toEqual([{ partNumber: 1, etag: 'etag-7' }]);
  });

  it('refuses to resume an upload of another size or one that is closed', async () => {
    server = call => call.path.startsWith('/api/upload/status') ? json({ status: 'uploading', size: 8, parts: [] }) : standard(call);
    await expect(run(payload(), session)).rejects.toMatchObject({ stale: true });
    server = call => call.path.startsWith('/api/upload/status') ? json({ status: 'expired', size, parts: [] }) : standard(call);
    await expect(run(payload(), session)).rejects.toMatchObject({ stale: true });
  });
});

// One password rule everywhere (contract §7): code points after NFC, 6 to 200, no Cc or Cs.
describe('password rule', () => {
  const builtIn: [string, boolean][] = [
    ['abcdef', true], ['abcde', false], ['a'.repeat(200), true], ['a'.repeat(201), false],
    ['\u{1F600}'.repeat(3), false], ['\u{1F600}'.repeat(6), true], // emoji: two UTF-16 units, one code point
    ['é'.repeat(5) + 'x', true], ['é'.repeat(5), false], // NFD é composes to one code point: 6 and 5
    ['क़'.repeat(3), true], // U+0958 is excluded from composition: NFC expands it to two code points
    ['é'.repeat(200), true], ['é'.repeat(200), true], ['é'.repeat(201), false],
    ['abc\u0000def', false], ['abcdef\n', false], ['abc\u007fdef', false], ['abc\u0085def', false], ['abc\ud800def', false],
    ['tide lamp', true], ['abc​def', true],
  ];
  it('matches the server on the built-in cases', () => {
    for (const [input, valid] of builtIn) expect([JSON.stringify(input), api.validPassword(input)]).toEqual([JSON.stringify(input), valid]);
  });
  it('matches the shared vectors', async () => {
    const vectors = await sharedVectors('passwords.json') as { input: string; valid: boolean; note?: string }[] | null;
    if (!vectors) { console.warn('tests/vectors/passwords.json is missing (the server package adds it); checked the built-in cases only.'); return; }
    expect(vectors.length).toBeGreaterThan(0);
    for (const { input, valid, note } of vectors) expect([note ?? input, api.validPassword(input)]).toEqual([note ?? input, valid]);
  });
});

// End-to-end encryption in the upload client (docs/E2EE.md §7, §8): the server here answers like the 2.4.0 Worker, and
// every upload is decrypted again with the core to show that what left the page is the file.
describe('encrypted uploads', () => {
  interface Records { get(uploadId: string): Record<number, string>; put(uploadId: string, part: number, md5: string): boolean | 'replaced' | Promise<boolean | 'replaced'> }
  interface E2EESession extends Session { e2eeKey?: string; share?: string; mode?: string }
  interface Refusal { kind?: string; code?: string; message: string; resumable?: boolean }
  type Encrypt = (file: Blob, options: Options & { e2ee: true; records: Records }, controller: AbortController, onProgress: Progress,
    resume?: E2EESession | null, onSession?: (session: E2EESession) => unknown) => Promise<{ id: string; url: string; name: string; size: number; mode: string; e2eeKey: string }>;
  interface Core {
    checkKey(key: string, head: Uint8Array, meta: Uint8Array, size: number): Promise<{ name: string; size: number; content: object }>;
    decodeBlob(text: string): Uint8Array; decryptBytes(key: object, data: Uint8Array): Promise<Uint8Array>; ciphertextSize(P: number): number;
    md5(data: Uint8Array): Uint8Array;
  }
  let age: Core;
  const encrypt = (...args: Parameters<Encrypt>) => (api.upload as unknown as Encrypt)(...args);
  const plain = (length: number, seed = 0) => Uint8Array.from({ length }, (_, i) => (i + seed) % 251);
  const named = (bytes: Uint8Array, name = 'a.bin') => new File([bytes as Uint8Array<ArrayBuffer>], name);
  const log: string[] = [];
  // `writable`: what the page's record answers, true once stored, false when it can't be written, 'replaced' when an
  // upload started in another tab took its place.
  let local: Record<number, string> = {}, writable: boolean | 'replaced' = true, init: Record<string, unknown> | null = null, pins = new Map<number, string>();
  let status: Record<string, unknown> = {}, completion: () => unknown = () => null;
  const records: Records = {
    get: () => local,
    put: (_uploadId, part, md5) => { log.push('record ' + part); if (writable !== true) return writable; local[part] = md5; return true; },
  };
  const encrypted = (call: Call) => {
    const path = call.path.split('?')[0];
    if (path === '/api/upload/init') { init = call.body; return json({ uploadId: U, key: K, url: 'https://fyl.at/d/' + U, mode: 'e2ee' }, 201); }
    if (path === '/api/upload/pin') {
      const { partNumber, md5 } = call.body as { partNumber: number; md5: string };
      log.push('pin ' + partNumber);
      if (pins.has(partNumber) && pins.get(partNumber) !== md5) return json({ error: 'The file changed.', code: 'part_changed' }, 409);
      pins.set(partNumber, md5);
      return json({ partNumber, md5 });
    }
    if (path === '/api/upload/status') return json(status);
    if (path === '/api/upload/complete') {
      return json(completion() ?? { transferId: U, mode: 'e2ee', name: null, size: Number(init?.size), url: 'https://fyl.at/d/' + U,
        expiresAt: Date.now() + 86400000, state: 'ready', managementUrl: `https://fyl.at/#manage/${U}/${K}` });
    }
    return standard(call);
  };
  // What reached the server for each part: the last body it accepted for it.
  const stored = async () => {
    const parts = new Map<number, Uint8Array>();
    for (const xhr of requests) if (xhr.status === 200 && xhr.sent) parts.set(xhr.partNumber, new Uint8Array(await xhr.sent.arrayBuffer()));
    return new Uint8Array(await new Blob([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes as Uint8Array<ArrayBuffer>)).arrayBuffer());
  };
  const opened = async (key: string) => {
    const e2ee = init?.e2ee as { head: string; meta: string };
    return age.checkKey(key, age.decodeBlob(e2ee.head), age.decodeBlob(e2ee.meta), Number(init?.size));
  };
  // No request, of any kind, carries the key or a fragment (§2.2).
  const keyless = (key: string) => {
    const seen = [...calls.map(call => JSON.stringify(call)), ...requests.map(xhr => xhr.url + JSON.stringify(xhr.requestHeaders))];
    expect(seen.filter(text => text.includes(key) || text.includes('#'))).toEqual([]);
  };
  const statusOf = (extra: Record<string, unknown> = {}) => ({ status: 'uploading', size: Number(init?.size), parts: [], mode: 'e2ee',
    e2ee: init?.e2ee, pins: [...pins.entries()].map(([partNumber, md5]) => ({ partNumber, md5 })), ...extra });

  beforeAll(async () => {
    // @ts-expect-error: dist/e2ee is plain browser ES modules without type declarations.
    age = await import('../dist/e2ee/age.js');
  });
  beforeEach(() => {
    server = encrypted; local = {}; writable = true; init = null; pins = new Map(); log.length = 0; status = {}; completion = () => null;
    script = xhr => { log.push('part ' + xhr.partNumber); xhr.respond(); };
  });

  it('encrypts in the browser: no name at init, the MD5 recorded and pinned before each part, Content-MD5 equal to the pin', async () => {
    const bytes = plain(70000), sessions: E2EESession[] = [];
    const result = await encrypt(named(bytes, 'Q3 report.pdf'), { ...options, e2ee: true, records }, new AbortController(), () => {}, null, session => { sessions.push(session); });
    const key = result.e2eeKey;
    expect(init).toMatchObject({ mode: 'e2ee', size: age.ciphertextSize(70000), expiresIn: 86400, oneTime: false, partSize: PART });
    expect(init).not.toHaveProperty('filename');
    const e2ee = init?.e2ee as { head: string; meta: string };
    expect([age.decodeBlob(e2ee.head).length, age.decodeBlob(e2ee.meta).length]).toEqual([184, 712]);
    expect(called('/api/upload/init')[0].headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
    // The keyed link is built here from this page's origin; the receipt keeps the link without the key.
    expect(sessions.map(session => session.share)).toEqual([`https://fyl.at/d/${U}#${key}`]);
    expect(result).toMatchObject({ id: U, url: 'https://fyl.at/d/' + U, name: 'Q3 report.pdf', size: 70000, mode: 'e2ee' });
    expect(log).toEqual(['record 1', 'pin 1', 'part 1']);
    const sent = new Uint8Array(await (requests[0].sent as Blob).arrayBuffer());
    expect([pins.get(1), local[1]]).toEqual([md5(sent), md5(sent)]);
    expect(requests[0].requestHeaders['content-md5']).toBe(btoa(String.fromCharCode(...age.md5(sent))));
    expect(requests[0].requestHeaders['content-md5']).toHaveLength(24);
    // What the server stores opens with the key, to the file and its name.
    const checked = await opened(key);
    expect([checked.name, checked.size]).toEqual(['Q3 report.pdf', 70000]);
    expect(await age.decryptBytes(checked.content, await stored())).toEqual(bytes);
    keyless(key);
  });

  it('stops before any part when the server ignores the mode or answers with a link that isn\'t <origin>/d/<ID>', async () => {
    const answers = [{ uploadId: U, key: K, url: 'https://fyl.at/d/' + U }, { uploadId: U, key: K, url: 'https://evil.example/d/' + U, mode: 'e2ee' },
      { uploadId: U, key: K, url: 'http://fyl.at/d/' + U, mode: 'e2ee' }, { uploadId: U, key: K, url: `https://fyl.at/d/${'w'.repeat(43)}`, mode: 'e2ee' },
      { uploadId: U, key: K, url: `https://fyl.at/d/${U}/a.bin`, mode: 'e2ee' }];
    for (const answer of answers) {
      calls.length = 0; requests.length = 0;
      server = call => call.path === '/api/upload/init' ? json(answer, 201) : encrypted(call);
      const sessions: unknown[] = [];
      await expect(encrypt(named(plain(10)), { ...options, e2ee: true, records }, new AbortController(), () => {}, null, session => { sessions.push(session); }))
        .rejects.toMatchObject({ kind: 'permanent', code: answer.mode ? 'url_mismatch' : 'mode_mismatch' });
      expect([sessions, called('/api/upload/pin'), requests.length, called('/api/upload/abort').length]).toEqual([[], [], 0, 1]);
    }
  });

  it('sends the same Blob again after a failed attempt, and a part stored damaged once more before it stops resumable', async () => {
    vi.useFakeTimers();
    script = xhr => requests.length === 1 ? xhr.respond(503, { error: 'Busy.', code: 'temporarily_unavailable' }) : xhr.respond();
    const first = encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {});
    await vi.advanceTimersByTimeAsync(10000);
    await expect(first).resolves.toMatchObject({ mode: 'e2ee' });
    expect(requests).toHaveLength(2);
    expect(requests[1].sent).toBe(requests[0].sent);
    expect(called('/api/upload/pin')).toHaveLength(1);

    requests.length = 0; calls.length = 0; pins = new Map(); local = {};
    script = xhr => xhr.respond(502, { error: 'The stored part is damaged.', code: 'part_corrupt' });
    const second = encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {});
    const failure = expect(second).rejects.toMatchObject({ code: 'part_corrupt', resumable: true });
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
    expect(requests).toHaveLength(2);
    expect(requests[1].sent).toBe(requests[0].sent);
    expect(called('/api/upload/abort')).toHaveLength(0);
  });

  it('ends the upload when a pin is refused as changed, and sends no body', async () => {
    pins.set(1, 'f'.repeat(32));
    await expect(encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {}))
      .rejects.toMatchObject({ code: 'part_changed', message: 'The file changed since this upload started. Start a new upload.' });
    expect([requests.length, called('/api/upload/abort').length]).toEqual([0, 1]);
  });

  it('sends nothing for a part whose record can\'t be written, or whose recorded MD5 differs, and keeps the upload', async () => {
    writable = false;
    await expect(encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {})).rejects.toMatchObject({ kind: 'refused', code: 'record_failed' });
    expect([called('/api/upload/pin').length, requests.length, called('/api/upload/abort').length]).toEqual([0, 0, 0]);
    writable = true; local = { 1: 'f'.repeat(32) }; calls.length = 0;
    await expect(encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {}))
      .rejects.toMatchObject({ kind: 'refused', code: 'file_changed', message: 'The file changed since this upload started. Start a new upload.' });
    expect([called('/api/upload/pin').length, requests.length, called('/api/upload/abort').length]).toEqual([0, 0, 0]);
  });

  it('stops like an interrupted upload, sending nothing more, when an upload started in another tab replaced the record', async () => {
    writable = 'replaced';
    await expect(encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {})).rejects.toMatchObject({
      kind: 'replaced', code: 'record_replaced', resumable: true,
      message: 'The upload was interrupted, and an upload started in another tab has replaced it. Start it again.' });
    // The page, finding the record replaced, discards the session (tests/web-app.test.ts); nothing is pinned or sent.
    expect([log, called('/api/upload/pin').length, requests.length, called('/api/upload/abort').length]).toEqual([['record 1'], 0, 0, 0]);
  });

  it('takes a file that can no longer be read as changed, without ending the upload', async () => {
    class Changed extends Blob {
      slice() { return { arrayBuffer: () => Promise.reject(new DOMException('The file changed.', 'NotReadableError')) } as unknown as Blob; }
    }
    await expect(encrypt(new Changed([plain(1000) as Uint8Array<ArrayBuffer>]), { ...options, e2ee: true, records }, new AbortController(), () => {}))
      .rejects.toMatchObject({ kind: 'refused', code: 'file_changed' });
    expect([requests.length, called('/api/upload/abort').length]).toEqual([0, 0]);
  });

  it('builds each part in a dedicated module worker, and on the page where that worker doesn\'t start', async () => {
    await encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {});
    expect(FakeWorker.modules).toEqual(['/e2ee/worker.js']);
    requests.length = 0; pins = new Map(); local = {}; FakeWorker.broken = true;
    const result = await encrypt(named(plain(1000)), { ...options, e2ee: true, records }, new AbortController(), () => {});
    expect(await age.decryptBytes((await opened(result.e2eeKey)).content, await stored())).toEqual(plain(1000));
  });

  it('keeps at most two parts in flight, each built in its own worker', async () => {
    // Two parts (50 MiB + 1 KiB) and a slow answer: both lanes run, never more.
    const piece = plain(65536), file = new File([...Array.from({ length: 800 }, () => piece as Uint8Array<ArrayBuffer>), plain(1024) as Uint8Array<ArrayBuffer>], 'a.bin');
    let inflight = 0, most = 0;
    script = xhr => { inflight++; most = Math.max(most, inflight); setTimeout(() => { inflight--; xhr.respond(); }, 50); };
    await encrypt(file, { ...options, e2ee: true, records }, new AbortController(), () => {});
    expect([requests.length, most, FakeWorker.modules.length, Object.keys(local)]).toEqual([2, 2, 2, ['1', '2']]);
    expect(requests.map(xhr => [xhr.partNumber, xhr.sent?.size]).sort()).toEqual([[1, PART], [2, age.ciphertextSize(PART + 1024) - PART]]);
  }, 120000);

  // docs/FOLDER-ZIP.md §7.3: a folder zip's parts report the CRC-32 of the entry bytes they encrypted (each chunk counted
  // by the part it starts in); before completing, every entry's pieces must give its CRC from the pre-pass.
  it('checks every entry of a folder zip across the part boundary before completing, and stops without completing on a mismatch', async () => {
    vi.stubGlobal('window', globalThis);
    // @ts-expect-error: a browser script without type declarations; it defines window.FylZip.
    await import('../dist/zip.js');
    // @ts-expect-error: a browser module without type declarations.
    const { crc32 } = await import('../dist/e2ee/crc32.js') as { crc32: (bytes: Uint8Array, crc?: number) => number };
    type Zip = { gather(root: string, items: object[]): { entries: { file: Blob }[] }; check(entries: object[], limit: number): object;
      file(root: string, out: object, crcs: number[]): File; dataRanges(out: object): [number, number][] };
    const zip = (globalThis as unknown as { FylZip: Zip }).FylZip;
    // a.bin (801 × 64 KiB) crosses the 50 MiB part boundary, with a 64 KiB chunk on it; b.txt follows in part 2.
    const piece = plain(65536, 3), tail = new TextEncoder().encode('second file\n');
    let crc = 0;
    for (let i = 0; i < 801; i++) crc = crc32(piece, crc);
    const files = [new Blob(Array.from({ length: 801 }, () => piece as Uint8Array<ArrayBuffer>)), new Blob([tail])];
    const { entries } = zip.gather('photos', ['a.bin', 'b.txt'].map((name, i) => ({ parts: [name], size: files[i].size, mtimeMs: 1793260800000, file: files[i] })));
    const out = zip.check(entries, 50 * 1024 ** 3), crcs = [crc, crc32(tail)], file = zip.file('photos', out, crcs);
    const folder = { ranges: zip.dataRanges(out), crcs };
    expect(folder.ranges[0][1]).toBeGreaterThan(PART);
    const result = await encrypt(file, { ...options, e2ee: true, records, folder } as Parameters<Encrypt>[1], new AbortController(), () => {});
    expect([result.name, result.size, requests.length, called('/api/upload/complete').length]).toEqual(['photos.zip', file.size, 2, 1]);
    // The same zip whose a.bin the pre-pass read differently: nothing completes, and the upload stays for a resume.
    requests.length = 0; calls.length = 0; pins = new Map(); local = {};
    await expect(encrypt(file, { ...options, e2ee: true, records, folder: { ...folder, crcs: [crcs[0] ^ 1, crcs[1]] } } as Parameters<Encrypt>[1], new AbortController(), () => {}))
      .rejects.toMatchObject({ kind: 'refused', code: 'file_changed', message: 'A file in the folder changed while it was uploaded. Start a new upload.' });
    expect([requests.length, called('/api/upload/complete').length, called('/api/upload/abort').length]).toEqual([2, 0, 0]);
  }, 120000);

  it('refuses a receipt whose link isn\'t <origin>/d/<ID>, without ending the upload', async () => {
    completion = () => ({ transferId: U, mode: 'e2ee', name: null, size: Number(init?.size), url: 'https://evil.example/d/' + U, expiresAt: Date.now() + 86400000,
      state: 'ready', managementUrl: `https://fyl.at/#manage/${U}/${K}` });
    await expect(encrypt(named(plain(10)), { ...options, e2ee: true, records }, new AbortController(), () => {})).rejects.toMatchObject({ code: 'url_mismatch' });
    expect(called('/api/upload/abort')).toHaveLength(0);
  });

  describe('resume (§8.4)', () => {
    // A first run records, pins and sends part 1 of a one-part file, which the server keeps refusing: the upload stays
    // resumable with the part pinned.
    async function interrupted(bytes: Uint8Array) {
      vi.useFakeTimers();
      script = xhr => xhr.respond(503, { error: 'Busy.', code: 'temporarily_unavailable' });
      let key = '';
      const run = encrypt(named(bytes), { ...options, e2ee: true, records }, new AbortController(), () => {}, null, session => { key = session.e2eeKey || ''; });
      const failure = expect(run).rejects.toMatchObject({ resumable: true });
      await vi.advanceTimersByTimeAsync(30000);
      await failure;
      vi.useRealTimers();
      requests.length = 0; calls.length = 0; log.length = 0;
      script = xhr => { log.push('part ' + xhr.partNumber); xhr.respond(); };
      return { key, session: { uploadId: U, key: K, url: 'https://fyl.at/d/' + U, e2eeKey: key } };
    }

    it('rebuilds every pinned part from the file and goes on only if it equals the pin and the local record', async () => {
      const bytes = plain(5000), { key, session } = await interrupted(bytes);
      status = statusOf();
      const result = await encrypt(named(bytes), { ...options, e2ee: true, records }, new AbortController(), () => {}, session);
      // Part 1 was pinned already: its record is written again with the same MD5, and no new pin is asked for.
      expect(log).toEqual(['record 1', 'part 1']);
      expect(result).toMatchObject({ mode: 'e2ee', e2eeKey: key, name: 'a.bin' });
      expect(await age.decryptBytes((await opened(key)).content, await stored())).toEqual(bytes);
      keyless(key);
    });

    it('refuses, without ending the upload, a changed file, a wrong key, a status without pins and a confirmed part it can\'t check', async () => {
      const bytes = plain(5000), { session } = await interrupted(bytes);
      const refused = async (file: Blob, resume: E2EESession, code: string) => {
        calls.length = 0; requests.length = 0;
        const failure = await encrypt(file, { ...options, e2ee: true, records }, new AbortController(), () => {}, resume).catch((error: Refusal) => error) as Refusal;
        expect([failure.kind, failure.code, failure.resumable]).toEqual(['refused', code, undefined]);
        expect([requests.length, called('/api/upload/pin').length, called('/api/upload/abort').length]).toEqual([0, 0, 0]);
        return failure;
      };
      status = statusOf();
      expect((await refused(named(plain(5000, 7)), session, 'file_changed')).message).toBe('The file changed since this upload started. Start a new upload.');
      await refused(named(plain(5001)), session, 'file_changed');
      expect((await refused(named(bytes), { ...session, e2eeKey: 'A'.repeat(43) }, 'key_wrong')).message).toMatch(/^This key doesn’t open this upload/);
      // The local record outlives what the server says: a part it knows differently is refused.
      const kept = local;
      local = { 1: 'f'.repeat(32) };
      await refused(named(bytes), session, 'file_changed');
      local = kept;
      status = statusOf({ pins: undefined });
      await refused(named(bytes), session, 'resume_unsafe');
      status = statusOf({ mode: 'raw' });
      await refused(named(bytes), session, 'resume_unsafe');
      status = statusOf({ pins: [], parts: [{ partNumber: 1, etag: 'not-an-md5' }] });
      await refused(named(bytes), session, 'resume_unsafe');
    });

    it('keeps a confirmed part equal to its pin and sends only the others', async () => {
      const bytes = plain(5000), { key, session } = await interrupted(bytes);
      status = statusOf({ parts: [{ partNumber: 1, etag: pins.get(1) }] });
      await encrypt(named(bytes), { ...options, e2ee: true, records }, new AbortController(), () => {}, session);
      expect(requests).toHaveLength(0);
      expect(called('/api/upload/complete')[0].body).toMatchObject({ parts: [{ partNumber: 1, etag: pins.get(1) }] });
      keyless(key);
    });
  });
});
