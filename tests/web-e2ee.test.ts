import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { englishText } from './english';
import content from './vectors/e2ee/content.json';
import layout from './vectors/e2ee/layout.json';
import links from './vectors/e2ee/links.json';

// The browser pieces of end-to-end encryption around the core (docs/E2EE.md): the part builder and the download
// producer of dist/e2ee/jobs.js, the download service worker dist/_dl/sw.js, and the DOM-free helpers the download page
// and the report form share with the rest. The core itself is tested in e2ee-core.test.ts.

interface Core {
  prepareUpload(name: string, size: number): Promise<{ key: string; head: Uint8Array; meta: Uint8Array; ciphertextSize: number; content: object }>;
  encryptPart(content: object, source: Uint8Array, part: number, options: { partSize: number }): Promise<Uint8Array>;
  encodeBlob(data: Uint8Array): string; plaintextSize(C: number): number | null; md5Hex(data: Uint8Array): string;
}
type Emit = (event: { type: string; code?: string; verified?: number; status?: number; serverCode?: string | null }) => void;
interface Jobs {
  buildPart(transfer: { key: string; head: string; size: number; partSize?: number }, file: Blob, part: number): Promise<{ blob: Blob; md5: string; contentMd5: string }>;
  produce(download: Record<string, unknown>, port: Port, emit: Emit, options: { fetch: (url: string, init: RequestInit) => Promise<Response>; wait?: () => Promise<void> }): Promise<void>;
}
interface Page {
  addressKey(pathname: string, hash: string): { id: string | null; key: string | null; exposed: boolean; invalid: boolean };
  plainSize(C: number): number | null; kind(name: string): { ext: string; type: string; risky: boolean };
  basic(password: string): string; appleTouch(nav: object): boolean; streams(nav: object): boolean; MEMORY_LIMIT: number;
}
interface Report {
  linkId(text: string, host?: string): string | null; withoutKey(text: string): string;
  problems(fields: Record<string, unknown>, host?: string): Record<string, string>;
}

// One end of a MessageChannel; the other end is driven by the test. workerd's channel takes no transfer list. `fire`
// plays an event such as `close`, which some browsers dispatch when the other end's page went away.
class Port {
  other: Port | null = null; closed = false; onmessage: ((event: { data: unknown }) => unknown) | null = null;
  listeners = new Map<string, (() => void)[]>();
  postMessage(data: unknown) { const target = this.other; if (!this.closed && target) void Promise.resolve().then(() => { if (!target.closed) target.onmessage?.({ data }); }); }
  close() { this.closed = true; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  fire(type: string) { for (const listener of this.listeners.get(type) || []) listener(); }
}
const channel = () => { const port1 = new Port(), port2 = new Port(); port1.other = port2; port2.other = port1; return { port1, port2 }; };
const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });
const hex = (text: string) => Uint8Array.from(text.match(/../g) || [], pair => parseInt(pair, 16));
const plain = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

let age: Core, jobs: Jobs, page: Page, report: Report;
beforeAll(async () => {
  // @ts-expect-error: browser modules and scripts without type declarations.
  age = await import('../dist/e2ee/age.js');
  // @ts-expect-error: as above.
  jobs = await import('../dist/e2ee/jobs.js');
  vi.stubGlobal('window', globalThis);
  await englishText();
  // @ts-expect-error: as above.
  await import('../dist/download.js');
  // @ts-expect-error: as above.
  await import('../dist/report.js');
  ({ FylDownload: page, FylReport: report } = globalThis as unknown as { FylDownload: Page; FylReport: Report });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('upload parts (§7 step 4)', () => {
  it('builds every part of the shared vectors on its own, with its pin and Content-MD5, as an immutable Blob', async () => {
    const head = age.encodeBlob(hex((content.file as { head: string }).head));
    for (const slice of content.slices) {
      const file = new Blob([plain(slice.plaintextSize) as Uint8Array<ArrayBuffer>]);
      for (const part of [...slice.parts].reverse()) {
        const built = await jobs.buildPart({ key: content.key, head, size: slice.plaintextSize, partSize: slice.partSize }, file, part.part);
        expect([slice.name, part.part, built.md5, built.contentMd5, built.blob.size]).toEqual([slice.name, part.part, part.md5, part.contentMd5, part.end - part.start]);
        expect(age.md5Hex(new Uint8Array(await built.blob.arrayBuffer()))).toBe(part.md5);
      }
    }
  });

  it('takes a file the browser can no longer read as changed, and refuses a head that doesn\'t open with the key', async () => {
    const head = age.encodeBlob(hex((content.file as { head: string }).head));
    class Changed extends Blob { slice() { return { arrayBuffer: () => Promise.reject(new DOMException('Changed.', 'NotReadableError')) } as unknown as Blob; } }
    await expect(jobs.buildPart({ key: content.key, head, size: 1000 }, new Changed([plain(1000) as Uint8Array<ArrayBuffer>]), 1)).rejects.toMatchObject({ code: 'file_changed' });
    await expect(jobs.buildPart({ key: 'A'.repeat(43), head, size: 1000 }, new Blob([plain(1000) as Uint8Array<ArrayBuffer>]), 1)).rejects.toMatchObject({ code: 'key_wrong' });
  });
});

describe('download producer (§9.2)', () => {
  interface Fixture { key: string; head: string; C: number; P: number; ciphertext: Uint8Array; plaintext: Uint8Array }
  let fx: Fixture;
  beforeAll(async () => {
    const plaintext = plain(400000), prepared = await age.prepareUpload('a.bin', plaintext.length);
    fx = { key: prepared.key, head: age.encodeBlob(prepared.head), C: prepared.ciphertextSize, P: plaintext.length, plaintext,
      ciphertext: await age.encryptPart(prepared.content, plaintext, 1, { partSize: prepared.ciphertextSize }) };
  });
  type Request = { url: string; headers: Record<string, string>; init: RequestInit };
  // Runs the producer against `respond` with a consumer that acks every chunk at once (or never, with `ack` false).
  async function run(respond: (request: Request, index: number) => Response, { ack = true, cancelAfter = 0, download = {} } = {}) {
    const { port1, port2 } = channel(), chunks: Uint8Array[] = [], messages: string[] = [], events: Parameters<Emit>[0][] = [], requests: Request[] = [];
    let inFlight = 0, most = 0;
    port2.onmessage = ({ data }) => {
      const message = data as { type: string; data?: ArrayBuffer };
      messages.push(message.type);
      if (message.type !== 'chunk') return;
      chunks.push(new Uint8Array(message.data as ArrayBuffer)); inFlight++; most = Math.max(most, inFlight);
      if (cancelAfter && chunks.length === cancelAfter) port2.postMessage({ type: 'cancel' });
      else if (ack) { inFlight--; port2.postMessage({ type: 'ack' }); }
    };
    const get = async (url: string, init: RequestInit) => {
      const request = { url, headers: Object.fromEntries(new Headers(init.headers).entries()), init };
      requests.push(request);
      return respond(request, requests.length - 1);
    };
    const done = jobs.produce({ url: 'https://fyl.at/d/' + 'd'.repeat(43) + '?dl=1', key: fx.key, head: fx.head, size: fx.P, ciphertextSize: fx.C, ...download },
      port1, event => { events.push(event); }, { fetch: get, wait: async () => {} });
    // Without acks the producer waits for the consumer for good.
    if (ack) await done;
    for (let round = 0; round < 5; round++) await tick();
    return { chunks, messages, events, requests, most, consumer: port2, plaintext: new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer()) };
  }
  const whole = (bytes = fx.ciphertext) => new Response(bytes as BodyInit, { headers: { 'Content-Length': String(bytes.length), ETag: '"e1"' } });
  // The first `at` bytes arrive, then the connection drops.
  const cut = (bytes: Uint8Array, at: number) => {
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) { if (sent) controller.error(new TypeError('Network lost.')); else { sent = true; controller.enqueue(bytes.slice(0, at)); } } }),
      { headers: { 'Content-Length': String(bytes.length), ETag: '"e1"' } });
  };
  const ranged = (from: number) => new Response(fx.ciphertext.slice(from) as BodyInit, { status: 206, headers: { 'Content-Range': `bytes ${from}-${fx.C - 1}/${fx.C}` } });

  it('hands on verified chunks at most four ahead of the consumer, then the end, with nothing but the request it needs', async () => {
    const result = await run(() => whole());
    expect(result.plaintext).toEqual(fx.plaintext);
    expect(result.messages.at(-1)).toBe('end');
    expect(result.events.map(event => event.type).slice(-2)).toEqual(['progress', 'done']);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ url: 'https://fyl.at/d/' + 'd'.repeat(43) + '?dl=1', headers: {} });
    expect(result.requests[0].init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(JSON.stringify(result.requests)).not.toContain(fx.key);
    const stuck = await run(() => whole(), { ack: false });
    expect([stuck.chunks.length, stuck.messages.includes('end')]).toEqual([4, false]);
    stuck.consumer.postMessage({ type: 'cancel' });
  });

  it('continues after a dropped connection with Range and If-Range from the first chunk not handed on', async () => {
    const at = 184 + 65552 * 2 + 100;
    const result = await run((_request, index) => index === 0 ? cut(fx.ciphertext, at) : ranged(184 + 65552 * 2));
    expect(result.requests.map(request => request.headers)).toEqual([{}, { range: `bytes=${184 + 65552 * 2}-`, 'if-range': '"e1"' }]);
    expect(result.plaintext).toEqual(fx.plaintext);
    // A protected link's password goes along on every request, never the key.
    const basic = await run((_request, index) => index === 0 ? cut(fx.ciphertext, at) : ranged(184 + 65552 * 2), { download: { auth: 'Basic eDpwYXNzd29yZA==' } });
    expect(basic.requests.map(request => request.headers.authorization)).toEqual(['Basic eDpwYXNzd29yZA==', 'Basic eDpwYXNzd29yZA==']);
  });

  it('reports every failure as its §13 code, with an error to the consumer instead of an end', async () => {
    const failed = async (respond: (request: Request, index: number) => Response) => {
      const result = await run(respond);
      expect(result.messages.at(-1)).toBe('error');
      expect(result.messages).not.toContain('end');
      return result.events.at(-1);
    };
    // The object changed under a resume: a 200 where a 206 belongs.
    expect(await failed((_request, index) => index === 0 ? cut(fx.ciphertext, 70000) : whole())).toMatchObject({ type: 'error', code: 'corrupt' });
    // Another length than C, another head than the verified one, a cut-off end, bytes after the end.
    expect(await failed(() => whole(fx.ciphertext.slice(0, -1)))).toMatchObject({ code: 'corrupt' });
    const head = fx.ciphertext.slice(); head[100] ^= 1;
    expect(await failed(() => whole(head))).toMatchObject({ code: 'corrupt' });
    expect(await failed(() => new Response(fx.ciphertext.slice(0, 184 + 65552 * 3) as BodyInit, { headers: { 'Content-Length': String(fx.C) } }))).toMatchObject({ code: 'truncated' });
    // Five resumes, then it gives up.
    const lost = await run(() => cut(fx.ciphertext, 10));
    expect([lost.requests.length, lost.events.at(-1)]).toEqual([6, { type: 'error', code: 'network', status: 0, serverCode: null }]);
    // A refusal says why: the page shows the link's state for 404 and 410.
    expect(await failed(() => new Response(JSON.stringify({ error: 'Used.', code: 'consumed' }), { status: 410 }))).toEqual({ type: 'error', code: 'refused', status: 410, serverCode: 'consumed' });
  });

  it('tells the consumer it is alive every 5 s while it runs, a retry\'s wait included, and stops at its end', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { port1, port2 } = channel(), messages: string[] = [];
      port2.onmessage = ({ data }) => {
        const type = (data as { type: string }).type;
        messages.push(type);
        if (type === 'chunk') port2.postMessage({ type: 'ack' });
      };
      let waiting = false, release = () => {};
      const at = 184 + 65552 * 2 + 100;
      const done = jobs.produce({ url: 'https://fyl.at/d/' + 'd'.repeat(43) + '?dl=1', key: fx.key, head: fx.head, size: fx.P, ciphertextSize: fx.C }, port1, () => {}, {
        fetch: async (_url, init) => new Headers(init.headers).has('range') ? ranged(184 + 65552 * 2) : cut(fx.ciphertext, at),
        wait: () => new Promise<void>(resolve => { waiting = true; release = resolve; }),
      });
      while (!waiting) await tick();
      const before = messages.filter(type => type === 'alive').length;
      await vi.advanceTimersByTimeAsync(10000);
      for (let round = 0; round < 3; round++) await tick();
      expect(messages.filter(type => type === 'alive').length - before).toBe(2);
      release();
      await done;
      expect(messages.at(-1)).toBe('end');
      await vi.advanceTimersByTimeAsync(20000);
      for (let round = 0; round < 3; round++) await tick();
      expect(messages.at(-1)).toBe('end');
    } finally { vi.useRealTimers(); }
  });

  it('stops the request when the consumer cancels', async () => {
    const result = await run(() => whole(), { cancelAfter: 2 });
    expect([result.chunks.length, result.messages.includes('end'), result.events.at(-1)?.type]).toEqual([2, false, 'cancelled']);
    expect((result.requests[0].init.signal as AbortSignal).aborted).toBe(true);
  });
});

describe('download service worker (§9.2)', () => {
  type Handler = (event: Record<string, unknown>) => unknown;
  const handlers: Record<string, Handler> = {};
  const scope = { location: new URL('https://fyl.at/_dl/sw.js'), addEventListener: (type: string, handler: Handler) => { handlers[type] = handler; },
    skipWaiting: vi.fn(), clients: { claim: vi.fn(async () => {}) } };
  beforeAll(async () => {
    vi.stubGlobal('self', scope);
    // @ts-expect-error: a browser script without type declarations.
    await import('../dist/_dl/sw.js');
  });
  const fetchEvent = (url: string, method = 'GET') => {
    let answer: Response | Promise<Response> | null = null;
    handlers.fetch({ request: new Request(url, { method }), respondWith: (response: Response) => { answer = response; } });
    return answer as Response | Promise<Response> | null;
  };
  const TOKEN = 'abcdefghijklmnopqrstuv';
  function offer(token = TOKEN, name = 'Report «Q3».pdf', size = 6) {
    const { port1, port2 } = channel(), seen: string[] = [];
    port1.onmessage = ({ data }) => { seen.push((data as { type: string }).type); };
    handlers.message({ data: { type: 'download', token, name, size }, ports: [port2] });
    return { page: port1, seen };
  }

  it('controls nothing but /_dl/<token>, and answers an unknown or used token with 404', async () => {
    expect(fetchEvent('https://fyl.at/_dl/sw.js')).toBeNull();
    expect(fetchEvent('https://fyl.at/d/' + 'd'.repeat(43))).toBeNull();
    expect(fetchEvent('https://example.com/_dl/' + TOKEN)).toBeNull();
    expect((await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response).status).toBe(404);
    // Offers without a valid token, name, size or port are ignored.
    handlers.message({ data: { type: 'download', token: 'short', name: 'a', size: 1 }, ports: [new Port()] });
    handlers.message({ data: { type: 'download', token: TOKEN, name: 'a', size: 1 }, ports: [] });
    expect((await fetchEvent('https://fyl.at/_dl/short') as Response).status).toBe(404);
    expect((await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response).status).toBe(404);
  });

  it('streams what the page sends once, as a sandboxed attachment, pulling only when the browser reads', async () => {
    const { page: port, seen } = offer();
    const response = await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response;
    expect(Object.fromEntries(response.headers.entries())).toMatchObject({
      'content-type': 'application/octet-stream', 'content-length': '6', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      'content-security-policy': "sandbox; default-src 'none'",
      'content-disposition': 'attachment; filename="Report _Q3_.pdf"; filename*=UTF-8\'\'Report%20%C2%ABQ3%C2%BB.pdf',
    });
    expect((await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response).status).toBe(404);
    await tick();
    expect(seen).toEqual(['started']);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader(), read = reader.read();
    await tick();
    expect(seen).toEqual(['started', 'pulled']);
    port.postMessage({ type: 'chunk', data: new Uint8Array([1, 2, 3]).buffer });
    expect(Array.from((await read).value as Uint8Array)).toEqual([1, 2, 3]);
    await tick();
    expect(seen).toEqual(['started', 'pulled', 'ack']);
    port.postMessage({ type: 'chunk', data: new Uint8Array([4, 5, 6]).buffer });
    port.postMessage({ type: 'end' });
    expect(Array.from((await reader.read()).value as Uint8Array)).toEqual([4, 5, 6]);
    expect((await reader.read()).done).toBe(true);
    await tick();
    expect(seen.slice(-2)).toEqual(['ack', 'closed']);
  });

  it('fails a download whose page went quiet for 30 s while it waits for data; alive keeps it waiting, a closed port ends it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { page: port, seen } = offer();
      const response = await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response;
      let outcome = 'waiting';
      (response.body as ReadableStream<Uint8Array>).getReader().read().then(() => { outcome = 'data'; }, () => { outcome = 'failed'; });
      await vi.advanceTimersByTimeAsync(25000);
      port.postMessage({ type: 'alive' });
      await vi.advanceTimersByTimeAsync(25000);
      // 25 s since the page last said it was alive: still waiting, and an alive is never data or acked.
      expect([outcome, seen]).toEqual(['waiting', ['started', 'pulled']]);
      await vi.advanceTimersByTimeAsync(6000);
      expect(outcome).toBe('failed');
      // Where a browser reports the page's end of the port closing, the download fails at once.
      const second = offer();
      const closing = await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response;
      let ended = 'waiting';
      (closing.body as ReadableStream<Uint8Array>).getReader().read().then(() => { ended = 'data'; }, () => { ended = 'failed'; });
      await vi.advanceTimersByTimeAsync(0);
      (second.page.other as Port).fire('close');
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toBe('failed');
    } finally { vi.useRealTimers(); }
  });

  it('fails the download when the page reports an error, and tells the page when the browser cancels it', async () => {
    const { page: port } = offer();
    const response = await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader(), read = reader.read();
    port.postMessage({ type: 'error' });
    await expect(read).rejects.toThrow();
    const { seen } = offer();
    await ((await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response).body as ReadableStream<Uint8Array>).cancel();
    await tick();
    expect(seen).toContain('cancel');
    // The page may withdraw an offer nobody opened.
    offer();
    handlers.message({ data: { type: 'cancel', token: TOKEN }, ports: [] });
    expect((await fetchEvent('https://fyl.at/_dl/' + TOKEN) as Response).status).toBe(404);
  });
});

describe('download page helpers', () => {
  it('reads the key from the address as the shared link vectors say, for this site\'s links', () => {
    for (const vector of links.link as { link: string; why: string; id?: string; key?: string | null; exposed?: boolean; exit?: number; code?: string }[]) {
      const url = /^https:\/\/fyl\.at(\/[^?#]*)(\?[^#]*)?(#.*)?$/.exec(vector.link);
      // The page sees only its own origin's /d/ paths; the query doesn't matter there (it is dropped).
      if (!url?.[1].startsWith('/d/') || (vector.exit && vector.code !== 'key_invalid')) continue;
      const found = page.addressKey(url[1], url[3] || '');
      if (vector.code === 'key_invalid') expect([vector.why, found.invalid, found.key]).toEqual([vector.why, true, null]);
      else expect([vector.why, found]).toEqual([vector.why, { id: vector.id, key: vector.key, exposed: vector.exposed, invalid: false }]);
    }
    expect(page.addressKey('/d/' + 'd'.repeat(43) + '%23' + 'k'.repeat(42) + 'A', '#' + 'k'.repeat(42) + 'A')).toMatchObject({ key: null, invalid: true });
    expect(page.addressKey('/x/abc', '#' + 'k'.repeat(42) + 'A')).toEqual({ id: null, key: null, exposed: false, invalid: false });
  });

  it('computes P(C) exactly like the core and the layout vectors', () => {
    for (const size of layout.sizes) expect(page.plainSize(size.ciphertextSize)).toBe(size.plaintextSize);
    for (const C of layout.invalidCiphertextSizes) expect(page.plainSize(C)).toBeNull();
    for (const C of [216, 65736, 65753, 52441784, 53687091200, 2 ** 53 - 1]) expect(page.plainSize(C)).toBe(age.plaintextSize(C));
  });

  it('warns before files that can run code, the encrypted additions of §15.4 included, and labels them like the Worker', () => {
    for (const name of ['setup.exe', 'run.SH', 'page.html', 'page.htm', 'p.xhtml', 'p.shtml', 'logo.svg', 'a.mht', 'a.mhtml', 'n.one', 'x.library-ms', 'x.search-ms',
      'x.settingcontent-ms', 'a.desktop', 'a.scpt', 'macro.docm']) expect([name, page.kind(name).risky]).toEqual([name, true]);
    for (const name of ['report.pdf', 'photo.jpg', 'archive.zip', 'notes', 'a.txt']) expect([name, page.kind(name).risky]).toEqual([name, false]);
    expect(page.kind('Invoice «2026».pdf')).toEqual({ ext: 'PDF', type: 'PDF document', risky: false });
    expect(page.kind('a.settingcontent-ms')).toEqual({ ext: 'SETT', type: 'SETTINGCONTENT-MS file', risky: true });
    expect(page.kind('README')).toEqual({ ext: 'FILE', type: 'file', risky: false });
  });

  it('sends a password as UTF-8 Basic credentials with an ignored user name', () => {
    expect(page.basic('tide-lamp-fern-41')).toBe('Basic ' + btoa('fyl:tide-lamp-fern-41'));
    expect(atob(page.basic('pässwört').slice(6))).toBe('fyl:' + String.fromCharCode(...new TextEncoder().encode('pässwört')));
  });

  it('keeps iPhone and iPad (iPadOS says Macintosh, with touch) on the in-memory path, up to 256 MiB', () => {
    expect(page.MEMORY_LIMIT).toBe(268435456);
    expect(page.appleTouch({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true);
    expect(page.appleTouch({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(page.appleTouch({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    expect(page.appleTouch({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 })).toBe(false);
  });

  it('streams only in Chromium with service workers, not in an Android WebView, on iPhone or iPad, or elsewhere (§9.3, §9.4)', () => {
    const serviceWorker = {}, brands = (...names: string[]) => ({ brands: names.map(brand => ({ brand, version: '156' })) });
    expect(page.streams({ serviceWorker, userAgentData: brands('Chromium', 'Google Chrome', 'Not.A/Brand') })).toBe(true);
    expect(page.streams({ serviceWorker, userAgentData: brands('Chromium', 'Microsoft Edge') })).toBe(true);
    expect(page.streams({ userAgentData: brands('Chromium', 'Google Chrome') })).toBe(false);
    expect(page.streams({ serviceWorker, userAgentData: brands('Chromium', 'Android WebView') })).toBe(false);
    expect(page.streams({ serviceWorker, userAgentData: brands('Chromium'), userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' })).toBe(false);
    // Firefox and Safari have no navigator.userAgentData.
    expect(page.streams({ serviceWorker, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' })).toBe(false);
    expect(page.streams({ serviceWorker, userAgentData: { brands: 'Chromium' } })).toBe(false);
  });
});

describe('report form and keys (§15.4)', () => {
  const id = 'A'.repeat(20) + '_-' + 'b'.repeat(21), key = 'KS92jkIczuAhpyqd3aDU6lkbH5VEQ9hD-miHz0yRcy0';
  const fields = (details: string) => ({ link: `https://fyl.at/d/${id}`, category: 'phishing', details, name: 'Alex Example', email: 'alex@example.org', goodFaith: true });

  it('takes an encrypted link without its key, also one whose key was put into the path', () => {
    expect(report.linkId(`https://fyl.at/d/${id}#${key}`)).toBe(id);
    expect(report.linkId(`https://fyl.at/d/${id}%23${key}`)).toBe(id);
    expect(report.withoutKey(` https://fyl.at/d/${id}#${key} `)).toBe(`https://fyl.at/d/${id}`);
    expect(report.withoutKey(`https://fyl.at/d/${id}%23${key}`)).toBe(`https://fyl.at/d/${id}`);
    // A raw link's name may hold an encoded #: it stays.
    expect(report.withoutKey(`https://fyl.at/d/${id}/a%23b.zip`)).toBe(`https://fyl.at/d/${id}/a%23b.zip`);
  });

  it('refuses details with key material', () => {
    const refused = 'Don’t paste the key here. The link without the part after # is enough.';
    for (const details of [`The link https://fyl.at/d/${id}#${key} is phishing.`, `It was sent with #${key} attached to it.`,
      `Path https://fyl.at/d/${id}%23${key} opens a fake bank page.`, 'Their key was AGE-SECRET-KEY-1EGTZVFFV20835NWYV6270LXYVK2VKNX2MMDKWYKLMGR48UAWX40Q2P2LM0 here.',
      'lowercase age-secret-key-1egtzvffv20835nwyv6270lxyvk2vknx2mmdkwyklmgr48uawx40q2p2lm0 too.'])
      expect([details, report.problems(fields(details)).details]).toEqual([details, refused]);
    for (const details of ['This page imitates my bank and asks for passwords.', `The link https://fyl.at/d/${id} is phishing, see #section.`])
      expect([details, report.problems(fields(details)).details]).toEqual([details, undefined]);
  });

  it('refuses key material in the name and the email too, which the case keeps as long as the details', () => {
    const details = 'This page imitates my bank and asks for passwords.', refused = 'Don’t paste the key here.';
    expect(report.problems({ ...fields(details), name: `Alex https://fyl.at/d/${id}#${key}` })).toEqual({ name: refused });
    expect(report.problems({ ...fields(details), email: `alex@example.org#${key}` })).toEqual({ email: refused });
    expect(report.problems({ ...fields(details), name: 'Alex #1', email: 'alex+fyl@example.org' })).toEqual({});
  });
});
