import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { direct, file, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.15.');

const REPORT = 'https://report.fyl.at', SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const KEYS = { TURNSTILE_SITE_KEY: '0x4AAAAAAAtestSiteKey', TURNSTILE_SECRET: '0x4AAAAAAAtestSecretKey-0123456789' };
// direct() always calls from the file's .251: the report rate limit would run out between tests.
const unlimited = { limit: async () => ({ success: true }) };
const host = (extra: Record<string, string> = {}) => ({ REPORT_HOST: 'report.fyl.at', REPORT_RATE: unlimited, ...extra }) as unknown as Partial<Env>;
const complete = (link: string) => ({ link, category: 'phishing', details: 'This page imitates a bank login form.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true });
const post = (url: string, data: unknown, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  direct(url, host(extra), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

afterEach(() => { vi.restoreAllMocks(); });

describe('the report form on report.fyl.at', () => {
  it('is configured for report.fyl.at in wrangler.jsonc', () => {
    const settings = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ''));
    expect(settings.routes).toContainEqual({ pattern: 'report.fyl.at', custom_domain: true });
    expect(settings.vars.REPORT_HOST).toBe('report.fyl.at');
  });

  it('picks the language at / like fyl.at does, keeping ?link=, and moved the old /report to English', async () => {
    for (const [path, language, location] of [['/', 'de-AT,de;q=0.9', '/de/'], ['/?link=https%3A%2F%2Ffyl.at%2Fd%2Fabc', 'fr', '/fr/?link=https%3A%2F%2Ffyl.at%2Fd%2Fabc'],
      ['/', 'ja', '/en/']] as const) {
      const { response } = await direct(REPORT + path, host(), { headers: { Accept: 'text/html', 'Accept-Language': language }, redirect: 'manual' });
      expect([path, response.status, response.headers.get('Location'), response.headers.get('Vary'), response.headers.get('Cache-Control')])
        .toEqual([path, 302, location, 'Accept, Accept-Language', 'no-store']);
    }
    for (const [path, location] of [['/report?link=x', '/en/?link=x'], ['/de', '/de/']] as const) {
      const { response } = await direct(REPORT + path, host(), { redirect: 'manual' });
      expect([path, response.status, response.headers.get('Location')]).toEqual([path, 301, location]);
    }
  });

  it('serves the form at /<lang>/ with Turnstile in its policy, and points its links to the site', async () => {
    const { response } = await direct(`${REPORT}/en/`, host(), { headers: { Accept: 'text/html' } });
    const html = await response.text(), policy = response.headers.get('Content-Security-Policy') || '';
    expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect(policy).toContain('https://challenges.cloudflare.com');
    expect(policy).toContain('https://report.fyl.at/report.js');
    expect(html).toContain('<title>Report a file · fyl.at</title>');
    expect(html).toContain('href="https://fyl.at/en/"');
    expect(html).toContain('href="https://fyl.at/en/privacy"');
    expect(html).toContain('<a href="https://report.fyl.at/en/" aria-current="page">');
    // Its language menu leads to the form in the other languages, on this host.
    expect(html).toContain('href="/de/" hreflang="de"');
    expect(html).toContain('<link rel="canonical" href="https://report.fyl.at/en/">');
    // Its own files stay relative.
    expect(html).toContain('src="/report.js"');
    expect(html).toContain('href="/styles.css"');
  });

  it('serves its files and the config, and nothing of the site', async () => {
    for (const path of ['/report.js', '/styles.css', '/theme.js', '/config.js', '/favicon.svg', '/apple-touch-icon.png', '/fonts/plex-sans-600.woff2']) {
      const { response } = await direct(REPORT + path, host());
      await response.arrayBuffer();
      expect([path, response.status]).toEqual([path, 200]);
    }
    for (const path of ['/privacy', '/index.html', '/app.js', '/download', '/d/' + 'A'.repeat(43), '/api/health', '/api/upload/init', '/admin/', '/cli/latest']) {
      const { response } = await direct(REPORT + path, host());
      await response.arrayBuffer();
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  it('takes reports there and refuses posts from another origin', async () => {
    const { receipt } = await file();
    const created = await post(`${REPORT}/api/reports`, complete(receipt.url));
    expect(created.response.status).toBe(201);
    const foreign = await post(`${REPORT}/api/reports`, complete(receipt.url), {}, { Origin: 'https://fyl.at' });
    expect(foreign.response.status).toBe(403);
  });

  it('checks that Turnstile was solved on report.fyl.at', async () => {
    const { receipt } = await file();
    const answer = (hostname: string) => ({ success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname, action: 'report' });
    let hostname = 'report.fyl.at';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input instanceof Request ? input.url : input)).toBe(SITEVERIFY);
      return Response.json(answer(hostname));
    });
    expect((await post(`${REPORT}/api/reports`, { ...complete(receipt.url), turnstile: 'token' }, KEYS)).response.status).toBe(201);
    hostname = 'fyl.at';
    const refused = await post(`${REPORT}/api/reports`, { ...complete(receipt.url), turnstile: 'token' }, KEYS);
    expect([refused.response.status, (await refused.response.json<{ code: string }>()).code]).toEqual([403, 'turnstile_failed']);
  });
});

describe('the public host once the form moved', () => {
  it('sends /report to report.fyl.at with its query', async () => {
    for (const path of ['/report?link=https%3A%2F%2Ffyl.at%2Fd%2Fabc', '/report.html']) {
      const { response } = await direct(path, host(), { redirect: 'manual' });
      expect([response.status, response.headers.get('Location')]).toEqual([302, `${REPORT}/${path.includes('?') ? path.slice(path.indexOf('?')) : ''}`]);
    }
  });

  it('keeps Turnstile out of its pages', async () => {
    for (const path of ['/en/', '/de/privacy', '/en/download']) {
      const { response } = await direct(path, host(), { headers: { Accept: 'text/html' } });
      await response.arrayBuffer();
      expect([path, response.headers.get('Content-Security-Policy')?.includes('challenges.cloudflare.com')]).toEqual([path, false]);
    }
  });
});
