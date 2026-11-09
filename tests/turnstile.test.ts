import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from './vectors/errors.json';
import { call, direct, file, OPERATOR_TOKEN, operatorDirect, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.12.');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const KEYS = { TURNSTILE_SITE_KEY: '0x4AAAAAAAtestSiteKey', TURNSTILE_SECRET: '0x4AAAAAAAtestSecretKey-0123456789' };
// direct() always calls from the file's .251: the report and operator rate limits would run out between tests.
const unlimited = { limit: async () => ({ success: true }) };
const bindings = (extra: Record<string, string> = KEYS) => ({ REPORT_RATE: unlimited, ADMIN_RATE: unlimited, ...extra }) as unknown as Partial<Env>;
const FAILED = { error: 'Please confirm you are human and send again.', code: 'turnstile_failed' };

/** A METRICS stand-in that keeps "event:code" of every data point. */
const dataset = () => {
  const events: string[] = [];
  return { events, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point?.blobs) events.push(point.blobs.filter(Boolean).join(':')); } } };
};
/** Replaces the Worker's fetch: siteverify answers `answer` (a body, a Response, or an error to throw); records each form it got. */
function siteverify(answer: unknown) {
  const forms: Record<string, string>[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input instanceof Request ? input.url : input)).toBe(SITEVERIFY);
    expect(init?.method).toBe('POST');
    forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
    if (answer instanceof Error) throw answer;
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return { forms, spy };
}
const passed = (changes: Record<string, unknown> = {}) => ({ success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname: 'fyl.at', action: 'report', ...changes });
const complete = (link: string, extra: Record<string, unknown> = {}) => ({
  link, category: 'phishing', details: 'This page imitates a bank login form.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true, ...extra,
});
async function report(data: unknown, extra: Record<string, string> = KEYS, metrics?: ReturnType<typeof dataset>) {
  const { response } = await direct('/api/reports', { ...bindings(extra), ...metrics ? { METRICS: metrics.METRICS as unknown as AnalyticsEngineDataset } : {} }, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}
const config = async (extra: Record<string, string>) => {
  const text = await (await direct('/config.js', bindings(extra))).response.text();
  return JSON.parse(/^window\.FYL_CONFIG=(.*);$/.exec(text)?.[1] || 'null') as Record<string, unknown>;
};
const readiness = async (extra: Record<string, string>) => (await operatorDirect('/api/admin/ready', bindings(extra), { headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN } })).response.json<Record<string, unknown>>();

afterEach(() => { vi.restoreAllMocks(); });

describe('Turnstile on the report form', () => {
  it('stays off until both the site key and the secret are set: the form works as before and readiness says so', async () => {
    const { receipt } = await file(), { spy } = siteverify(passed());
    for (const extra of [{}, { TURNSTILE_SITE_KEY: KEYS.TURNSTILE_SITE_KEY }, { TURNSTILE_SECRET: KEYS.TURNSTILE_SECRET }, { TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET: KEYS.TURNSTILE_SECRET }] as Record<string, string>[]) {
      expect((await report(complete(receipt.url), extra)).status, JSON.stringify(extra)).toBe(201);
      expect(await config(extra), JSON.stringify(extra)).toEqual({ maxFileBytes: 53687091200, e2ee: true });
    }
    expect(spy).not.toHaveBeenCalled();
    // Readiness is on the admin host, whose Access check fetches the team's keys: siteverify's stub goes first.
    vi.restoreAllMocks();
    expect((await readiness({})).turnstile).toBe('off');
    expect((await readiness({ TURNSTILE_SITE_KEY: KEYS.TURNSTILE_SITE_KEY })).turnstile).toBe('incomplete');
    expect((await readiness({ TURNSTILE_SECRET: KEYS.TURNSTILE_SECRET })).turnstile).toBe('incomplete');
    // Only a state: neither key appears in the answer.
    const ready = await readiness(KEYS);
    expect(ready.turnstile).toBe('on');
    expect(JSON.stringify(ready)).not.toMatch(/0x4AAAAAAA/);
  });

  it('hands the page the site key once it is on, and accepts a report with a token siteverify passes', async () => {
    const { receipt } = await file(), { forms } = siteverify(passed());
    expect(await config(KEYS)).toEqual({ maxFileBytes: 53687091200, e2ee: true, turnstileSiteKey: KEYS.TURNSTILE_SITE_KEY });
    const sent = await report(complete(receipt.url, { turnstile: 'token-from-the-widget' }));
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.case).toMatch(/^R-/);
    // The secret, the token and the client's address, as siteverify takes them.
    expect(forms).toEqual([{ secret: KEYS.TURNSTILE_SECRET, response: 'token-from-the-widget', remoteip: '198.18.12.251' }]);
  });

  it('refuses a report without a token, or with one siteverify fails, expired, solved elsewhere or for another action', async () => {
    const { receipt } = await file(), metrics = dataset();
    // No token (or no usable one): siteverify isn't even asked.
    let verify = siteverify(passed());
    for (const token of [undefined, '', 42, 'x'.repeat(2049)])
      expect(await report(complete(receipt.url, { turnstile: token }), KEYS, metrics), String(token)).toEqual({ status: 403, body: FAILED });
    expect(verify.spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    for (const answer of [
      { success: false, 'error-codes': ['invalid-input-response'] },
      { success: false, 'error-codes': ['timeout-or-duplicate'] },
      passed({ challenge_ts: minutesAgo(6) }),
      passed({ hostname: 'fyl.at.example' }),
      passed({ hostname: 'example.com' }),
      passed({ action: 'login' }),
      passed({ action: undefined }),
      passed({ success: 'true' }),
    ]) {
      verify = siteverify(answer);
      expect(await report(complete(receipt.url, { turnstile: 'a-token' }), KEYS, metrics), JSON.stringify(answer)).toEqual({ status: 403, body: FAILED });
      expect(verify.forms).toHaveLength(1);
      vi.restoreAllMocks();
    }
    // A token solved a moment ago passes, one without a challenge time too (the age is checked when siteverify gives it).
    for (const answer of [passed({ challenge_ts: minutesAgo(4) }), passed({ challenge_ts: undefined })]) {
      siteverify(answer);
      expect((await report(complete(receipt.url, { turnstile: 'a-token' }), KEYS, metrics)).status).toBe(201);
      vi.restoreAllMocks();
    }
    expect(metrics.events.filter(event => event.startsWith('turnstile_failed'))).toEqual([
      ...Array(4).fill('turnstile_failed:missing'), 'turnstile_failed:invalid', 'turnstile_failed:expired', 'turnstile_failed:expired',
      'turnstile_failed:hostname', 'turnstile_failed:hostname', 'turnstile_failed:action', 'turnstile_failed:action', 'turnstile_failed:invalid',
    ]);
  });

  it('checks the hostname against PUBLIC_BASE_URL, and takes only success from Cloudflare test keys', async () => {
    const { receipt } = await file();
    siteverify(passed({ hostname: 'files.example.org' }));
    expect((await report(complete(receipt.id, { turnstile: 'a-token' }), { ...KEYS, PUBLIC_BASE_URL: 'https://files.example.org' })).status).toBe(201);
    vi.restoreAllMocks();
    // The documented test secret answers for example.com without an action; it passes (or fails) every token anyway.
    const testing = { metadata: { result_with_testing_key: true } };
    siteverify({ success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname: 'example.com', ...testing });
    expect((await report(complete(receipt.url, { turnstile: 'XXXX.DUMMY.TOKEN.XXXX' }))).status).toBe(201);
    vi.restoreAllMocks();
    siteverify({ success: false, 'error-codes': ['invalid-input-response'], ...testing });
    expect(await report(complete(receipt.url, { turnstile: 'XXXX.DUMMY.TOKEN.XXXX' }))).toEqual({ status: 403, body: FAILED });
  });

  it('fails closed with a retryable 503 when siteverify is unreachable or answers nothing usable', async () => {
    const { receipt } = await file(), metrics = dataset();
    const unavailable = { status: 503, body: { error: 'Temporarily unavailable. Please retry.', code: 'temporarily_unavailable' } };
    for (const answer of [new TypeError('Network connection lost.'), new Response('Bad gateway', { status: 502 }), new Response('<html>', { status: 200 }),
      Response.json([true]), { success: false, 'error-codes': ['internal-error'] }]) {
      siteverify(answer);
      expect(await report(complete(receipt.url, { turnstile: 'a-token' }), KEYS, metrics)).toEqual(unavailable);
      vi.restoreAllMocks();
    }
    expect(metrics.events.filter(event => event.startsWith('turnstile_failed'))).toEqual(Array(5).fill('turnstile_failed:unavailable'));
    // A wrong secret is the operator's to fix: 503 misconfigured, logged by name only.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    siteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    expect(await report(complete(receipt.url, { turnstile: 'a-token' }))).toMatchObject({ status: 503, body: { code: 'misconfigured' } });
    expect(errors.mock.calls.map(args => String(args[0]))).toEqual([JSON.stringify({ event: 'misconfigured', missing: 'TURNSTILE_SECRET' })]);
    expect(vectors).toContainEqual(expect.objectContaining({ status: 503, code: 'misconfigured', class: 'retry' }));
    expect(vectors).toContainEqual(expect.objectContaining({ status: 503, code: 'temporarily_unavailable', class: 'retry' }));
  });

  it('checks the fields first, so a mistake doesn\'t spend the token, and the link after it', async () => {
    const { receipt } = await file(), { spy } = siteverify(passed());
    expect(await report(complete(receipt.url, { turnstile: 'a-token', details: 'too short' }))).toMatchObject({ status: 400, body: { code: 'invalid_details' } });
    expect(await report(complete('https://example.org/d/x', { turnstile: 'a-token' }))).toMatchObject({ status: 400, body: { code: 'invalid_link' } });
    expect(spy).not.toHaveBeenCalled();
    expect(await report(complete('a'.repeat(43), { turnstile: 'a-token' }))).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is asked for nowhere else: uploads, downloads and the other API routes never call siteverify', async () => {
    const { spy } = siteverify(passed());
    const init = await direct('/api/upload/init', bindings(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'a.txt', size: 3 }) });
    expect(init.response.status).toBe(201);
    const { receipt } = await file();
    for (const path of [new URL(receipt.url).pathname, `/api/transfers/${receipt.id}`, '/api/health']) {
      const { response } = await direct(path, bindings());
      expect(response.status, path).toBe(200);
      await response.arrayBuffer();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets only the report page load Turnstile: its CSP allows challenges.cloudflare.com, every other page names only fyl\'s scripts', async () => {
    const page = await call('/report');
    expect(page.status).toBe(200);
    const policy = page.headers.get('Content-Security-Policy') || '';
    const directive = (text: string, name: string) => text.split('; ').find(part => part.startsWith(name + ' '))?.split(' ').slice(1) || [];
    expect(policy.split(', ')).toHaveLength(1);
    expect(directive(policy, 'script-src')).toEqual(['https://fyl.at/theme.js', 'https://fyl.at/i18n.js', 'https://fyl.at/config.js', 'https://fyl.at/report.js', 'https://fyl.at/e2ee/',
      'https://fyl.at/vendor/', 'https://challenges.cloudflare.com']);
    expect(directive(policy, 'frame-src')).toEqual(['https://challenges.cloudflare.com']);
    const html = await page.text();
    // The page asks the Worker for the site key before report.js runs; it has no inline script, only its messages as a
    // JSON block, which no browser runs.
    expect(html.indexOf('<script src="/config.js" defer></script>')).toBeLessThan(html.indexOf('<script src="/report.js" defer></script>'));
    expect(html).not.toMatch(/<script(?![^>]*\b(?:src=|type="application\/json"))[^>]*>/);
    for (const path of ['/', '/privacy', '/download']) {
      const other = await call(path);
      const own = other.headers.get('Content-Security-Policy') || '';
      expect([path, own.includes('challenges.cloudflare.com'), directive(own, 'frame-src')]).toEqual([path, false, []]);
      await other.text();
    }
    const privacy = await (await call('/privacy')).text();
    expect(privacy).toContain('Cloudflare Turnstile');
  });

  it('is in the shared table of error classes as a permanent 403', () => {
    expect(vectors).toContainEqual(expect.objectContaining({ status: 403, code: 'turnstile_failed', class: 'permanent' }));
  });
});
