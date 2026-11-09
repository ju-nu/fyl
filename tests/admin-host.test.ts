import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { forgetAccessKeys } from '../src/access';
import { COUNTED_SINCE, DATASET, SHAPE_VERSION, midnight, sampleSince, shape, statsCacheKey, statsQueries, windowOf } from '../src/stats';
import { BILLING_QUERY, ERRORS_QUERY, SCRIPT, billingCacheKey, cycleOf } from '../src/billing';
import { ACCESS_CERTS as CERTS, ADMIN, OWNER_EMAIL, accessJwt as jwt, accessKeys, call, direct, file, jwkOf, operator, pause, post, serviceJwt as service, OPERATOR_TOKEN, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.13.');

// The production values from wrangler.jsonc, which the Worker under test runs with.
const settings = JSON.parse(config) as { routes: unknown[]; vars: Record<string, string>; assets: { run_worker_first: unknown }; analytics_engine_datasets: { dataset: string }[] };
const ACCOUNT = settings.vars.ANALYTICS_ACCOUNT_ID, AUD = String(env.ACCESS_AUD);
const SQL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const MONITOR_TOKEN = 'test-monitor-token-0123456789abcdef';
const STRICT = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";
// direct() always calls from the file's .251: the operator rate limit would run out between tests.
const unlimited = { limit: async () => ({ success: true }) };
const encode = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const pair = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
let keys: CryptoKeyPair, rotated: CryptoKeyPair, published: JsonWebKey[];

/**
 * Replaces the Worker's fetch: the Access certs endpoint publishes `published`; the SQL API answers `sql` (per query),
 * the GraphQL API `graphql`.
 */
let certsAnswer: () => Response, sql: (query: string) => Response, sqlCalls: { url: string; auth: string | null; body: string }[], certCalls: number;
let graphql: (body: string) => Response, graphqlCalls: { auth: string | null; body: string }[];
function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CERTS) { certCalls++; return certsAnswer(); }
    if (url === GRAPHQL) {
      const body = String(init?.body);
      graphqlCalls.push({ auth: new Headers(init?.headers).get('Authorization'), body });
      return graphql(body);
    }
    if (url.startsWith('https://api.cloudflare.com/')) {
      const body = String(init?.body);
      sqlCalls.push({ url, auth: new Headers(init?.headers).get('Authorization'), body });
      return sql(body);
    }
    throw new Error('Unexpected fetch: ' + url);
  });
}

/** A METRICS stand-in that keeps "event:code" of every data point. */
const dataset = () => {
  const events: string[] = [];
  return { events, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point?.blobs) events.push(point.blobs.slice(0, 2).join(':')); } } as unknown as AnalyticsEngineDataset };
};
const admin = async (path: string, token: string | null, init: RequestInit = {}, bindings: Record<string, unknown> = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return (await direct(path.startsWith('http') ? path : ADMIN + path, { ADMIN_RATE: unlimited, ...bindings } as unknown as Partial<Env>, { ...init, headers })).response;
};
const bearer = (token: string) => ({ headers: { Authorization: 'Bearer ' + token } });
const codeOf = async (response: Response) => (await response.json<{ code: string }>()).code;
const clearStats = () => Promise.all([...['1d', '7d', '30d', '90d'].map(range => caches.default.delete(statsCacheKey(ADMIN, ACCOUNT, range))),
  caches.default.delete(billingCacheKey(ADMIN, ACCOUNT, new Date(cycleOf(Date.now(), 28).start).toISOString().slice(0, 10)))]);

beforeAll(async () => {
  keys = await accessKeys();
  rotated = await pair();
});
beforeEach(async () => {
  forgetAccessKeys();
  await clearStats();
  certCalls = 0; sqlCalls = []; graphqlCalls = [];
  published = [await jwkOf(keys.publicKey, 'k1')];
  certsAnswer = () => Response.json({ keys: published, public_cert: {}, public_certs: [] });
  sql = () => Response.json({ meta: [], data: [], rows: 0 });
  graphql = cycleUsage;
  stubFetch();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Cloudflare Access on the admin host', () => {
  it('serves the dashboard to a valid identity or service token, and nothing at all without one', async () => {
    for (const token of [await jwt(), await service()]) {
      const page = await admin('/', token);
      expect(page.status).toBe(200);
      expect(page.headers.get('Content-Security-Policy')).toBe(STRICT);
      expect(page.headers.get('Cache-Control')).toBe('no-store');
      expect(page.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      const html = await page.text();
      expect(html).toContain('<script src="/admin/admin.js" defer></script>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|\sstyle=/);
      // The site's files the dashboard uses too, fonts included (immutable on fyl.at), are no-store here like the rest.
      for (const path of ['/admin/admin.js', '/admin/admin.css', '/styles.css', '/theme.js', '/favicon.svg', '/apple-touch-icon.png', '/fonts/plex-sans-600.woff2']) {
        const asset = await admin(path, token);
        expect(asset.status, path).toBe(200);
        expect(asset.headers.get('Cache-Control'), path).toBe('no-store');
        await asset.arrayBuffer();
      }
    }
    // Without a token: 403 for the dashboard, its files, the APIs (an operator token alone too), the public site's files
    // and unknown paths alike. (These calls skip the asset layer; run_worker_first: true is what sends them to the Worker.)
    for (const [path, init] of [['/', {}], ['/admin/admin.js', {}], ['/api/stats', {}], ['/api/billing', bearer(OPERATOR_TOKEN)], ['/api/admin/ready', bearer(OPERATOR_TOKEN)],
      ['/api/admin/uploads', { method: 'POST', body: '{"paused":true}', headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN, 'Content-Type': 'application/json' } }],
      ['/styles.css', {}], ['/fonts/plex-sans-600.woff2', {}], ['/app.js', {}], ['/download', {}], ['/report.html', {}], ['/cli/latest', {}], ['/nope', {}]] as const) {
      const response = await admin(path, null, init);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: 'Cloudflare Access sign-in required.', code: 'access_denied' });
    }
  });

  it('refuses tokens with the wrong audience, issuer, times, algorithm, signature, key or subject', async () => {
    const now = Math.floor(Date.now() / 1000), metrics = dataset();
    const refused: [string, string][] = [
      [await jwt({ aud: ['another-application'] }), 'audience'], [await jwt({ aud: undefined }), 'audience'],
      [await jwt({ iss: 'https://evil-team.cloudflareaccess.com' }), 'issuer'], [await jwt({ iss: undefined }), 'issuer'],
      [await jwt({ exp: now - 120 }), 'expired'], [await jwt({ exp: undefined }), 'expired'],
      [await jwt({ nbf: now + 300 }), 'not_yet_valid'], [await jwt({ iat: now + 300 }), 'not_yet_valid'],
      [await jwt({}, { alg: 'HS256' }), 'algorithm'], [await jwt({}, { kid: undefined }), 'algorithm'],
      [await jwt({}, {}, rotated.privateKey), 'signature'], [await jwt({}, { kid: 'k9' }), 'kid'],
      [await jwt({ email: undefined }), 'subject'], [await jwt({ email: '' , common_name: '' }), 'subject'],
      ['not-a-token', 'malformed'], [(await jwt()).split('.').slice(0, 2).join('.') + '.', 'malformed'], [`${b64(encode('{"alg":"none"}'))}.${b64(encode('{}'))}.AAAA`, 'algorithm'],
      // A signature of 4n + 1 characters is no base64url at all: refused like any malformed token, not a 503.
      [(await jwt()).split('.').slice(0, 2).join('.') + '.A', 'malformed'], [(await jwt()).split('.').slice(0, 2).join('.') + '._', 'malformed'],
    ];
    for (const [token, reason] of refused) {
      const response = await admin('/api/admin/ready', token, {}, { METRICS: metrics.METRICS });
      expect([reason, response.status]).toEqual([reason, 403]);
      expect(await codeOf(response)).toBe('access_denied');
    }
    expect(metrics.events).toEqual(refused.map(([, reason]) => 'access_denied:' + reason));
    // A minute of leeway for clocks; `aud` may be a single string.
    for (const token of [await jwt({ exp: now - 30, nbf: now + 30, iat: now + 30 }), await jwt({ aud: AUD })])
      expect((await admin('/api/admin/ready', token)).status).toBe(200);
  });

  it('caches the published keys, fetches them again for an unknown kid at most every 30 seconds, and fails closed without them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await admin('/', await jwt())).status).toBe(200);
    expect((await admin('/', await jwt())).status).toBe(200);
    expect(certCalls).toBe(1);
    // Access rotates its key: the new kid is published, but within 30 s of the last fetch the cache stays.
    published = [await jwkOf(keys.publicKey, 'k1'), await jwkOf(rotated.publicKey, 'k2')];
    const next = await jwt({}, { kid: 'k2' }, rotated.privateKey);
    expect((await admin('/', next)).status).toBe(403);
    expect(certCalls).toBe(1);
    vi.setSystemTime(Date.now() + 31000);
    expect((await admin('/', next)).status).toBe(200);
    expect(certCalls).toBe(2);
    // An hour later the keys are fetched again; while that fails, keys fetched within a day still verify.
    certsAnswer = () => new Response('unavailable', { status: 500 });
    vi.setSystemTime(Date.now() + 2 * 3600000);
    expect((await admin('/', await jwt())).status).toBe(200);
    vi.setSystemTime(Date.now() + 25 * 3600000);
    expect((await admin('/', await jwt())).status).toBe(403);
    // No keys at all (unreachable, unreadable, empty): refused.
    for (const answer of [() => { throw new Error('timeout'); }, () => new Response('<html>'), () => Response.json({ keys: [] })]) {
      forgetAccessKeys();
      certsAnswer = answer as () => Response;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await admin('/', await jwt())).status).toBe(403);
      errors.mockRestore();
    }
  });

  it('fails closed without a team domain or audience, and opens without Access only for the local development bypass', async () => {
    const token = await jwt(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}), metrics = dataset();
    for (const bindings of [{ ACCESS_TEAM_DOMAIN: '' }, { ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: 'evil.example.com' }])
      expect((await admin('/', token, {}, { ...bindings, METRICS: metrics.METRICS })).status, JSON.stringify(bindings)).toBe(403);
    expect(metrics.events).toEqual(['misconfigured:', 'misconfigured:', 'misconfigured:']);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
    errors.mockRestore();
    const local = 'http://admin.localhost/';
    // All three are needed: an emptied team domain, DEV_ACCESS_BYPASS "1" and a *.localhost admin host.
    expect((await admin('/', null, {}, { ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1' })).status).toBe(403);
    expect((await admin(local, null, {}, { ADMIN_HOST: 'admin.localhost', DEV_ACCESS_BYPASS: '1' })).status).toBe(403);
    expect((await admin(local, null, {}, { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: 'true' })).status).toBe(403);
    const open = await admin(local, null, {}, { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1' });
    expect(open.status).toBe(200);
    await open.text();
    // The bypass is the owner locally: the dashboard's reads work, changes still need the operator token.
    const bypass = { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1' };
    expect((await admin('http://admin.localhost/api/admin/ready', null, {}, bypass)).status).toBe(200);
    expect((await admin('http://admin.localhost/api/admin/uploads', null, { method: 'POST', body: '{"paused":true}', headers: { 'Content-Type': 'application/json' } }, bypass)).status).toBe(401);
  });

  it('is configured for admin.fyl.at in wrangler.jsonc, with no development switch and no owner address in it', () => {
    expect(settings.routes).toContainEqual({ pattern: 'admin.fyl.at', custom_domain: true });
    expect(settings.vars.ADMIN_HOST).toBe('admin.fyl.at');
    expect(settings.vars.ACCESS_TEAM_DOMAIN).toMatch(/^[a-z0-9-]+\.cloudflareaccess\.com$/);
    expect(settings.vars.ANALYTICS_ACCOUNT_ID).toMatch(/^[0-9a-f]{32}$/);
    // The owner's Access identities are the ADMIN_EMAILS secret: the public config names no person.
    expect(settings.vars).not.toHaveProperty('ADMIN_EMAILS');
    expect(config).not.toMatch(/@/);
    // The account is on Workers Paid since 2026-10-28: its billing cycle starts on the 28th (src/billing.ts).
    expect(settings.vars.BILLING_CYCLE_DAY).toBe('28');
    expect(settings.vars.ACCESS_AUD).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(settings.vars).filter(name => name.startsWith('DEV_'))).toEqual([]);
    // The Worker runs first for every request, whatever the host: otherwise the asset layer would answer any path that
    // names a file in dist/ before the Access check on the admin host, and dist/admin/ on fyl.at. The tests call the
    // Worker directly and can't see that layer, so this setting is what makes their admin-host answers the real ones.
    expect(settings.assets.run_worker_first).toBe(true);
    expect(settings.analytics_engine_datasets[0].dataset).toBe(DATASET);
  });
});

describe('host routing', () => {
  it('keeps every /admin path and the statistics a 404 on the public host, Access token or not', async () => {
    const token = await jwt();
    for (const path of ['/admin', '/admin/', '/admin/index.html', '/admin/admin.js', '/admin/admin.css']) {
      for (const response of [await call(path), (await direct(path, {}, { headers: { 'Cf-Access-Jwt-Assertion': token } })).response]) {
        expect(response.status, path).toBe(404);
        const text = await response.text();
        expect(text, path).not.toContain('Statistics');
        expect(text, path).not.toContain('FylAdmin');
      }
    }
    for (const path of ['/api/stats', '/api/billing']) {
      for (const secret of [OPERATOR_TOKEN, MONITOR_TOKEN]) {
        const response = await call(path, { headers: { 'Cf-Access-Jwt-Assertion': token, Authorization: 'Bearer ' + secret } });
        expect([path, response.status, await codeOf(response)]).toEqual([path, 404, 'not_found']);
      }
    }
    expect(graphqlCalls).toEqual([]);
  });

  it('serves only the dashboard, its statistics and the operator API on the admin host', async () => {
    const token = await jwt(), { receipt } = await file();
    for (const path of ['/config.js', '/api/health', new URL(receipt.url).pathname, '/report', '/privacy', '/index.html', '/admin/', '/admin/index.html', '/cli/latest', '/api/reports',
      '/app.js', '/download', '/download.html', '/report.html', '/fonts/OFL-IBM-Plex.txt', '/cli/install']) {
      const response = await admin(path, token);
      expect(response.status, path).toBe(404);
      await response.arrayBuffer();
    }
    expect((await admin('/api/upload/init', token, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(404);
    // The host as browsers may write it: upper case, a trailing dot.
    expect((await admin('https://ADMIN.fyl.at./', null)).status).toBe(403);
  });
});

describe('permissions on the admin host', () => {
  it("lets the owner's identity read readiness, upload status and the report queue without a token, the queue without reporter details", async () => {
    const owner = await jwt(), { receipt } = await file();
    const filed = await post('/api/reports', { link: receipt.url, category: 'malware', details: 'This archive carries a trojan horse.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true });
    expect(filed.status).toBe(201);
    const { case: id } = await filed.json<{ case: string }>();
    expect((await admin('/api/admin/ready', owner)).status).toBe(200);
    const status = await admin('/api/admin/uploads', owner);
    expect(status.status).toBe(200);
    expect(await status.json()).toHaveProperty('stored');
    const queue = await (await admin('/api/admin/reports?status=open', owner)).json<{ reports: Record<string, unknown>[] }>();
    const entry = queue.reports.find(item => item.case === id);
    expect(entry).toEqual({ case: id, createdAt: expect.any(Number), category: 'malware', priority: 2, status: 'open', outcome: null, fileAvailable: true });
    expect(JSON.stringify(queue)).not.toMatch(/ada@example\.org|Ada Reporter|trojan|network|transferId/);
    // With the operator token the same listing is the full one.
    const full = await (await admin('/api/admin/reports?status=open', owner, bearer(OPERATOR_TOKEN))).json<{ reports: Record<string, unknown>[] }>();
    expect(full.reports.find(item => item.case === id)).toMatchObject({ email: 'ada@example.org', transferId: receipt.id, details: 'This archive carries a trojan horse.' });
    // Everything else needs the operator token, for the owner too.
    const json = { 'Content-Type': 'application/json' };
    for (const [path, init] of [['/api/admin/uploads', { method: 'POST', body: '{"paused":true}', headers: json }], ['/api/admin/takedown', { method: 'POST', body: `{"id":"${receipt.id}","note":"test"}`, headers: json }],
      ['/api/admin/reconcile', { method: 'POST', body: '{}', headers: json }], [`/api/admin/transfers/${receipt.id}`, {}], [`/api/admin/reports/${id}`, {}],
      [`/api/admin/reports/${id}`, { method: 'POST', body: '{"action":"note","note":"x"}', headers: json }], ['/api/admin/ready', { method: 'HEAD' }]] as const) {
      const response = await admin(path, owner, init);
      expect([path, init.method, response.status]).toEqual([path, init.method, 401]);
      await response.arrayBuffer();
    }
    expect((await operator(`/api/admin/transfers/${receipt.id}`)).status).toBe(200);
    const paused = await admin('/api/admin/uploads', owner, { method: 'POST', body: '{"paused":true}', headers: { ...json, Authorization: 'Bearer ' + OPERATOR_TOKEN } });
    try { expect(paused.status).toBe(200); }
    finally { expect((await admin('/api/admin/uploads', owner, { method: 'POST', body: '{"paused":false}', headers: { ...json, Authorization: 'Bearer ' + OPERATOR_TOKEN } })).status).toBe(200); }
  });

  it('gives service tokens and other identities nothing without the operator token, MONITOR_TOKEN readiness and the estimate only', async () => {
    for (const token of [await service(), await jwt({ email: 'someone@example.org' }), await jwt({ email: OWNER_EMAIL.toUpperCase() + '.evil.example' })]) {
      for (const path of ['/api/admin/ready', '/api/admin/uploads', '/api/admin/reports', '/api/stats', '/api/billing'])
        expect([path, (await admin(path, token)).status]).toEqual([path, 401]);
      expect((await admin('/api/admin/ready', token, bearer(MONITOR_TOKEN))).status).toBe(200);
      expect((await admin('/api/admin/uploads', token, bearer(MONITOR_TOKEN))).status).toBe(401);
      expect((await admin('/api/stats', token, bearer(MONITOR_TOKEN))).status).toBe(401);
      expect(await codeOf(await admin('/api/billing', token, bearer(MONITOR_TOKEN)))).toBe('billing_unconfigured');
      expect((await admin('/api/admin/uploads', token, bearer(OPERATOR_TOKEN))).status).toBe(200);
      expect(await codeOf(await admin('/api/stats', token, bearer(OPERATOR_TOKEN)))).toBe('stats_unconfigured');
      expect(await codeOf(await admin('/api/billing', token, bearer(OPERATOR_TOKEN)))).toBe('billing_unconfigured');
    }
    // E-mail addresses compare without case.
    expect((await admin('/api/admin/ready', await jwt({ email: 'Owner@EXAMPLE.org' }))).status).toBe(200);
  });

  it("counts the operator routes against ADMIN_RATE, but not the owner's reads", async () => {
    const keys: string[] = [], refusing = { limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success: false }; } };
    for (const path of ['/api/admin/ready', '/api/admin/reports', '/api/admin/uploads', '/api/stats', '/api/billing'])
      expect((await admin(path, await jwt(), {}, { ADMIN_RATE: refusing })).status, path).not.toBe(429);
    expect(keys).toEqual([]);
    expect((await admin('/api/billing', await service(), bearer(OPERATOR_TOKEN), { ADMIN_RATE: refusing })).status).toBe(429);
    keys.length = 0;
    expect((await admin('/api/admin/ready', await service(), bearer(MONITOR_TOKEN), { ADMIN_RATE: refusing })).status).toBe(429);
    // The monitor's estimate like its readiness.
    expect((await admin('/api/billing', await service(), bearer(MONITOR_TOKEN), { ADMIN_RATE: refusing })).status).toBe(429);
    expect((await admin('/api/admin/uploads', await jwt(), { method: 'POST', body: '{"paused":true}', headers: { 'Content-Type': 'application/json' } }, { ADMIN_RATE: refusing })).status).toBe(429);
    expect(keys).toEqual(['198.18.13.251', '198.18.13.251', '198.18.13.251']);
  });
});

describe('the operator API on the public host', () => {
  it('is gone: every /api/admin/ path answers 404, token or not, without touching the rate limit', async () => {
    const refusing = { ADMIN_RATE: { limit: async () => ({ success: false }) } } as unknown as Partial<Env>;
    const answers = [await call('/api/admin/ready', bearer(MONITOR_TOKEN)), await call('/api/admin/uploads'), await call('/api/admin/nope', bearer(OPERATOR_TOKEN)),
      (await direct('/api/admin/ready', refusing)).response];
    for (const response of answers) {
      expect(response.status).toBe(404);
      expect(response.headers.has('Deprecation')).toBe(false);
      await response.arrayBuffer();
    }
    // The admin host still answers.
    expect((await admin('/api/admin/ready', await jwt())).status).toBe(200);
  });
});

/** The Vienna date `offset` days before today (the dashboard's days are Vienna days), up to six. */
const viennaDay = (offset: number) => windowOf(7, Date.now()).buckets[6 - offset].key;
/** Rows as the SQL API answers them for the dashboard's queries (counts as strings, as ClickHouse quotes 64-bit numbers). */
function analytics(query: string) {
  const day = (offset: number) => viennaDay(offset) + ' 00:00:00';
  let data: Record<string, unknown>[];
  if (query.includes('toStartOfInterval')) data = [
    { t: day(0), event: 'page_view', code: 'home', client: 'browser', language: 'de', n: '20', total: '20' }, { t: day(0), event: 'page_view', code: 'home', client: 'curl', language: '', n: '7', total: '7' },
    { t: day(0), event: 'page_view', code: 'home', client: 'bot', language: '', n: '3', total: '3' }, { t: day(0), event: 'page_view', code: 'download', client: 'browser', language: 'de', n: '12', total: '12' },
    // Stored before scripts were told apart: a browser's name without a language.
    { t: day(0), event: 'page_view', code: 'home', client: 'browser', language: '', n: '4', total: '4' },
    { t: day(2), event: 'page_view', code: 'home', client: 'browser', language: 'en', n: '5', total: '5' }, { t: day(2), event: 'upload_completed', code: '', client: '', n: '2', total: '3221225472' },
    { t: day(0), event: 'download_started', code: 'curl', client: '', n: '4', total: '1' }, { t: day(0), event: 'download_started', code: 'own', client: '', n: '3', total: '0' },
    // Uploads by kind of client (blob3 for a completed one, the code for a start); fyl's own stay out.
    { t: day(0), event: 'upload_started', code: 'browser', client: '', language: '', n: '2', total: '2' }, { t: day(0), event: 'upload_started', code: 'own', client: '', language: '', n: '4', total: '4' },
    { t: day(0), event: 'upload_completed', code: 'e2ee', client: 'browser', language: '', n: '1', total: '1048000' },
    { t: day(0), event: 'upload_completed', code: '', client: 'own', language: '', n: '4', total: '8192' },
    { t: '1999-01-01 00:00:00', event: 'page_view', code: 'home', client: 'browser', n: '99', total: '0' },
  ];
  else if (query.includes('blob3 AS referrer')) data = [
    { referrer: 'direct', client: 'browser', language: 'de', n: '25' }, { referrer: 'direct', client: 'curl', language: '', n: '7' }, { referrer: 'google.com', client: 'browser', language: 'de', n: '10' },
    { referrer: 'news.ycombinator.com', client: 'browser', language: 'en', n: '2' }, { referrer: 'crawler.example', client: 'bot', language: '', n: '3' },
    { referrer: 'scraper.example', client: 'browser', language: '', n: '4' },
    // Visits from fyl.at's own pages, by kind (and as stored before the kinds), leave the list for ownReferrers.
    { referrer: 'fyl:download', client: 'browser', language: 'de', n: '3' }, { referrer: 'fyl:report', client: 'browser', language: 'de', n: '1' },
    { referrer: 'internal', client: 'browser', language: 'de', n: '2' }, { referrer: 'fyl:download', client: 'curl', language: '', n: '5' },
  ];
  else if (query.includes('blob4 AS source')) data = [
    { source: 'hn', campaign: 'launch', client: 'browser', language: 'de', n: '6' }, { source: 'newsletter', campaign: 'launch', client: 'browser', language: 'de', n: '1' },
    { source: 'a', campaign: 'b', client: 'browser', language: 'en', n: '1' }, { source: 'spam', campaign: 'x', client: 'bot', language: '', n: '4' },
    { source: 'spam', campaign: 'y', client: 'browser', language: '', n: '4' },
  ];
  else if (query.includes('AS bucket')) data = [
    { bucket: '<1 MB', n: '1', bytes: '1048000' }, { bucket: '≥1 GB', n: '2', bytes: '3221225472' }, { bucket: 'unknown', n: '9', bytes: '9' },
  ];
  else if (query.includes('quantileExactWeighted')) data = [{ median: '1073741824' }];
  else if (query.includes('AS lifetime')) data = [{ lifetime: '300', n: '5' }, { lifetime: '86400', n: '21' }, { lifetime: '0', n: '1' }];
  else if (query.includes('blob4 AS password')) data = [
    // Written before the kind of client and options were recorded; a recorded one; fyl's own smoke runs.
    { mode: '', client: '', password: '', once: '', n: '2', total: '3221225472' }, { mode: 'e2ee', client: 'browser', password: 'password', once: '', n: '1', total: '1048000' },
    { mode: '', client: 'own', password: '', once: 'once', n: '4', total: '8192' },
  ];
  else if (query.includes('double2 AS downloads')) data = [
    { outcome: 'deleted', client: 'browser', downloads: '1', n: '3', total: '10' }, { outcome: 'deleted', client: '', downloads: '0', n: '2', total: '2.004' },
    { outcome: 'expired', client: 'cli', downloads: '0', n: '3', total: '0.33' }, { outcome: 'deleted', client: 'own', downloads: '2', n: '6', total: '0.01' },
  ];
  else if (query.includes('blob10 AS reason')) data = [
    { reason: 'expired', client: 'browser', language: 'de', n: '6' }, { reason: '', client: 'browser', language: 'de', n: '3' },
    { reason: 'missing', client: 'browser', language: 'en', n: '2' }, { reason: 'expired', client: 'bot', language: '', n: '9' },
  ];
  else if (query.includes('blob6 AS country')) data = [
    { country: 'AT', device: 'desktop', client: 'browser', language: 'de', n: '20' }, { country: 'DE', device: 'mobile', client: 'browser', language: 'de', n: '15' },
    { country: 'US', device: '', client: 'bot', language: '', n: '12' }, { country: 'DE', device: '', client: 'curl', language: '', n: '7' },
    { country: 'CA', device: 'desktop', client: 'browser', language: '', n: '4' },
  ];
  else data = [
    { event: 'page_view', code: 'home', n: '35', total: '35' }, { event: 'page_view', code: 'download', n: '12', total: '12' },
    { event: 'upload_completed', code: '', n: '2', total: '3221225472' }, { event: 'download_started', code: 'curl', n: '4', total: '1' },
    { event: 'download_started', code: 'own', n: '3', total: '0' }, { event: 'upload_completed', code: 'e2ee', n: '1', total: '1048000' },
    { event: 'one_time_session', code: '', n: '1', total: '1' }, { event: 'password_ok', code: '', n: '3', total: '3' }, { event: 'password_wrong', code: '', n: '2', total: '2' },
    { event: 'password_paused', code: 'transfer', n: '1', total: '1' }, { event: 'report_received', code: 'malware', n: '2', total: '2' },
    { event: 'quarantine', code: '', n: '1', total: '1' }, { event: 'takedown', code: '', n: '1', total: '1' }, { event: 'budget_refused', code: 'network_bytes', n: '7', total: '7' },
    { event: 'rate_limited', code: 'part', n: '9', total: '9' }, { event: 'preview_served', code: 'png', n: '2', total: '2048' }, { event: 'cleanup_retry', code: 'r2_delete', n: '1', total: '1' },
    { event: 'stored_gb_days', code: 'expired', n: '3', total: '0.33', peak: '0.2' }, { event: 'stored_gb_days', code: 'deleted', n: '5', total: '12.004', peak: '9' },
    { event: 'completion_ms', code: '', n: '4', total: '880', peak: '442' }, { event: 'part_confirmed', code: '', n: '396', total: '1', peak: '1' },
    { event: 'part_failed', code: '', n: '4', total: '67108864', peak: '16777216' }, { event: 'part_failed', code: 'disconnected', n: '3', total: '50331648', peak: '16777216' },
    { event: 'cleanup_age', code: '', n: '2', total: '90', peak: '61' },
    { event: 'fallback', code: 'part_release', n: '1', total: '1', peak: '1' },
    { event: 'misconfigured', code: '', n: '1', total: '1' }, { event: 'turnstile_failed', code: 'expired', n: '3', total: '3' }, { event: 'access_denied', code: 'expired', n: '1', total: '1' },
    { event: 'upload_started', code: 'browser', n: '2', total: '2' }, { event: 'upload_started', code: 'own', n: '4', total: '4' },
    { event: 'cli_fetch', code: 'install', n: '5', total: '5' }, { event: 'cli_fetch', code: 'macos-arm64', n: '3', total: '3' },
  ];
  return Response.json({ meta: [], data, rows: data.length, rows_before_limit_at_least: data.length });
}

describe('statistics', () => {
  const WITH_TOKEN = { CF_ANALYTICS_TOKEN: 'read-only-analytics-token' };

  it('needs CF_ANALYTICS_TOKEN and a known range', async () => {
    const owner = await jwt();
    const missing = await admin('/api/stats?range=7d', owner);
    expect([missing.status, await missing.json()]).toEqual([503, { error: expect.stringContaining('CF_ANALYTICS_TOKEN'), code: 'stats_unconfigured' }]);
    for (const range of ['2d', '', '7D', 'constructor'])
      expect((await admin('/api/stats?range=' + encodeURIComponent(range || 'x'), owner, {}, WITH_TOKEN)).status, range).toBe(400);
    expect(sqlCalls).toEqual([]);
  });

  it('answers aggregates from its SQL queries with the read-only token, every bucket of the range present', async () => {
    sql = analytics;
    const response = await admin('/api/stats?range=7d', await jwt(), {}, WITH_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(sqlCalls).toHaveLength(11);
    for (const call of sqlCalls) {
      expect(call.url).toBe(SQL);
      expect(call.auth).toBe('Bearer read-only-analytics-token');
      expect(call.body).toContain(`FROM ${DATASET}`);
      // From the start of the first of seven whole Vienna days (its midnight six days ago).
      expect(call.body).toContain(`timestamp >= toDateTime(${windowOf(7, Date.now()).start / 1000})`);
      // Weighted by the sample interval, since Analytics Engine samples at volume: a sum, or the median's weight.
      expect(call.body).toMatch(/SUM\(_sample_interval\)|quantileExactWeighted\(0\.5\)\(double1, _sample_interval\)/);
      expect(call.body).not.toContain('COUNT(');
    }
    const stats = await response.json<Record<string, unknown> & { series: { t: string; pageViews: number }[] }>();
    const sqlOf = (part: string) => sqlCalls.map(call => call.body).find(body => body.includes(part)) || '';
    expect(Object.keys(stats).sort()).toEqual(['accessDenied', 'bucket', 'budgetRefused', 'campaigns', 'cleanupRetry', 'cliFetches', 'clients', 'closedReasons', 'counters', 'countries', 'cut', 'devices',
      'downloadsByClient', 'downloadsPerTransfer',
      'firstSeen', 'generatedAt', 'health', 'languages', 'lifetimes', 'misconfigured', 'moderation', 'outcomes', 'ownReferrers', 'pages', 'partial', 'passwords', 'performance', 'previewServed',
      'range', 'rateLimited', 'referrers', 'reportsByCategory', 'sample', 'series', 'timeZone', 'totals', 'truncated', 'turnstileFailed', 'uploadOptions', 'uploadSizes', 'uploadsByClient',
      'uploadsStarted']);
    expect(stats).toMatchObject({
      range: '7d', bucket: 'day', sample: false, truncated: [],
      // Uploads from their own query: fyl's own (the smoke test's CLI) left out and counted apart.
      totals: { pageViews: 37, automatedViews: { curl: 7, bot: 3, script: 4 }, uploads: 3, uploadBytes: 3222273472, uploadsEncrypted: 1, ownUploads: 4, uploadsWithClient: 1,
        uploadsWithOptions: 1, medianUploadBytes: 1073741824, downloads: 4, oneTimeDownloads: 1, ownDownloads: 3, oneTimeSessions: 1,
        // Downloads per closed transfer: only rows that carry a kind of client have a count (fyl's own left out); the
        // base is every transfer closed.
        transfersClosed: 8, transfersWithDownloads: 6, medianDownloads: 0, maxDownloads: 1 },
      downloadsPerTransfer: [{ name: '0', n: 3 }, { name: '1', n: 3 }],
      // Visitors only; a reason not recorded ('') is left to the dashboard's remainder row.
      closedReasons: [{ name: 'expired', n: 6 }, { name: 'missing', n: 2 }], cliFetches: [{ name: 'install', n: 5 }, { name: 'macos-arm64', n: 3 }],
      uploadsByClient: [{ name: 'browser', n: 1 }], uploadsStarted: [{ name: 'browser', n: 2 }], uploadOptions: [{ name: 'e2ee', n: 1 }, { name: 'password', n: 1 }],
      // Visitors are browsers: pages, referrers, campaigns and the audience leave curl and bots out; Clients alone lists them.
      pages: [{ name: 'home', n: 25 }, { name: 'download', n: 12 }],
      // Sizes in their own order, smallest first; a bucket the query doesn't name is ignored.
      uploadSizes: [{ name: '<1 MB', n: 1, bytes: 1048000 }, { name: '≥1 GB', n: 2, bytes: 3221225472 }],
      referrers: [{ name: 'direct', n: 25 }, { name: 'google.com', n: 10 }, { name: 'news.ycombinator.com', n: 2 }],
      ownReferrers: { download: 3, report: 1, site: 0, unsplit: 2 },
      campaigns: [{ source: 'hn', campaign: 'launch', n: 6 }, { source: 'a', campaign: 'b', n: 1 }, { source: 'newsletter', campaign: 'launch', n: 1 }],
      countries: [{ name: 'AT', n: 20 }, { name: 'DE', n: 15 }],
      devices: [{ name: 'desktop', n: 20 }, { name: 'mobile', n: 15 }],
      // A browser without a language (stored before scripts were told apart) is a script there, and nowhere a visitor.
      clients: [{ name: 'browser', n: 35 }, { name: 'bot', n: 12 }, { name: 'curl', n: 7 }, { name: 'script', n: 4 }], languages: [{ name: 'de', n: 35 }],
      downloadsByClient: [{ name: 'curl', n: 4 }], passwords: { ok: 3, wrong: 2, paused: 1 }, reportsByCategory: [{ name: 'malware', n: 2 }],
      moderation: { quarantine: 1, restore: 0, takedown: 1 }, budgetRefused: [{ name: 'network_bytes', n: 7 }], rateLimited: [{ name: 'part', n: 9 }],
      previewServed: { n: 2, bytes: 2048 }, cleanupRetry: [{ name: 'r2_delete', n: 1 }], misconfigured: 1, turnstileFailed: [{ name: 'expired', n: 3 }],
      accessDenied: [{ name: 'expired', n: 1 }],
      // Fractional GB-days stay decimals; the lifetimes come from their own query, zero left out.
      outcomes: [{ name: 'deleted', n: 5, gbDays: 12 }, { name: 'expired', n: 3, gbDays: 0.33 }],
      lifetimes: [{ seconds: 300, n: 5 }, { seconds: 86400, n: 21 }],
      performance: { completionAvgMs: 220, completionMaxMs: 442, cleanupLagMaxS: 61, partFailedPct: 1 },
      health: { partFailed: { n: 4, bytes: 67108864 }, partDisconnected: { n: 3, bytes: 50331648 }, partRefused: [], partLimit: 0, partBusy: 0, fallback: [{ name: 'part_release', n: 1 }], budgetDrift: [],
        cleanupOrphan: 0, oneTimeInterrupted: 0, earlyWait: 0 },
    });
    expect((stats.counters as { event: string; code: string; n: number; total: number }[])).toContainEqual({ event: 'stored_gb_days', code: 'expired', n: 3, total: 0.33 });
    expect(sqlOf('AS lifetime')).toContain("blob1 = 'completion_lifetime'");
    // Where counting began is fixed (COUNTED_SINCE), not read from the data.
    expect(sqlOf('MAX(double1) AS peak')).not.toContain('MIN(timestamp)');
    // Seven whole days (today, still running, and the six before it), oldest first; a row outside the range is ignored.
    const today = viennaDay(0), before = viennaDay(2);
    expect(stats.series).toHaveLength(7);
    expect(stats.partial).toBe(today);
    expect(Object.keys(stats.firstSeen as object).sort()).toEqual(['clients', 'downloads', 'pageViews', 'transfers', 'uploads']);
    expect(stats.series.at(-1)).toEqual({ t: today, pageViews: 32, homeViews: 20, automatedViews: 14, uploads: 1, uploadBytes: 1048000, webStarted: 2, webUploads: 1, downloads: 4 });
    expect(stats.series.find(point => point.t === before)).toEqual({ t: before, pageViews: 5, homeViews: 5, automatedViews: 0, uploads: 2, uploadBytes: 3221225472, webStarted: 0,
      webUploads: 0, downloads: 0 });
    // Uploads completed two days ago without a kind of client: counting by kind began today.
    expect((stats.firstSeen as Record<string, string | null>).clients).toBe(today);
    expect(sqlOf('toStartOfInterval')).toContain("if(blob1 = 'upload_completed', blob3, blob8) AS client");
    // The client and the language are grouped where visitors are told apart; campaigns are a query of their own.
    for (const part of ['toStartOfInterval', 'blob3 AS referrer', 'blob4 AS source']) expect(sqlOf(part)).toMatch(/(?:blob8|blob3, blob8\)) AS client, blob9 AS language/);
    expect(sqlOf('blob3 AS referrer')).not.toContain('blob4');
    expect(sqlOf('blob4 AS source')).toContain("(blob4 != '' OR blob5 != '')");
    expect(sqlOf('AS bucket')).toContain('if(double1 < 1048576');
    // fyl's own uploads stay out of the sizes, median and lifetimes as well.
    for (const part of ['AS bucket', 'quantileExactWeighted', 'AS lifetime']) expect(sqlOf(part)).toContain("blob3 != 'own'");
    expect(sqlOf('quantileExactWeighted')).toContain('quantileExactWeighted(0.5)(double1, _sample_interval)');
    expect(sqlCalls.some(call => call.body.includes('multiIf'))).toBe(false);
    // A minute in this location's cache, under a key that names the answer's shape: the next request asks nothing.
    expect(new URL(statsCacheKey(ADMIN, ACCOUNT, '7d').url).pathname).toBe(`/__stats/v${SHAPE_VERSION}/${ACCOUNT}/7d`);
    expect(await caches.default.match(statsCacheKey(ADMIN, ACCOUNT, '7d'))).toBeDefined();
    expect((await admin('/api/stats?range=7d', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
    expect(sqlCalls).toHaveLength(11);
  });

  it('shows a day by the hour', async () => {
    const response = await admin('/api/stats?range=1d', await jwt(), {}, WITH_TOKEN);
    const stats = await response.json<{ bucket: string; series: { t: string }[] }>();
    expect(stats.bucket).toBe('hour');
    expect(stats.series).toHaveLength(24);
    expect(stats.series.at(-1)?.t).toBe(new Date().toISOString().slice(0, 13));
    expect(sqlCalls[0].body).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR)");
    expect(sqlCalls.every(call => call.body.includes(`timestamp >= toDateTime(${(Math.floor(Date.now() / 3600000) - 23) * 3600})`))).toBe(true);
  });

  it('names the queries their LIMIT cut, so the dashboard says what may be low', async () => {
    sql = query => {
      // A list at its LIMIT is cut. The sizes and the median report the rows they read in rows_before_limit_at_least
      // (as production does: 134 for 4 buckets), which says nothing about the LIMIT.
      if (query.includes('blob3 AS referrer')) {
        const data = Array.from({ length: 2000 }, (_, index) => ({ referrer: 'site' + index + '.example', client: 'browser', n: '1' }));
        return Response.json({ meta: [], data, rows: data.length, rows_before_limit_at_least: 2000 });
      }
      if (query.includes('AS bucket')) return Response.json({ meta: [], data: [{ bucket: '<1 MB', n: '130', bytes: '1' }, { bucket: '≥1 GB', n: '4', bytes: '9' }], rows: 2, rows_before_limit_at_least: 134 });
      if (query.includes('quantileExactWeighted')) return Response.json({ meta: [], data: [{ median: '1048576' }], rows: 1, rows_before_limit_at_least: 134 });
      return analytics(query);
    };
    const stats = await (await admin('/api/stats?range=30d', await jwt(), {}, WITH_TOKEN)).json<{ truncated: string[] }>();
    expect(stats.truncated).toEqual(['referrers']);
    const many = Array.from({ length: 2000 }, (_, index) => ({ event: 'e' + index, code: '', n: '1', total: '1' }));
    expect(shaped({ events: many }).truncated).toEqual(['events']);
  });

  it('answers 502 when the SQL API fails, logs its status only and caches nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const answer of [() => new Response('{"success":false}', { status: 403 }), () => new Response('not json'), () => { throw new Error('timeout'); }]) {
      sql = answer as () => Response;
      const response = await admin('/api/stats?range=30d', await jwt(), {}, WITH_TOKEN);
      expect([response.status, await codeOf(response)]).toEqual([502, 'stats_unavailable']);
    }
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: 'stats_failed', status: 403 });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('read-only-analytics-token');
    errors.mockRestore();
    sql = analytics;
    expect((await admin('/api/stats?range=30d', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
  });

  it('shows sample data only on a local admin host with DEV_FAKE_STATS', async () => {
    const local = { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1', DEV_FAKE_STATS: '1' };
    const sample = await (await admin('http://admin.localhost/api/stats?range=90d', null, {}, local)).json<{ sample: boolean; series: { t: string }[]; totals: { pageViews: number } }>();
    expect(sample.sample).toBe(true);
    expect(sample.series).toHaveLength(90);
    expect(sample.totals.pageViews).toBeGreaterThan(0);
    // Shaped like production: more than 8 countries (the list's cap shows), automated views beside the browsers'.
    const shown = sample as unknown as { countries: unknown[]; cut: Record<string, unknown>; totals: { automatedViews: Record<string, number> }; firstSeen: Record<string, string | null> };
    expect(shown.countries.length).toBeGreaterThan(8);
    expect(Object.keys(shown.totals.automatedViews).sort()).toEqual(['bot', 'cli', 'curl', 'other', 'script']);
    expect(String(shown.firstSeen.pageViews) > sample.series[0].t).toBe(true);
    expect([shown.firstSeen.uploads, shown.firstSeen.downloads, shown.firstSeen.transfers, shown.firstSeen.clients]).toEqual([null, null, null, null]);
    expect(sampleSince(0).pageViews).toBeLessThan(0);
    expect(sqlCalls).toEqual([]);
    expect(await codeOf(await admin('/api/stats?range=90d', await jwt(), {}, { DEV_FAKE_STATS: '1' }))).toBe('stats_unconfigured');
  });
});

/** shape() of a few query answers; queries left out answered no rows. */
type Answers = Parameters<typeof shape>[1];
const shaped = (rows: Partial<Answers>, range = '7d', now = Date.now()) =>
  shape(range, { ...Object.fromEntries(Object.keys(statsQueries(7, 0)).map(name => [name, []])), ...rows } as Answers, now);

describe('statistics shape', () => {
  it('draws whole buckets, marks the running one and where counting began', () => {
    const now = Date.parse('2026-10-31T15:20:00Z');
    const stats = shaped({}, '30d', now);
    expect(stats.series).toHaveLength(30);
    expect([stats.series[0].t, stats.series.at(-1)?.t, stats.partial]).toEqual(['2026-10-02', '2026-10-31', '2026-10-31']);
    // Buckets before these keys were not counted yet; the dashboard draws them as a band and says "since 31 Oct". Each
    // charted kind has its own start: downloads came two days after uploads. In Vienna time page views (23:00 UTC)
    // began on the 31st.
    expect(stats.firstSeen).toEqual({ pageViews: '2026-10-31', uploads: '2026-10-28', downloads: '2026-10-30', transfers: '2026-10-30', clients: null });
    expect(stats.series.filter(point => point.t < String(stats.firstSeen.pageViews))).toHaveLength(29);
    expect(stats.timeZone).toBe('Europe/Vienna');
    // Fixed, not read from the data: a range without a single event still knows, and quiet hours after the start are
    // counted zeros. A range that starts after counting began has no band.
    const hourly = shaped({}, '1d', Date.parse('2026-11-01T09:00:00Z'));
    expect([hourly.series.length, hourly.series[0].t, hourly.partial]).toEqual([24, '2026-10-31T10', '2026-11-01T09']);
    expect(hourly.firstSeen).toEqual({ pageViews: null, uploads: null, downloads: null, transfers: null, clients: null });
    expect(shaped({}, '1d', now).firstSeen).toEqual({ pageViews: '2026-10-30T23', uploads: null, downloads: null, transfers: null, clients: null });
    expect(COUNTED_SINCE.uploads).toBeLessThan(COUNTED_SINCE.downloads);
    expect(statsQueries(1, now).events).toContain(`timestamp >= toDateTime(${Date.parse('2026-10-30T16:00:00Z') / 1000})`);
  });

  it('buckets days in Vienna time, across the DST change too', () => {
    // Summer time ends on 2026-10-25: that Vienna day is 25 hours long.
    expect([midnight('2026-10-24'), midnight('2026-10-25'), midnight('2026-10-26')].map(time => new Date(time).toISOString()))
      .toEqual(['2026-10-23T22:00:00.000Z', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    expect(new Date(midnight('2027-03-29')).toISOString()).toBe('2027-03-28T22:00:00.000Z');
    const now = Date.parse('2026-10-26T10:00:00Z'), window = windowOf(7, now);
    expect([window.buckets[0].key, window.partial, new Date(window.start).toISOString()]).toEqual(['2026-10-20', '2026-10-26', '2026-10-19T22:00:00.000Z']);
    expect(statsQueries(7, now).series).toContain("toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Europe/Vienna')");
    expect(statsQueries(1, now).series).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR)");
    // A day named at its local midnight, or (should the SQL API answer in UTC) as the instant of that midnight.
    const views = (t: string) => ({ t, event: 'page_view', code: 'home', client: 'browser', language: 'de', n: '1', total: '1' });
    const stats = shaped({ series: [views('2026-10-25 00:00:00'), views('2026-10-24 22:00:00'), views('2026-10-25 23:00:00'), views('2026-10-19 22:00:00')] }, '7d', now);
    expect(stats.series.map(point => [point.t, point.pageViews])).toEqual([['2026-10-20', 1], ['2026-10-21', 0], ['2026-10-22', 0], ['2026-10-23', 0],
      ['2026-10-24', 0], ['2026-10-25', 2], ['2026-10-26', 1]]);
    // Just after Vienna's midnight the new day has begun, while UTC still has the old date.
    expect(windowOf(7, Date.parse('2026-10-30T23:30:00Z')).partial).toBe('2026-10-31');
  });

  it('dates counting by kind of client from uploads that carry none, never from a stretch of CLI uploads', () => {
    const now = Date.parse('2026-11-20T05:30:00Z'), hour = (index: number) => windowOf(1, now).buckets[index].key;
    const row = (index: number, event: string, extra: Record<string, string>) => ({ t: hour(index).replace('T', ' ') + ':00:00', event, code: '', client: '', language: '', n: '1',
      total: '1', ...extra });
    const upload = (index: number, client: string) => row(index, 'upload_completed', { client });
    const start = (index: number, code: string) => row(index, 'upload_started', { code });
    const home = (index: number, n: string) => row(index, 'page_view', { code: 'home', client: 'browser', language: 'de', n });
    const clients = (series: Record<string, string>[]) => shaped({ series }, '1d', now).firstSeen.clients;
    // Weeks after the release: a CLI upload first, then home page views, then the first web upload. Every upload names
    // its kind, so the whole day counts.
    const weeks = shaped({ series: [upload(0, 'cli'), home(2, '7'), start(5, 'browser'), upload(5, 'browser')] }, '1d', now);
    expect(weeks.firstSeen.clients).toBeNull();
    expect(weeks.series.map(point => point.uploads).slice(0, 6)).toEqual([1, 0, 0, 0, 0, 1]);
    // Uploads written before the release (no kind) and after it: counting began with the first labelled one, a CLI
    // upload or a start of any client as well as a web upload; a quiet stretch in between is no start.
    expect(clients([upload(0, ''), upload(3, ''), home(4, '5'), upload(9, 'cli'), start(12, 'browser')])).toBe(hour(9));
    expect(clients([upload(1, ''), start(6, 'curl'), upload(8, 'browser')])).toBe(hour(6));
    // fyl's own uploads are left out of every figure but show that counting began.
    expect(clients([upload(1, ''), upload(4, 'own'), upload(6, 'browser')])).toBe(hour(4));
    // The bucket of the release itself holds both: it is the first counted (the first bucket: nothing before to leave out).
    expect(clients([upload(2, ''), upload(2, 'browser')])).toBe(hour(2));
    expect(clients([upload(0, ''), upload(0, 'cli'), upload(7, 'browser')])).toBeNull();
    // Under a rollback to 2.4.0 uploads carry no kind again: counting starts over after it.
    expect(clients([upload(1, 'browser'), upload(5, ''), upload(7, ''), upload(10, 'cli')])).toBe(hour(10));
    // No labelled upload yet since the last one without: the next bucket (the running one at most).
    expect(clients([upload(3, '')])).toBe(hour(4));
    expect(clients([upload(23, '')])).toBe(hour(23));
    // No upload without a kind in the range: counted throughout, also with no uploads at all.
    expect([clients([]), clients([home(3, '2')]), clients([upload(5, 'unknown')])]).toEqual([null, null, null]);
  });

  it('counts downloads per transfer over the transfers that recorded them, and every closed transfer as the base', () => {
    const transfer = (outcome: string, client: string, downloads: string, n: string) => ({ outcome, client, downloads, n, total: '0.5' });
    const stats = shaped({ transfers: [transfer('expired', '', '0', '4'), transfer('expired', 'browser', '0', '2'), transfer('deleted', 'cli', '3', '1'),
      transfer('consumed', 'browser', '1', '3'), transfer('expired', 'own', '1', '9')] });
    // fyl's own left out; the four closed before their downloads were recorded count in the base, not in the buckets.
    expect([stats.totals.transfersClosed, stats.totals.transfersWithDownloads, stats.totals.medianDownloads, stats.totals.maxDownloads]).toEqual([10, 6, 1, 3]);
    expect(stats.downloadsPerTransfer).toEqual([{ name: '0', n: 2 }, { name: '1', n: 3 }, { name: '2–5', n: 1 }]);
    expect(shaped({}).totals).toMatchObject({ transfersClosed: 0, transfersWithDownloads: 0, medianDownloads: null, maxDownloads: null });
  });

  it('keeps the top 20 of a list and counts what is cut, so "N more" stays right', () => {
    const codes = Array.from({ length: 22 }, (_, index) => String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26));
    const audience = codes.map((country, index) => ({ country, device: 'desktop', client: 'browser', language: 'de', n: String(100 - index) }));
    const stats = shaped({ audience });
    expect(stats.countries).toHaveLength(20);
    expect(stats.countries.at(-1)).toEqual({ name: 'AT', n: 81 });
    expect(stats.cut).toEqual({ countries: { names: 2, n: 80 + 79 } });
    expect(shaped({ audience: audience.slice(0, 20) }).cut).toEqual({});
  });
});

/** The GraphQL API's answer for the cycle so far (the shape it gave for the account on 2026-10-31, with an R2 overage). */
function cycleUsage() {
  const today = new Date().toISOString().slice(0, 10);
  return Response.json({ data: { viewer: { accounts: [{
    workers: [{ sum: { requests: 8232, cpuTimeUs: 31338486 } }],
    storage: [{ max: { payloadSize: 400e9, metadataSize: 800 }, dimensions: { date: today, bucketName: 'fyl-at-files' } }],
    operations: [{ sum: { requests: 1101 }, dimensions: { actionType: 'UploadPart' } }, { sum: { requests: 185 }, dimensions: { actionType: 'GetObject' } },
      { sum: { requests: 144 }, dimensions: { actionType: 'DeleteObject' } }],
    objects: [{ sum: { requests: 5172 } }],
    periodic: [{ sum: { duration: 99.8, rowsRead: 100717, rowsWritten: 14485 } }],
    exceptions: [{ sum: { requests: 4314, errors: 0 }, dimensions: { status: 'success' } }, { sum: { requests: 7, errors: 0 }, dimensions: { status: 'clientDisconnected' } },
      { sum: { requests: 2, errors: 2 }, dimensions: { status: 'scriptThrewException' } }],
  }] } }, errors: null });
}

describe('billing estimate', () => {
  const WITH_TOKEN = { CF_ANALYTICS_TOKEN: 'read-only-analytics-token' };
  type Billing = { sample: boolean; cycle: { day: number; start: string; end: string; days: number; elapsedDays: number }; base: number; aboveAllowance: number; total: number;
    meters: { id: string; used: number; included: number; cost: number }[]; workerErrors: unknown };

  it('needs CF_ANALYTICS_TOKEN and a BILLING_CYCLE_DAY that is a day of the month', async () => {
    const owner = await jwt();
    for (const bindings of [{}, { ...WITH_TOKEN, BILLING_CYCLE_DAY: '32' }, { ...WITH_TOKEN, BILLING_CYCLE_DAY: '' }, { ...WITH_TOKEN, ANALYTICS_ACCOUNT_ID: 'nope' }]) {
      const response = await admin('/api/billing', owner, {}, bindings);
      expect([JSON.stringify(bindings), response.status, await codeOf(response)]).toEqual([JSON.stringify(bindings), 503, 'billing_unconfigured']);
    }
    expect(graphqlCalls).toEqual([]);
  });

  it('asks GraphQL once for the whole account and the cycle so far, and apart for the Worker\'s errors, with the read-only token, and keeps the answer', async () => {
    const response = await admin('/api/billing', await jwt(), {}, WITH_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(graphqlCalls).toHaveLength(2);
    expect(graphqlCalls.map(call => call.auth)).toEqual(['Bearer read-only-analytics-token', 'Bearer read-only-analytics-token']);
    type Sent = { query: string; variables: Record<string, string> };
    const [sent, asked] = [BILLING_QUERY, ERRORS_QUERY].map(query => graphqlCalls.map(call => JSON.parse(call.body) as Sent).find(body => body.query === query) as Sent);
    const cycle = cycleOf(Date.now(), 28);
    expect(sent.variables).toEqual({ account: ACCOUNT, start: new Date(cycle.start).toISOString(), end: expect.any(String) });
    expect(Date.now() - Date.parse(sent.variables.end)).toBeLessThan(60000);
    expect(asked.variables).toEqual({ account: ACCOUNT, day: expect.any(String), end: expect.any(String), script: 'fyl-at' });
    expect(Date.parse(asked.variables.end) - Date.parse(asked.variables.day)).toBe(86400000);
    // The allowances are account-wide: no billed dataset is filtered to the fyl-at script or bucket; only the Worker's
    // errors of the last 24 hours are fyl's own (the Worker named in wrangler.jsonc), in a request of their own.
    expect(sent.query).not.toMatch(/scriptName|bucketName:|fyl-at|exceptions/);
    expect(asked.query).toMatch(/scriptName: \$script/);
    expect(config).toMatch(new RegExp(`^\\s*"name": "${SCRIPT}",$`, 'm'));
    const body = await response.json<Billing>();
    expect(body).toMatchObject({ sample: false, base: 5, cycle: { day: 28, start: new Date(cycle.start).toISOString().slice(0, 10),
      end: new Date(cycle.end - 86400000).toISOString().slice(0, 10), days: cycle.days } });
    // One day at a 400 GB peak is 400 / days GB-month: above the 10 included only in a short enough cycle.
    const storage = body.meters.find(meter => meter.id === 'r2Storage') as Billing['meters'][number], expected = 400e9 / 1e9 / cycle.days + 800 / 1e9 / cycle.days;
    expect(storage.used).toBeCloseTo(expected, 9);
    expect(storage.cost).toBeCloseTo(Math.ceil(expected - 10) * 0.015, 9);
    expect(body.meters.find(meter => meter.id === 'r2ClassA')).toMatchObject({ used: 1101, included: 1e6, cost: 0 });
    expect(body.meters.find(meter => meter.id === 'r2ClassB')).toMatchObject({ used: 185, cost: 0 });
    expect(body.total).toBeCloseTo(5 + storage.cost, 9);
    // The errors are the requests that failed; a client going away is an outcome to show, not an error.
    expect(body.workerErrors).toEqual({ since: asked.variables.day, requests: 4323, errors: 2,
      statuses: [{ name: 'clientDisconnected', n: 7 }, { name: 'scriptThrewException', n: 2 }] });
    // Kept in this location's cache: the next request asks nothing.
    expect((await admin('/api/billing', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
    expect(graphqlCalls).toHaveLength(2);
  });

  it("gives the estimate without the Worker's errors when only their request fails, and fails the estimate whatever they answer", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const expected = await (await admin('/api/billing', await jwt(), {}, WITH_TOKEN)).json<Billing>();
    // A filter or dimension GraphQL rejects fails the whole query; an outage, a refusal or a timeout only that request.
    for (const failure of [() => Response.json({ data: null, errors: [{ message: 'unknown arg "scriptName"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }),
      () => Response.json({ data: null, errors: [{ message: 'not authorized', extensions: { code: 'authz' } }] }), () => new Response('upstream', { status: 500 }),
      () => Response.json({ data: { viewer: { accounts: [{}] } }, errors: null }), () => { throw new Error('timeout'); }]) {
      await clearStats();
      graphql = body => (JSON.parse(body) as { query: string }).query === ERRORS_QUERY ? failure() : cycleUsage();
      const response = await admin('/api/billing', await jwt(), {}, WITH_TOKEN);
      expect(response.status).toBe(200);
      const body = await response.json<Billing>();
      expect(body.workerErrors).toBeNull();
      expect([body.total, body.meters]).toEqual([expected.total, expected.meters]);
      // The monitor reads the same estimate.
      expect((await admin('/api/billing', await service(), bearer(MONITOR_TOKEN), WITH_TOKEN)).status).toBe(200);
    }
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual(expect.arrayContaining([{ event: 'worker_errors_failed', status: 200, code: 'GRAPHQL_VALIDATION_FAILED' },
      { event: 'worker_errors_failed', status: 200, code: 'authz' }, { event: 'worker_errors_failed', status: 500, code: null }, { event: 'worker_errors_failed', status: null, code: null }]));
    expect(logged.filter(line => line.event === 'billing_failed')).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('read-only-analytics-token');
    // The billed request failing fails the estimate, though the Worker's errors answered.
    await clearStats();
    graphql = body => (JSON.parse(body) as { query: string }).query === ERRORS_QUERY ? cycleUsage() : new Response('upstream', { status: 500 });
    const failed = await admin('/api/billing', await jwt(), {}, WITH_TOKEN);
    expect([failed.status, await codeOf(failed)]).toEqual([502, 'billing_unavailable']);
    errors.mockRestore();
  });

  it("gives the monitor's token the estimate behind the service token, and still nothing else", async () => {
    // As scripts/monitor.py asks: the Access service token and MONITOR_TOKEN.
    const token = await service(), monitor = (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, Authorization: 'Bearer ' + MONITOR_TOKEN } });
    const response = await admin('/api/billing', token, monitor(), WITH_TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json<Billing>();
    const storage = body.meters.find(meter => meter.id === 'r2Storage') as Billing['meters'][number];
    expect(body).toMatchObject({ sample: false, base: 5, cycle: { day: 28, days: cycleOf(Date.now(), 28).days } });
    expect(body.meters).toHaveLength(9);
    expect(body.total).toBeCloseTo(5 + storage.cost, 9);
    expect(graphqlCalls).toHaveLength(2);
    // The owner's dashboard reads the same estimate (from the cache now).
    expect(await (await admin('/api/billing', await jwt(), {}, WITH_TOKEN)).json()).toEqual(body);
    // Not the statistics, not the operator views, not a change: 401 there, and 405 for any other method on the estimate
    // and on readiness, before a token is looked at.
    const id = 'A'.repeat(43), json = { 'Content-Type': 'application/json' };
    for (const [path, init, status] of [['/api/stats?range=7d', {}, 401], ['/api/admin/uploads', {}, 401], ['/api/admin/reports', {}, 401], [`/api/admin/transfers/${id}`, {}, 401],
      ['/api/admin/uploads', { method: 'POST', body: '{"paused":true}', headers: json }, 401], ['/api/admin/reconcile', { method: 'POST', body: '{}', headers: json }, 401],
      ['/api/admin/takedown', { method: 'POST', body: `{"id":"${id}","note":"monitor tries"}`, headers: json }, 401],
      ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(method => ['/api/billing', { method }, 405]), ['/api/admin/ready', { method: 'POST' }, 405]] as [string, RequestInit, number][]) {
      const refused = await admin(path, token, monitor(init), WITH_TOKEN);
      expect([path, init.method, refused.status]).toEqual([path, init.method, status]);
      await refused.arrayBuffer();
    }
    expect(sqlCalls).toEqual([]);
    // Only the admin host has the estimate: on fyl.at the monitor's token finds nothing there.
    const elsewhere = await call('/api/billing', { headers: { Authorization: 'Bearer ' + MONITOR_TOKEN } });
    expect([elsewhere.status, await codeOf(elsewhere)]).toEqual([404, 'not_found']);
    // A weak MONITOR_TOKEN (under 32 characters) counts as missing here too.
    const weak = 'weak-monitor-token';
    expect((await admin('/api/billing', token, { headers: { Authorization: 'Bearer ' + weak } }, { ...WITH_TOKEN, MONITOR_TOKEN: weak })).status).toBe(401);
  });

  it('answers 502 when GraphQL fails, logs no token, caches nothing and leaves the statistics alone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sql = analytics;
    for (const answer of [() => new Response('upstream', { status: 500 }), () => new Response('slow down', { status: 429 }),
      () => Response.json({ data: null, errors: [{ message: 'unknown field "requestsNoSuchField"', extensions: {} }] }),
      () => Response.json({ data: null, errors: [{ message: 'try again later', extensions: { code: 'budget' } }] }),
      () => new Response('not json'), () => Response.json({ data: { viewer: { accounts: [{ workers: [] }] } }, errors: null }), () => { throw new Error('timeout'); }]) {
      graphql = answer as () => Response;
      const response = await admin('/api/billing', await jwt(), {}, WITH_TOKEN);
      expect([response.status, await response.json()]).toEqual([502, { error: expect.stringContaining('billing estimate'), code: 'billing_unavailable' }]);
      // The dashboard's statistics come from Analytics Engine's SQL API and answer as before.
      expect((await admin('/api/stats?range=7d', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
    }
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual(expect.arrayContaining([{ event: 'billing_failed', status: 500, code: null }, { event: 'billing_failed', status: 200, code: 'error' },
      { event: 'billing_failed', status: 200, code: 'budget' }, { event: 'billing_failed', status: null, code: null }]));
    expect(JSON.stringify(errors.mock.calls)).not.toContain('read-only-analytics-token');
    errors.mockRestore();
    graphql = cycleUsage;
    expect((await admin('/api/billing', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
  });

  it('answers 503 billing_refused when Cloudflare refuses the token, so the monitor mails it rather than warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sql = analytics;
    // An unknown token and a malformed one as the API answered them on 2026-10-31, a 403 refusal, and a valid token
    // without Account Analytics Read for the account (also as answered).
    const refusal = (status: number, code: number, message: string) => () => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
    for (const answer of [refusal(401, 10000, 'Authentication error'), refusal(400, 9106, 'Authentication failed (status: 400)'), refusal(403, 9109, 'Unauthorized to access requested resource'),
      () => Response.json({ data: null, errors: [{ message: 'not authorized for that account', extensions: { code: 'authz' } }] })]) {
      graphql = answer;
      const response = await admin('/api/billing', await jwt(), {}, WITH_TOKEN);
      expect([response.status, await response.json()]).toEqual([503, { error: expect.stringContaining('refused the CF_ANALYTICS_TOKEN secret'), code: 'billing_refused' }]);
      // The monitor's token gets the same answer, and the statistics stay as they are.
      const monitor = await admin('/api/billing', await service(), bearer(MONITOR_TOKEN), WITH_TOKEN);
      expect([monitor.status, await codeOf(monitor)]).toEqual([503, 'billing_refused']);
      expect((await admin('/api/stats?range=7d', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
    }
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual(expect.arrayContaining([{ event: 'billing_failed', status: 401, code: null }, { event: 'billing_failed', status: 400, code: null },
      { event: 'billing_failed', status: 403, code: null }, { event: 'billing_failed', status: 200, code: 'authz' }]));
    expect(JSON.stringify(errors.mock.calls)).not.toContain('read-only-analytics-token');
    errors.mockRestore();
    // Nothing was kept: a replaced token answers at once.
    graphql = cycleUsage;
    expect((await admin('/api/billing', await jwt(), {}, WITH_TOKEN)).status).toBe(200);
  });

  it('shows a sample estimate only on a local admin host with DEV_FAKE_STATS', async () => {
    const local = { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1', DEV_FAKE_STATS: '1' };
    const sample = await (await admin('http://admin.localhost/api/billing', null, {}, local)).json<Billing>();
    expect(sample.sample).toBe(true);
    expect(sample.meters).toHaveLength(9);
    expect(sample.total).toBeGreaterThan(5);
    expect(graphqlCalls).toEqual([]);
    expect(await codeOf(await admin('/api/billing', await jwt(), {}, { DEV_FAKE_STATS: '1' }))).toBe('billing_unconfigured');
  });

  it('says in readiness whether uploads are paused, and the dashboard prints it like npm run admin -- ready', async () => {
    const read = async () => (await admin('/api/admin/ready', await jwt())).json<{ paused: boolean | null; e2ee: string }>();
    expect((await read()).paused).toBe(false);
    expect((await pause(true)).status).toBe(200);
    try { expect((await read()).paused).toBe(true); } finally { await pause(false); }
    expect((await read()).paused).toBe(false);
  });

  it('names the live version in readiness from the version metadata binding, and null without it', async () => {
    const read = async (bindings: Record<string, unknown>) => (await (await admin('/api/admin/ready', await jwt(), {}, bindings)).json<{ version: unknown }>()).version;
    expect(await read({ CF_VERSION_METADATA: { id: '7c1e0d4a-0000-4000-8000-000000000000', tag: 'v2.4.1', timestamp: '2026-11-01T10:15:00Z' } }))
      .toEqual({ tag: 'v2.4.1', deployedAt: '2026-11-01T10:15:00.000Z' });
    // A version uploaded without a tag, or a value that is no tag or time, says so rather than guessing.
    expect(await read({ CF_VERSION_METADATA: { id: 'x', tag: '', timestamp: 'soon' } })).toEqual({ tag: null, deployedAt: null });
    expect(await read({ CF_VERSION_METADATA: undefined })).toBeNull();
    expect(config).toMatch(/"version_metadata": \{\s*"binding": "CF_VERSION_METADATA"\s*\}/);
  });

  it("gives the local dashboard's readiness a sample Storage in use, marked, and every token the real bytes", async () => {
    type Capacity = { storedBytes: number; maxStoredBytes: number; storedPercent: number; sample?: boolean };
    const local = { ADMIN_HOST: 'admin.localhost', ACCESS_TEAM_DOMAIN: '', DEV_ACCESS_BYPASS: '1', DEV_FAKE_STATS: '1' };
    const real = (await (await operator('/api/admin/uploads')).json<{ stored: { bytes: number; maxBytes: number } }>()).stored;
    const read = async (url: string, token: string | null, init: RequestInit, bindings: Record<string, unknown>) =>
      (await (await admin(url, token, init, bindings)).json<{ ready: boolean; capacity: Capacity }>()).capacity;
    const sample = await read('http://admin.localhost/api/admin/ready', null, {}, local), bytes = Math.min(412 * 1024 ** 3, Math.floor(real.maxBytes / 10));
    expect(sample).toMatchObject({ storedBytes: bytes, maxStoredBytes: real.maxBytes, storedPercent: Math.floor(bytes * 100 / real.maxBytes), sample: true });
    // The operator token (npm run admin -- ready) on the same host, and the owner on the real admin host, read the Budget.
    for (const capacity of [await read('http://admin.localhost/api/admin/ready', null, bearer(OPERATOR_TOKEN), local), await read('/api/admin/ready', await jwt(), {}, { DEV_FAKE_STATS: '1' })]) {
      expect(capacity).not.toHaveProperty('sample');
      expect([capacity.storedBytes, capacity.maxStoredBytes]).toEqual([real.bytes, real.maxBytes]);
    }
  });
});

describe('dashboard helpers', () => {
  interface Admin {
    count(value: number): string; size(bytes: number): string; ticks(max: number, bytes?: boolean): number[]; label(bucket: string, hourly?: boolean, short?: boolean): string;
    age(seconds: number): string; command(id: string, action: string): string; defaultAction(item: { fileAvailable?: boolean }): string;
    storage(capacity: unknown): [string, string] | null; money(value: number, exact?: boolean): string; charges(base: number, above: number): string;
    amount(value: number): string; usage(meter: { used: number; included: number; unit: string; cost: number }): string;
    spoken(meter: { used: number; included: number; unit: string; cost: number }): string; period(cycle: { start: string; end: string }): string;
    readyLines(body: unknown): [string, boolean][]; cutNotice(truncated: unknown): string; duration(seconds: number): string; shares(values: number[], whole: number): string[];
    since(stats: unknown, kind: string): string; tiles(stats: unknown, range: string): Record<string, [string, string]>; eventGroups(stats: unknown): [string, [string, number | string][], string, boolean][];
    funnelSteps(stats: unknown): [string, number, string][]; channels(stats: unknown): string[]; workerErrors(value: unknown): string;
    statusParts(ready: unknown, day: unknown, bill: unknown): { parts: [string, boolean][]; urgent: boolean; readiness: boolean; where: string };
  }
  let helpers: Admin;
  beforeAll(async () => {
    // @ts-expect-error: a browser script without type declarations.
    await import('../dist/admin/admin.js');
    helpers = (globalThis as unknown as { FylAdmin: Admin }).FylAdmin;
  });

  it('formats counts, binary sizes, round axes, buckets and ages', () => {
    expect([helpers.count(1234567), helpers.size(0), helpers.size(1536), helpers.size(3 * 1024 ** 3), helpers.size(1.5 * 1024 ** 4)]).toEqual(['1,234,567', '0 bytes', '1.5 KB', '3 GB', '1.5 TB']);
    expect(helpers.ticks(0)).toEqual([0, 1]);
    expect(helpers.ticks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(helpers.ticks(511)).toEqual([0, 200, 400, 600]);
    expect(helpers.ticks(44.3 * 1024 ** 3, true)).toEqual([0, 20, 40, 60].map(value => value * 1024 ** 3));
    // An empty byte chart still gets a sensible axis, never "1 bytes" from a half-byte step.
    expect(helpers.ticks(0, true)).toEqual([0, 1024]);
    expect(helpers.ticks(0.5, true)).toEqual([0, 1]);
    expect([helpers.size(1024), helpers.size(0.5), helpers.size(1.4), helpers.size(2)]).toEqual(['1 KB', '1 byte', '1 byte', '2 bytes']);
    // Shares that add up: largest remainder, "<1" for a little, ">99" for nearly all.
    expect(helpers.shares([995, 5], 1000)).toEqual(['>99', '<1']);
    expect(helpers.shares([1, 1, 1], 3)).toEqual(['34', '33', '33']);
    expect(helpers.shares([45, 30, 25], 100).map(Number).reduce((a, b) => a + b, 0)).toBe(100);
    expect(helpers.shares([1, 1, 1, 1, 1, 1, 1], 7).map(Number).reduce((a, b) => a + b, 0)).toBe(100);
    expect(helpers.shares([10, 0], 10)).toEqual(['100', '0']);
    expect(helpers.label('2026-10-30')).toBe('Fri 30 Oct');
    expect(helpers.label('2026-10-30', false, true)).toBe('30 Oct');
    // Hours are keyed in UTC and named in Vienna time; the autumn DST change shows 02:00 twice.
    expect(helpers.label('2026-10-30T13', true)).toBe('Fri 14:00');
    expect(helpers.label('2026-10-30T13', true, true)).toBe('14:00');
    expect(['2026-10-25T00', '2026-10-25T01'].map(hour => helpers.label(hour, true))).toEqual(['Sun 02:00', 'Sun 02:00']);
    expect([helpers.age(59), helpers.age(3 * 3600 + 600), helpers.age(3 * 86400 + 7200), helpers.age(Number.NaN)]).toEqual(['0 min', '3 h 10 min', '3 d 2 h', '']);
  });

  it('writes storage in use, dollars, meter amounts and the cycle', () => {
    const max = 5 * 1024 ** 4;
    expect(helpers.storage({ storedBytes: 412 * 1024 ** 3, maxStoredBytes: max })).toEqual(['412 GB', '8 % of 5 TB · now']);
    expect(helpers.storage({ storedBytes: 157286400, maxStoredBytes: max })).toEqual(['150 MB', '<1 % of 5 TB · now']);
    expect(helpers.storage({ storedBytes: 0, maxStoredBytes: max })).toEqual(['0 bytes', '0 % of 5 TB · now']);
    expect(helpers.storage({ storedBytes: 412 * 1024 ** 3, maxStoredBytes: max, sample: true })).toEqual(['412 GB', '8 % of 5 TB · sample']);
    for (const capacity of [null, {}, { storedPercent: 3 }, { storedBytes: 5, maxStoredBytes: 0 }, { storedBytes: null, maxStoredBytes: max }]) expect(helpers.storage(capacity)).toBeNull();
    expect([helpers.money(5), helpers.money(5.465), helpers.money(0.015, true), helpers.money(0.6, true), helpers.money(82.4749)]).toEqual(['$5.00', '$5.47', '$0.015', '$0.60', '$82.47']);
    // The line under the total is in cents like the total ("About $554.53 so far"), not in a meter's third decimal.
    expect(helpers.charges(5, 549.525)).toBe('$5.00 Workers Paid base + $549.53 above the allowances.');
    expect(helpers.charges(5, 0.001)).toBe('$5.00 Workers Paid base + less than $0.01 above the allowances.');
    expect(helpers.charges(5, 0)).toBe('$5.00 Workers Paid base, everything else within the allowances so far.');
    expect([0, 0.98, 49.032, 99.84, 8232, 56800, 244000, 1e6, 1.408e6, 400000, 25e9].map(helpers.amount))
      .toEqual(['0', '0.98', '49', '99.8', '8,232', '56,800', '244K', '1M', '1.4M', '400K', '25B']);
    expect(helpers.usage({ used: 49.03, included: 10, unit: 'GB-month', cost: 0.6 })).toBe('49 / 10 GB-month · $0.60');
    expect(helpers.usage({ used: 31338.486, included: 30e6, unit: 'ms', cost: 0 })).toBe('31,338 / 30M ms');
    expect(helpers.usage({ used: 5172, included: 1e6, unit: 'requests', cost: 0 })).toBe('5,172 / 1M');
    // A screen reader gets full figures and words, not "1M" or "GB-s".
    expect(helpers.spoken({ used: 244000, included: 10e6, unit: 'requests', cost: 0 })).toBe('244,000 requests used of 10,000,000 included');
    expect(helpers.spoken({ used: 11600, included: 400000, unit: 'GB-s', cost: 0 })).toBe('11,600 gigabyte-seconds used of 400,000 included');
    expect(helpers.spoken({ used: 49.03, included: 10, unit: 'GB-month', cost: 0.585 })).toBe('49 gigabyte-months used of 10 included, $0.585 above the allowance');
    expect(helpers.spoken({ used: 0.98, included: 10, unit: 'GB-month', cost: 0 })).toBe('0.98 gigabyte-months used of 10 included');
    expect(helpers.period({ start: '2026-10-28', end: '2026-11-27' })).toBe('28 Oct – 27 Nov');
    // fyl's Worker over the last 24 hours, or nothing when the estimate had no such answer.
    expect(helpers.workerErrors({ requests: 61000, errors: 2, statuses: [{ name: 'clientDisconnected', n: 37 }, { name: 'scriptThrewException', n: 2 }] }))
      .toBe('2 errors in 61,000 requests (client went away 37 · exceptions 2)');
    expect(helpers.workerErrors({ requests: 4321, errors: 0, statuses: [] })).toBe('0 errors in 4,321 requests');
    expect([helpers.workerErrors(null), helpers.workerErrors({ requests: 5 })]).toEqual(['', '']);
  });

  it('draws a body of an older or partial shape without throwing', () => {
    for (const body of [null, {}, { totals: {} }, { totals: { pageViews: 4, uploads: 1, uploadBytes: 2048 } }]) {
      expect(() => helpers.tiles(body, '7d')).not.toThrow();
      expect(() => helpers.eventGroups(body)).not.toThrow();
    }
    expect(helpers.tiles({ totals: { pageViews: 4 } }, '7d').pageViews).toEqual(['4', 'in 7 days']);
    expect(helpers.tiles({ totals: { pageViews: 203, automatedViews: { curl: 147, other: 168, bot: 43, cli: 0 } } }, '7d').pageViews)
      .toEqual(['203', '+358 automated (other 168 · curl 147 · bots 43)']);
    // A range that starts before a kind was counted says since when, beside the automated views too.
    const late = { bucket: 'day', series: [{ t: '2026-10-03' }], firstSeen: { pageViews: '2026-10-14', uploads: null, downloads: '2026-10-30' },
      totals: { pageViews: 1718, automatedViews: { curl: 1079, bot: 300 }, uploads: 0, uploadBytes: 0, downloads: 5, oneTimeDownloads: 1, oneTimeSessions: 1 } };
    expect(helpers.tiles(late, '30d')).toMatchObject({ pageViews: ['1,718', 'since 14 Oct · +1,379 automated (curl 1,079 · bots 300)'],
      uploads: ['0', 'in 30 days'], uploadBytes: ['0 bytes', 'in 30 days'], downloads: ['5', 'since 30 Oct · 1 of one-time links · 1 session'] });
    expect(helpers.tiles({ ...late, totals: { pageViews: 4 } }, '30d').pageViews).toEqual(['4', 'since 14 Oct']);
    expect(helpers.since({ bucket: 'hour', series: [{ t: '2026-10-30T16' }], firstSeen: { pageViews: '2026-10-30T23' } }, 'pageViews')).toBe('since Sat 00:00');
    expect(helpers.since({ series: [{ t: '2026-10-03' }], firstSeen: { events: '2026-10-14' } }, 'uploads')).toBe('');
    // The median, then the web's and the CLI's share of the uploads whose kind of client was recorded.
    expect(helpers.tiles({ totals: { uploads: 100, uploadBytes: 28.3 * 1024 ** 3, medianUploadBytes: 1048576, uploadsWithClient: 80 },
      uploadsByClient: [{ name: 'browser', n: 50 }, { name: 'cli', n: 24 }, { name: 'curl', n: 6 }] }, '7d').uploads).toEqual(['100', 'median 1 MB · web 63 % · CLI 30 %']);
    expect(helpers.tiles({ totals: { uploads: 100, medianUploadBytes: 1048576 } }, '7d').uploads).toEqual(['100', 'median 1 MB']);
    expect(helpers.tiles({ totals: { uploads: 300 } }, '7d').uploads).toEqual(['300', 'in 7 days']);
    expect(helpers.channels({ totals: { uploadsWithClient: 0 }, uploadsByClient: [] })).toEqual([]);
    expect(helpers.tiles(null, '7d').uploads).toEqual(['–', '']);
  });

  it('draws the funnel from a home page view to a download, over the days uploads are counted by client', () => {
    const point = (t: string, homeViews: number, webStarted: number, webUploads: number, uploads: number, downloads: number) => ({ t, homeViews, webStarted, webUploads, uploads, downloads });
    const stats = { bucket: 'day', firstSeen: { clients: null }, series: [point('2026-11-01', 200, 30, 27, 40, 90), point('2026-11-02', 100, 20, 18, 20, 60)],
      pages: [{ name: 'home', n: 300 }, { name: 'download', n: 120 }], ownReferrers: { download: 6, report: 1, site: 0, unsplit: 0 } };
    expect(helpers.funnelSteps(stats)).toEqual([['Home page views', 300, 'browsers'], ['Web uploads started', 50, '17 % of home page views'],
      ['Web uploads completed', 45, '90 % of started'], ['Downloads', 150, '2.5 per completed upload, any client'],
      ['Recipients who opened the site', 6, '5 % of download-page views']]);
    // A range that starts before uploads were counted by client (or page views at all) compares the days since then only.
    expect(helpers.funnelSteps({ ...stats, firstSeen: { pageViews: '2026-11-02', clients: null } })[0]).toEqual(['Home page views', 100, 'browsers']);
    const later = helpers.funnelSteps({ ...stats, firstSeen: { pageViews: '2026-10-30', clients: '2026-11-02' } });
    expect(later.map(([name, value]) => [name, value])).toEqual([['Home page views', 100], ['Web uploads started', 20], ['Web uploads completed', 18], ['Downloads', 60],
      ['Recipients who opened the site', 6]]);
    expect(later[4][2]).toBe('from a download page');
    for (const body of [null, {}, { series: [{}] }]) expect(() => helpers.funnelSteps(body)).not.toThrow();
  });

  it('counts the whole funnel and every list by client in a range of CLI uploads first, weeks after the release', () => {
    const now = Date.parse('2026-11-20T05:30:00Z'), hour = (index: number) => windowOf(1, now).buckets[index].key.replace('T', ' ') + ':00:00';
    const series = [{ t: hour(0), event: 'upload_completed', code: '', client: 'cli', language: '', n: '1', total: '1048576' },
      { t: hour(2), event: 'page_view', code: 'home', client: 'browser', language: 'de', n: '7', total: '7' },
      { t: hour(5), event: 'upload_started', code: 'browser', client: '', language: '', n: '1', total: '1' },
      { t: hour(5), event: 'upload_completed', code: '', client: 'browser', language: '', n: '1', total: '2048' }];
    const stats = shaped({ series }, '1d', now);
    expect(helpers.funnelSteps(stats).slice(0, 3).map(([name, value]) => [name, value])).toEqual([['Home page views', 7], ['Web uploads started', 1], ['Web uploads completed', 1]]);
    expect(helpers.since(stats, 'clients')).toBe('');
  });

  it('shows only the event groups with something to count, health groups with what a count means', () => {
    const groups = helpers.eventGroups({ passwords: { ok: 2 }, health: { partFailed: { n: 1, bytes: 1024 }, fallback: [] }, performance: { completionAvgMs: 220 } });
    const shown = groups.filter(group => group[3]).map(group => group[0]);
    expect(shown).toEqual(['Performance', 'Passwords', 'Part uploads']);
    expect(groups.find(group => group[0] === 'Part uploads')?.[2]).toMatch(/retry/);
    expect(groups.find(group => group[0] === 'Passwords')?.[1][0]).toEqual(['right (per request)', 2]);
    expect(groups.some(group => group[0] === 'Downloads' && group[1].some(([name]) => name === 'started'))).toBe(false);
    expect([300, 3600, 86400, 259200].map(helpers.duration)).toEqual(['5 min', '1 h', '1 day', '3 days']);
  });

  it('words the truncation notice per query that was cut', () => {
    expect(helpers.cutNotice(['referrers', 'campaigns'])).toBe('Analytics Engine hit the query limit: some lists were cut.');
    expect(helpers.cutNotice(['events', 'series'])).toBe('Analytics Engine hit the query limit: the totals and events may be low; the charts and the page-view total may be low.');
    expect([helpers.cutNotice([]), helpers.cutNotice(false)]).toEqual(['', '']);
  });

  it('prints readiness with the pause, E2EE and the report queue', () => {
    const body = { ready: true, checks: { r2: true }, paused: true, e2ee: 'off', turnstile: 'on', openReports: 2, oldestOpenReportAge: 3 * 3600 + 60,
      highestOpenPriority: 1, capacity: { storedPercent: 8, dailyPercent: 0 }, backlog: { overdueCleanups: 0 }, reasons: ['open_reports'] };
    const lines = helpers.readyLines(body);
    expect(lines).toContainEqual(['Uploads:   PAUSED (npm run admin -- resume)', true]);
    expect(lines).toContainEqual(['E2EE:      off', false]);
    expect(lines).toContainEqual(['Reports:   2 open · oldest 3 h 1 min · most urgent P1', true]);
    expect(helpers.readyLines({ ...body, paused: false, openReports: 0 })).toEqual(expect.arrayContaining([['Uploads:   accepted', false], ['Reports:   0 open', false]]));
    // A Worker that doesn't say leaves the line out rather than guessing.
    expect(helpers.readyLines({ ready: false }).map(([text]) => text.split(':')[0])).toEqual(['Ready', 'Capacity', 'Cleanups', 'Attention']);
  });

  it('sums up readiness, the last 24 hours and the live version in the status strip, and says where to look', () => {
    const ready = { ready: true, paused: false, e2ee: 'on', openReports: 0, backlog: { overdueCleanups: 0 }, version: { tag: 'v2.4.1', deployedAt: '2026-11-01T09:15:00.000Z' } };
    const quiet = { health: { partFailed: { n: 0 }, partLimit: 0, fallback: [], budgetDrift: [], cleanupOrphan: 0 }, cleanupRetry: [], misconfigured: 0 };
    const calm = helpers.statusParts(ready, quiet, { workerErrors: { requests: 4321, errors: 0, statuses: [] } });
    expect(calm.parts.map(([text]) => text).join(' · '))
      .toBe('Ready · Uploads accepted · E2EE on · 0 open reports · 0 overdue cleanups · No problems in 24 h · Live v2.4.1, deployed 1 Nov 10:15');
    expect([calm.urgent, calm.where]).toEqual([false, '#ops']);
    // An open report or a pause is the operator's to act on: amber, and readiness moves up.
    const reports = helpers.statusParts({ ...ready, openReports: 2, highestOpenPriority: 1 }, quiet, null);
    expect(reports.parts).toContainEqual(['2 open reports (most urgent P1)', true]);
    expect([reports.urgent, reports.readiness, reports.where]).toEqual([true, true, '#ops']);
    expect(helpers.statusParts({ ...ready, paused: true }, quiet, null).parts).toContainEqual(['Uploads PAUSED', true]);
    expect(helpers.statusParts({ ...ready, ready: false }, quiet, null).parts[0]).toEqual(['NOT READY', true]);
    // Counters of the last 24 hours, the Worker's errors among them, point at the events instead.
    const noisy = helpers.statusParts(ready, { ...quiet, health: { ...quiet.health, fallback: [{ name: 'part_release', n: 1 }] } }, { workerErrors: { requests: 9, errors: 2 } });
    expect(noisy.parts).toContainEqual(['3 problems in 24 h (fallbacks 1 · Worker errors 2)', true]);
    expect([noisy.urgent, noisy.readiness, noisy.where]).toEqual([true, false, '#events-heading']);
    // What failed to load is left out or said, never guessed.
    expect(helpers.statusParts(null, null, null)).toMatchObject({ parts: [['Readiness unknown', true]], urgent: true, where: '#ops' });
    expect(helpers.statusParts({ ready: true }, null, null).parts).toEqual([['Ready', false]]);
  });

  it('writes the decide command for real case ids and decisions only', () => {
    expect(helpers.command('R-7K3M9Q2XPA', 'quarantine')).toBe('npm run admin -- decide R-7K3M9Q2XPA quarantine --note "…"');
    expect(helpers.command('R-7K3M9Q2XPA; rm -rf ~', 'quarantine')).toBe('');
    expect(helpers.command('R-7K3M9Q2XPA', 'delete')).toBe('');
    expect([helpers.defaultAction({ fileAvailable: true }), helpers.defaultAction({ fileAvailable: false })]).toEqual(['quarantine', 'reject']);
  });
});
