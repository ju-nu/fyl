import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { address, call, direct, file, operatorDirect, pathOf, pageOf, record, OPERATOR_TOKEN, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.2.');

// The Worker's response with some bindings replaced, e.g. a rate limiter that refuses.
const fetchWith = async (path: string, bindings: Partial<Env>, init: RequestInit = {}) => (await direct(path, bindings, init)).response;
// The same on the admin host, through Access with a service token.
const operatorWith = async (path: string, bindings: Partial<Env>, init: RequestInit = {}) => (await operatorDirect(path, bindings, init)).response;
const limiter = (success: boolean) => {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success }; } };
};
const bearer = (token: string) => ({ headers: { Authorization: 'Bearer ' + token } });
// The download page of a ready file, without its bytes.
const ready = async (response: Response, once: boolean) => {
  const { html, data } = await pageOf(response);
  expect(data).toMatchObject({ state: 'ready', once, name: "report & '旅行'.zip" });
  expect(html).not.toContain('a real R2 fixture');
};

describe('download routing and operator guards', () => {
  it('counts every /d/ request against DOWNLOAD_RATE before it validates the id', async () => {
    const refusing = limiter(false);
    for (const path of ['/d/not-a-valid-id/x', '/d/']) {
      const response = await fetchWith(path, { DOWNLOAD_RATE: refusing }, { headers: { Accept: 'text/html' } });
      expect(response.status).toBe(429);
      expect((await pageOf(response)).data).toMatchObject({ state: 'gone', reason: 'busy', id: null });
    }
    expect((await fetchWith('/d/not-a-valid-id/x', { DOWNLOAD_RATE: refusing }, { method: 'POST' })).status).toBe(429);
    expect(refusing.keys).toEqual(['198.18.2.251', '198.18.2.251', '198.18.2.251']);
    // Admitted, a malformed id is still a plain 404.
    const admitting = limiter(true);
    const missing = await fetchWith('/d/not-a-valid-id/x', { DOWNLOAD_RATE: admitting });
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe('not_found');
    expect(admitting.keys).toHaveLength(1);
  });

  it('shows link-preview bots the download page whatever they ask for, without opening a one-time download', async () => {
    const { receipt, payload } = await file(true);
    const path = pathOf(receipt.url);
    const bots: [string, Record<string, string>][] = [
      ['', { Accept: '*/*', 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }],
      ['', { 'User-Agent': 'TelegramBot (like TwitterBot)' }],
      ['?dl=1', { Accept: '*/*', 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }],
      ['?dl=1', { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', Range: 'bytes=0-' }],
      ['', { 'User-Agent': 'WhatsApp/2.23.20.0 A', Range: 'bytes=0-3' }],
      ['', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com' }],
      ['', { 'User-Agent': 'Synapse (bot; +https://github.com/matrix-org/synapse)' }],
    ];
    for (const [query, headers] of bots) {
      const response = await call(path + query, { headers });
      expect(response.status, headers['User-Agent']).toBe(200);
      await ready(response, true);
    }
    // None of them opened the session: a plain client on another network still gets the whole file.
    const curl = await call(path, { headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' } });
    expect(curl.status).toBe(200);
    expect(curl.headers.get('Content-Disposition')).toContain('attachment');
    expect(new Uint8Array(await curl.arrayBuffer())).toEqual(payload);
    const late = await call(path, { headers: bots[0][1] });
    expect(late.status).toBe(410);
    expect((await pageOf(late)).data).toMatchObject({ state: 'gone', reason: 'consumed' });
  });

  it('shows bots the page for regular links too, and leaves download tools and browser downloads to download', async () => {
    const regular = await file();
    await ready(await call(pathOf(regular.receipt.url), { headers: { 'User-Agent': 'Twitterbot/1.0', Accept: '*/*' } }), false);
    expect((await record(regular.session.uploadId)).downloads).toBe(0);
    const wget = await file(true);
    const fetched = await call(pathOf(wget.receipt.url), { headers: { 'User-Agent': 'Wget/1.21.4', Accept: '*/*' } });
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(wget.payload);
    // An in-app browser naming its app in the User-Agent: the page first, the file from its Download button.
    const { receipt, payload } = await file(true);
    const path = pathOf(receipt.url), from = address(252);
    const browser = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.10.0.40',
      Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate' };
    await ready(await call(path, { headers: browser }, from), true);
    const download = await call(path + '?dl=1', { headers: browser }, from);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);
  });

  it('treats an ADMIN_TOKEN shorter than 32 characters as not configured', async () => {
    const short = 'x'.repeat(31), enough = 'y'.repeat(32);
    for (const [route, init] of [['/api/admin/uploads', {}], ['/api/admin/takedown', { method: 'POST', body: '{}' }]] as const) {
      const response = await operatorWith(route, { ADMIN_TOKEN: short }, { ...init, headers: bearer(short).headers });
      expect(response.status).toBe(404);
      expect((await response.json<{ code: string }>()).code).toBe('not_found');
    }
    expect((await operatorWith('/api/admin/uploads', { ADMIN_TOKEN: enough }, bearer(enough))).status).toBe(200);
    expect(OPERATOR_TOKEN.length).toBeGreaterThanOrEqual(32);
  });

  it('rate-limits operator routes with their own ADMIN_RATE binding', async () => {
    expect(env.ADMIN_RATE).toBeDefined();
    const refusing = limiter(false), unused = limiter(false);
    const limited = await operatorWith('/api/admin/uploads', { ADMIN_RATE: refusing, INIT_RATE: unused }, bearer(OPERATOR_TOKEN));
    expect(limited.status).toBe(429);
    expect((await limited.json<{ code: string }>()).code).toBe('rate_limited');
    // Without the token too: the limit comes before the token check.
    expect((await operatorWith('/api/admin/uploads', { ADMIN_RATE: refusing, INIT_RATE: unused })).status).toBe(429);
    expect(refusing.keys).toHaveLength(2);
    // The upload limit no longer applies to operator calls.
    const admitting = limiter(true);
    expect((await operatorWith('/api/admin/uploads', { ADMIN_RATE: admitting, INIT_RATE: unused }, bearer(OPERATOR_TOKEN))).status).toBe(200);
    expect(admitting.keys).toHaveLength(1);
    expect(unused.keys).toEqual([]);
  });
});
