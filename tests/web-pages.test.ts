import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { englishText } from './english';

// The DOM-free parts of the download page (dist/download.js) and the report form (dist/report.js). Both scripts
// export them and stop before touching a page when there is none.
interface Download {
  nextDelay(delay: number, outcome?: { changed?: boolean; status?: number; retryAfter?: string | null }): number;
  clockOffset(server: number | undefined, local: number): number;
  validPassword(text: string): boolean;
}
interface Fields { link: string; category: string; details: string; name: string; email: string; goodFaith: boolean }
interface Report {
  linkId(text: string, host?: string): string | null;
  problems(fields: Fields, host?: string): Record<string, string>;
  payload(fields: Fields, host?: string): Record<string, unknown>;
  refusal(status: number, body: unknown): string;
  received(body: unknown): { id: string; fileAvailable: boolean };
}
let page: Download, report: Report, api: { validPassword(text: string): boolean };

beforeAll(async () => {
  vi.stubGlobal('window', globalThis);
  await englishText();
  // @ts-expect-error: browser scripts without type declarations.
  await import('../dist/download.js');
  // @ts-expect-error: browser scripts without type declarations.
  await import('../dist/report.js');
  // @ts-expect-error: browser scripts without type declarations.
  await import('../dist/api.js');
  ({ FylDownload: page, FylReport: report, FylAPI: api } = globalThis as unknown as { FylDownload: Download; FylReport: Report; FylAPI: typeof api });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('download page polling and clock helpers', () => {
  it('backs off from 5 s by half each time up to a minute while nothing changes, and starts over on progress', () => {
    const delays: number[] = [];
    for (let delay = 5000, step = 0; step < 9; step++) { delay = page.nextDelay(delay); delays.push(delay); }
    expect(delays).toEqual([7500, 11250, 16875, 25313, 37970, 56955, 60000, 60000, 60000]);
    expect(page.nextDelay(60000, { changed: true })).toBe(5000);
  });

  it('waits at least a minute after a 429, longer when Retry-After asks, at most ten minutes', () => {
    expect(page.nextDelay(5000, { status: 429 })).toBe(60000);
    expect(page.nextDelay(5000, { status: 429, retryAfter: '30' })).toBe(60000);
    expect(page.nextDelay(5000, { status: 429, retryAfter: '120' })).toBe(120000);
    expect(page.nextDelay(5000, { status: 429, retryAfter: '86400' })).toBe(600000);
    expect(page.nextDelay(5000, { status: 429, retryAfter: 'Wed, 21 Oct 2015 07:28:00 GMT' })).toBe(60000);
  });

  it('measures time on the server clock, whichever way this device is off', () => {
    const server = Date.UTC(2026, 9, 30, 12), expiresAt = server + 3600000;
    for (const skew of [2 * 3600000, -2 * 3600000, 0]) {
      const local = server + skew, offset = page.clockOffset(server, local);
      // A device two hours ahead still sees the hour that is left, and one behind doesn't see three.
      expect(expiresAt - (local + offset)).toBe(3600000);
    }
    // An old page without the server's time trusts this clock, but the page still asks the server before closing.
    expect(page.clockOffset(undefined, Date.now())).toBe(0);
    expect(page.clockOffset(Number.NaN, Date.now())).toBe(0);
  });

  it('checks passwords with the same rule as the upload form', () => {
    for (const text of ['abcdef', 'abcde', 'क़'.repeat(3), 'é'.repeat(5), '\u{1F600}'.repeat(3), 'a'.repeat(201), 'abc\tdef', 'x'.repeat(200)])
      expect([JSON.stringify(text), page.validPassword(text)]).toEqual([JSON.stringify(text), api.validPassword(text)]);
  });
});

describe('report form helpers', () => {
  const id = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
  const fields = (changes: Partial<Fields> = {}): Fields => ({ link: `https://fyl.at/d/${id}/report.zip`, category: 'malware',
    details: 'The archive contains a trojan that steals passwords.', name: 'Alex Example', email: 'alex@example.org', goodFaith: true, ...changes });

  it('takes fyl.at download links and bare ids, and nothing else', () => {
    for (const link of [id, ` ${id} `, `https://fyl.at/d/${id}`, `https://fyl.at/d/${id}/a%20b.zip`, `https://fyl.at/d/${id}?dl=1`,
      `https://fyl.at/d/${id}?grant=123.abc`, `http://localhost:4183/d/${id}`]) expect([link, report.linkId(link, 'localhost:4183')]).toEqual([link, id]);
    for (const link of [`https://evil.example/d/${id}`, `https://fyl.at.evil.example/d/${id}`, `https://fyl.at/#manage/${id}/${'k'.repeat(43)}`,
      `https://fyl.at/d/${id}/a/b`, `https://fyl.at/x/${id}`, 'https://fyl.at/d/short', `ftp://fyl.at/d/${id}`, `https://user:pass@fyl.at/d/${id}`,
      `${id}x!`, '', 'fyl.at/d/' + id, `http://localhost:4183/d/${id}`]) expect([link, report.linkId(link)]).toEqual([link, null]);
  });

  it('applies the server rules to every field', () => {
    expect(report.problems(fields())).toEqual({});
    expect(Object.keys(report.problems({ link: 'nope', category: '', details: 'short', name: '', email: 'not-an-address', goodFaith: false })))
      .toEqual(['link', 'category', 'details', 'name', 'email', 'goodFaith']);
    // Name and email are needed except for reports of child sexual abuse material.
    expect(report.problems(fields({ name: '', email: '' }))).toEqual({ name: 'Enter your name.', email: 'Enter your email address.' });
    expect(report.problems(fields({ category: 'csam', name: '', email: '' }))).toEqual({});
    expect(report.problems(fields({ category: 'csam', name: '', email: 'bad' }))).toHaveProperty('email');
    // Details count code points: 20 emoji are enough, 19 are not; controls other than newline and tab are refused.
    expect(report.problems(fields({ details: '\u{1F600}'.repeat(20) }))).toEqual({});
    expect(report.problems(fields({ details: '\u{1F600}'.repeat(19) }))).toHaveProperty('details');
    expect(report.problems(fields({ details: 'x'.repeat(4000) }))).toEqual({});
    expect(report.problems(fields({ details: 'x'.repeat(4001) }))).toHaveProperty('details');
    expect(report.problems(fields({ details: 'line one\nline two\twith a tab' }))).toEqual({});
    expect(report.problems(fields({ details: 'twenty characters or\u0007 more' }))).toHaveProperty('details');
    expect(report.problems(fields({ name: 'n'.repeat(201) }))).toHaveProperty('name');
    expect(report.problems(fields({ email: `${'e'.repeat(250)}@x.io` }))).toHaveProperty('email');
  });

  it('sends only the transfer id of the link, and contact details only when given', () => {
    expect(report.payload(fields({ link: `https://fyl.at/d/${id}?grant=123.secret` }))).toEqual({ link: id, category: 'malware',
      details: 'The archive contains a trojan that steals passwords.', name: 'Alex Example', email: 'alex@example.org', goodFaith: true });
    expect(report.payload(fields({ category: 'csam', name: '', email: '' }))).toEqual({ link: id, category: 'csam',
      details: 'The archive contains a trojan that steals passwords.', goodFaith: true });
  });

  it('refusal() tells a network at its daily report limit to come back tomorrow, and one over the rate limit to wait a minute', () => {
    expect(report.refusal(429, { error: 'This network has sent too many reports today. Please try again tomorrow.', code: 'report_limit' }))
      .toBe('Your network has sent too many reports today. Please try again tomorrow.');
    for (const body of [{ error: 'Too many requests. Please try again shortly.', code: 'rate_limited' }, null])
      expect(report.refusal(429, body)).toBe('Too many reports from your network. Please wait a minute and try again.');
    // The daily limit's code means nothing on another status; a 400 shows the server's reason.
    expect(report.refusal(404, { error: 'There is no file at this link.', code: 'report_limit' })).toBe('We can’t find a file for this link. Check the link and try again.');
    expect(report.refusal(400, { error: 'Choose what the report is about.', code: 'invalid_category' })).toBe('Choose what the report is about.');
    expect(report.refusal(503, { error: 'Temporarily unavailable. Please retry.', code: 'temporarily_unavailable' })).toBe('Temporarily unavailable. Please retry.');
    expect(report.refusal(500, null)).toBe('The report could not be sent. Please try again.');
  });

  it('knows from the answer whether the reported file is still available', () => {
    expect(report.received({ case: 'R-0123456789', received: 1, fileAvailable: false })).toEqual({ id: 'R-0123456789', fileAvailable: false });
    // A server that doesn't say only takes reports of files that are still there.
    for (const body of [{ case: 'R-0123456789', received: 1 }, { case: 'R-0123456789', received: 1, fileAvailable: true }])
      expect(report.received(body)).toEqual({ id: 'R-0123456789', fileAvailable: true });
    for (const body of [null, 'text', { case: 7 }]) expect(report.received(body)).toEqual({ id: '', fileAvailable: true });
  });
});

describe('report form Turnstile', () => {
  type Listener = () => void;
  interface Script { src: string; async: boolean; listeners: Record<string, Listener> }
  interface Options { sitekey: string; action: string; theme: string; size: string; callback(token: string): void; [name: string]: unknown }
  interface Human { token(): string; reset(): void }
  const form = () => (globalThis as unknown as { FylReport: {
    siteKey(config: unknown): string | null; TURNSTILE: string;
    humanCheck(key: string | null, box: unknown, options: { win?: unknown; doc?: unknown; theme?: string; failed?: (failed: boolean) => void }): Human | null;
  } }).FylReport;
  // A document that only records the scripts the form adds, and a Turnstile API that records its calls.
  function fakes(width = 520) {
    const scripts: Script[] = [], box = { clientWidth: width };
    const doc = {
      createElement(tag: string) {
        expect(tag).toBe('script');
        const listeners: Record<string, Listener> = {};
        return { src: '', async: false, listeners, addEventListener(type: string, listener: Listener) { listeners[type] = listener; } };
      },
      head: { append(script: Script) { scripts.push(script); } },
    };
    const turnstile = { render: vi.fn((_box: unknown, _options: Options) => 'widget-1'), reset: vi.fn() };
    return { scripts, box, doc, win: { turnstile }, turnstile };
  }

  it('loads nothing from Cloudflare without a site key from the Worker', () => {
    const { scripts, box, doc, win } = fakes();
    for (const config of [undefined, null, {}, { maxFileBytes: 1 }, { turnstileSiteKey: '' }, { turnstileSiteKey: 7 }, { turnstileSiteKey: 'a"b' }, { turnstileSiteKey: 'k'.repeat(129) }]) {
      expect(form().siteKey(config), JSON.stringify(config)).toBeNull();
      expect(form().humanCheck(form().siteKey(config), box, { win, doc })).toBeNull();
    }
    expect(scripts).toEqual([]);
  });

  it('with a key, loads the API explicitly, renders the widget once it is there and keeps its token; expiry and every answer start afresh', () => {
    const { scripts, box, doc, win, turnstile } = fakes(), failures: boolean[] = [];
    const human = form().humanCheck(form().siteKey({ maxFileBytes: 1, turnstileSiteKey: '0x4AAAAAAA_test-key' }), box, { win, doc, theme: 'dark', failed: failed => failures.push(failed) }) as Human;
    expect(scripts.map(script => [script.src, script.async])).toEqual([['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', true]]);
    expect(form().TURNSTILE).toBe(scripts[0].src);
    expect(turnstile.render).not.toHaveBeenCalled();
    scripts[0].listeners.load();
    expect(turnstile.render).toHaveBeenCalledTimes(1);
    const [target, options] = turnstile.render.mock.calls[0];
    expect(target).toBe(box);
    expect(options).toMatchObject({ sitekey: '0x4AAAAAAA_test-key', action: 'report', theme: 'dark', size: 'flexible', 'refresh-expired': 'manual' });
    expect(human.token()).toBe('');
    options.callback('token-1');
    expect(human.token()).toBe('token-1');
    (options['expired-callback'] as Listener)();
    expect([human.token(), turnstile.reset.mock.calls]).toEqual(['', [['widget-1']]]);
    options.callback('token-2');
    (options['timeout-callback'] as Listener)();
    expect([human.token(), turnstile.reset.mock.calls.length]).toEqual(['', 2]);
    // The server spends a token on each check: the form resets after every answer.
    options.callback('token-3');
    human.reset();
    expect([human.token(), turnstile.reset.mock.calls.length]).toEqual(['', 3]);
    expect(failures).toEqual([false, false, false]);
  });

  it('renders afresh after an error, up to three times, then says the check did not load; a narrow form gets the compact widget', () => {
    vi.useFakeTimers();
    try {
      const { scripts, box, doc, win, turnstile } = fakes(280), failures: boolean[] = [];
      const human = form().humanCheck('0x4AAAAAAA', box, { win, doc, failed: failed => failures.push(failed) }) as Human;
      scripts[0].listeners.load();
      const options = turnstile.render.mock.calls[0][1];
      expect([options.size, options.theme]).toEqual(['compact', 'auto']);
      const error = options['error-callback'] as () => boolean;
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(error()).toBe(true);
        vi.advanceTimersByTime(2000 * attempt);
        expect(turnstile.reset).toHaveBeenCalledTimes(attempt);
      }
      expect(failures).toEqual([]);
      error();
      vi.advanceTimersByTime(60000);
      expect([turnstile.reset.mock.calls.length, failures, human.token()]).toEqual([3, [true], '']);
      // A token later (the reporter solved it after all) clears the message.
      options.callback('late-token');
      expect([failures, human.token()]).toEqual([[true, false], 'late-token']);
    } finally { vi.useRealTimers(); }
    // A blocked script says so too.
    const { scripts, box, doc, win } = fakes(), failures: boolean[] = [];
    form().humanCheck('0x4AAAAAAA', box, { win, doc, failed: failed => failures.push(failed) });
    scripts[0].listeners.error();
    expect(failures).toEqual([true]);
    // So does a script that loaded but can't render.
    const broken = fakes(), seen: boolean[] = [];
    broken.turnstile.render.mockImplementation(() => { throw new Error('Turnstile: invalid container'); });
    form().humanCheck('0x4AAAAAAA', broken.box, { win: broken.win, doc: broken.doc, failed: failed => seen.push(failed) });
    broken.scripts[0].listeners.load();
    expect(seen).toEqual([true]);
  });
});
