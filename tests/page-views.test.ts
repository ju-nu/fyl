import { describe, expect, it } from 'vitest';
import { call, direct, file, pathOf, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.14.');

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Every major browser names a language with a navigation; a browser's name without one is a script.
const html = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': BROWSER, 'Sec-Fetch-Mode': 'navigate', 'Accept-Language': 'en-US,en;q=0.9' };
// The blobs after the event and the page kind, in order.
const FIELDS = ['referrer', 'utmSource', 'utmCampaign', 'country', 'device', 'client', 'language', 'reason'] as const;

/** A METRICS stand-in that keeps the data points written to it. */
function dataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } as unknown as AnalyticsEngineDataset };
}
const views = (points: AnalyticsEngineDataPoint[]) => points.filter(point => point.blobs?.[0] === 'page_view').map(point => {
  const blobs = (point.blobs || []) as string[];
  return { kind: blobs[1], ...Object.fromEntries(FIELDS.map((name, index) => [name, blobs[index + 2]])) } as Record<string, string>;
});
/** The page views one request counts. */
async function viewed(path: string, init: RequestInit = {}) {
  const metrics = dataset(), { response } = await direct(path, { METRICS: metrics.METRICS }, init);
  await response.arrayBuffer();
  return { status: response.status, views: views(metrics.points), points: metrics.points };
}

describe('page-view statistics', () => {
  it('counts the public pages a GET shows, by kind, and nothing else', async () => {
    // Each page in every language (/<lang>/…); / only picks one (302) and counts nothing, nor do the old addresses (301).
    for (const [path, kind] of [['/en/', 'home'], ['/de/', 'home'], ['/en/report', 'report'], ['/fr/privacy', 'privacy'], ['/en/?utm_source=x', 'home']] as const) {
      const { status, views: counted } = await viewed(path, { headers: html });
      expect([path, status, counted.map(view => view.kind)]).toEqual([path, 200, [kind]]);
    }
    for (const [path, init] of [['/en/', { method: 'HEAD', headers: html }], ['/', { headers: html }], ['/index.html', { headers: html }], ['/privacy', { headers: html }],
      ['/styles.css', { headers: html }], ['/nope', { headers: html }], ['/en/nope', { headers: html }], ['/en/download', { headers: html }],
      ['/api/health', {}], ['/config.js', {}], ['/admin', { headers: html }], ['/cli/latest', {}]] as const) {
      const { views: counted } = await viewed(path, init);
      expect([path, init.method, counted]).toEqual([path, init.method, []]);
    }
  });

  it('counts every visit: the pages carry their policy per response, so they have no ETag and never answer 304', async () => {
    const first = await direct('/en/', {}, { headers: html });
    await first.response.arrayBuffer();
    expect(first.response.headers.get('ETag')).toBeNull();
    const { status, views: counted } = await viewed('/en/', { headers: { ...html, 'If-None-Match': '"stale"' } });
    expect([status, counted.length]).toEqual([200, 1]);
  });

  it('counts the download page and the closed-link page, never the file, a HEAD or the unlock form, and never an id or a name', async () => {
    const { receipt } = await file(false, undefined, 'holiday-secret-plans.zip'), path = pathOf(receipt.url);
    const page = await viewed(path, { headers: html });
    expect(page.views.map(view => [view.kind, view.reason])).toEqual([['download', '']]);
    // A closed link's page says why it closed, and its view keeps that reason (never the id).
    const gone = await viewed('/d/' + 'Z'.repeat(43), { headers: html });
    expect([gone.status, gone.views.map(view => [view.kind, view.reason])]).toEqual([404, [['gone', 'missing']]]);
    const deleted = await file(false, undefined, 'removed-plans.zip');
    expect((await call('/api/transfers/' + deleted.receipt.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + deleted.session.key } })).status).toBe(200);
    const closed = await viewed(pathOf(deleted.receipt.url), { headers: html });
    expect(closed.views.map(view => [view.kind, view.reason])).toEqual([['gone', 'deleted']]);
    expect(JSON.stringify(closed.points)).not.toContain(deleted.receipt.id);
    const bot = await viewed(path, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', Accept: '*/*' } });
    expect(bot.views).toMatchObject([{ kind: 'download', client: 'bot', device: '' }]);
    for (const [init, label] of [[{ headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' } }, 'file'], [{ method: 'HEAD', headers: html }, 'head'],
      [{ headers: { ...html, Range: 'bytes=0-3' } }, 'range'], [{ method: 'POST', body: 'password=x', headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } }, 'unlock']] as const) {
      const { views: counted } = await viewed(path, init);
      expect([label, counted]).toEqual([label, []]);
    }
    for (const point of [...page.points, ...gone.points, ...bot.points].filter(entry => entry.blobs?.[0] === 'page_view')) {
      const text = JSON.stringify(point);
      expect(text).not.toContain(receipt.id);
      expect(text).not.toContain('holiday');
      expect(text).not.toContain('198.18.14');
      expect(text).not.toContain('Slackbot');
    }
  });

  it('keeps only coarse fields: referrer host, utm tags, country, device, client and language', async () => {
    const cases: [string, Record<string, string>, Partial<Record<(typeof FIELDS)[number], string>>][] = [
      ['/en/', { ...html }, { referrer: 'direct', utmSource: '', utmCampaign: '', country: '', device: 'desktop', client: 'browser', language: 'en' }],
      // A browser's User-Agent without a language (or with an empty one) is a script: no device, no language.
      ['/en/', { Accept: 'text/html', 'User-Agent': BROWSER, 'Sec-Fetch-Mode': 'navigate' }, { client: 'script', device: '', language: '' }],
      ['/en/', { ...html, 'Accept-Language': ' ' }, { client: 'script', device: '', language: '' }],
      ['/en/', { ...html, Referer: 'https://www.google.com/search?q=private+words', 'CF-IPCountry': 'at', 'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8' },
        { referrer: 'google.com', country: 'AT', language: 'de' }],
      // fyl.at's own pages by kind only: a download page (its recipients), the report form, any other page.
      ['/en/', { ...html, Referer: 'https://fyl.at/privacy' }, { referrer: 'fyl:site' }],
      ['/en/', { ...html, Referer: 'https://admin.fyl.at/' }, { referrer: 'fyl:site' }],
      ['/en/', { ...html, Referer: 'https://WWW.FYL.AT/' }, { referrer: 'fyl:site' }],
      ['/en/', { ...html, Referer: 'https://fyl.at/d/AbC123/x.zip' }, { referrer: 'fyl:download' }],
      ['/en/privacy', { ...html, Referer: 'https://fyl.at/d/AbC123#key' }, { referrer: 'fyl:download' }],
      ['/en/', { ...html, Referer: 'https://fyl.at/report?link=https://fyl.at/d/AbC123' }, { referrer: 'fyl:report' }],
      ['/en/', { ...html, Referer: 'https://share.example.com/d/AbC123/x.zip' }, { referrer: 'share.example.com' }],
      ['/en/', { ...html, Referer: 'android-app://com.slack/' }, { referrer: 'com.slack' }],
      ['/en/', { ...html, Referer: 'http://192.168.1.20:8080/intranet' }, { referrer: 'ip' }],
      ['/en/', { ...html, Referer: 'http://[2001:db8::1]/' }, { referrer: 'ip' }],
      ['/en/', { ...html, Referer: 'not a url' }, { referrer: 'other' }],
      ['/en/', { ...html, Referer: 'file:///Users/someone/page.html' }, { referrer: 'other' }],
      ['/en/', { ...html, Referer: `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example.com/` }, { referrer: `${'a'.repeat(60)}.${'b'.repeat(39)}` }],
      // A private network's machines and addresses written into names stay out, by class only.
      ['/en/', { ...html, Referer: 'http://ghost-rider/' }, { referrer: 'private' }], ['/en/', { ...html, Referer: 'http://localhost:3000/x' }, { referrer: 'private' }],
      ['/en/', { ...html, Referer: 'http://nas.local/' }, { referrer: 'private' }], ['/en/', { ...html, Referer: 'https://router.fritz.box/' }, { referrer: 'private' }],
      ['/en/', { ...html, Referer: 'https://wiki.corp/' }, { referrer: 'private' }], ['/en/', { ...html, Referer: 'http://192-168-1-5.nip.io/' }, { referrer: 'ip' }],
      ['/en/', { ...html, Referer: 'http://10.0.0.5.sslip.io/' }, { referrer: 'ip' }], ['/en/', { ...html, Referer: 'https://web2.0.example.com/' }, { referrer: 'web2.0.example.com' }],
      // Campaign tags: short plain names only; free text, addresses and ids become "other".
      [`/en/?utm_source=%20NewsLetter%20&utm_campaign=${'Ü'.repeat(50)}`, { ...html }, { utmSource: 'newsletter', utmCampaign: 'other' }],
      ['/en/?utm_source=%00%E2%80%AEa%0Ab', { ...html }, { utmSource: 'ab' }],
      ['/en/?utm_source=max%40example.com&utm_campaign=123e4567-e89b-12d3-a456-426614174000', { ...html }, { utmSource: 'other', utmCampaign: 'other' }],
      ['/en/?utm_source=Newsletter-Nov&utm_campaign=launch%20week', { ...html }, { utmSource: 'newsletter-nov', utmCampaign: 'launch-week' }],
      ['/en/?utm_campaign=sub_1234567', { ...html }, { utmCampaign: 'other' }], ['/en/?utm_campaign=deadbeefdeadbeef', { ...html }, { utmCampaign: 'other' }],
      ['/en/?utm_source=%EF%BC%A8%EF%BC%AE', { ...html }, { utmSource: 'hn' }], ['/en/?utm_source=%20', { ...html }, { utmSource: '' }],
      ['/en/', { ...html, 'CF-IPCountry': 'XX' }, { country: 'XX' }], ['/en/', { ...html, 'CF-IPCountry': 'T1' }, { country: 'T1' }],
      ['/en/', { ...html, 'CF-IPCountry': '<script>' }, { country: '' }],
      // A browser always keeps a language: three-letter subtags too, `und` when it names none.
      ['/en/', { ...html, 'Accept-Language': '*' }, { client: 'browser', language: 'und' }], ['/en/', { ...html, 'Accept-Language': 'fil-PH' }, { language: 'fil' }],
      ['/en/', { ...html, 'Accept-Language': 'x-klingon,en' }, { language: 'und' }],
      ['/en/', { ...html, 'Accept-Language': 'EN_us' }, { language: 'en' }],
      ['/en/', { ...html, 'Sec-CH-UA-Mobile': '?1' }, { device: 'mobile' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }, { device: 'mobile', client: 'browser' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }, { device: 'tablet' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }, { device: 'tablet' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (Linux; Android 9; CUBOT P30) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36' }, { device: 'mobile', client: 'browser' }],
      ['/en/', { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, { client: 'bot', device: '' }],
      // The language is a browser's only: a bot or a script sending Accept-Language keeps none.
      ['/en/', { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Accept-Language': 'en' }, { client: 'bot', language: '' }],
      ['/en/', { 'User-Agent': 'curl/8.5.0', 'Accept-Language': 'de-AT' }, { client: 'curl', language: '' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)' }, { client: 'bot' }],
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36' }, { client: 'bot' }],
      ['/en/', { Accept: '*/*', 'User-Agent': 'DuckDuckBot-Https/1.1; (+https://duckduckgo.com/duckduckbot)' }, { client: 'bot' }],
      ['/en/', { Accept: '*/*', 'User-Agent': 'WhatsApp/2.23.20.0 A' }, { client: 'bot' }],
      // An in-app browser naming its app is a browser when it navigates.
      ['/en/', { ...html, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Snapchat/13.10.0.40' }, { client: 'browser', device: 'mobile' }],
      ['/en/', { 'User-Agent': 'curl/8.5.0' }, { client: 'curl', device: '' }], ['/en/', { 'User-Agent': 'Wget/1.21.4' }, { client: 'wget' }],
      ['/en/', { 'User-Agent': 'fyl/2.3.0' }, { client: 'cli' }], ['/en/', { 'User-Agent': 'python-requests/2.32' }, { client: 'other', device: '' }], ['/en/', {}, { client: 'other' }],
    ];
    for (const [path, headers, expected] of cases) {
      const { views: counted } = await viewed(path, { headers });
      expect([path, headers, counted[0]]).toEqual([path, headers, expect.objectContaining(expected)]);
    }
  });

  it('names a visit from a download page or the report form by kind, never the link, the file or the case', async () => {
    const { points } = await viewed('/en/', { headers: { ...html, Referer: 'https://fyl.at/d/AbC123/x.zip?dl=1' } });
    const text = JSON.stringify(points);
    expect(views(points)).toMatchObject([{ referrer: 'fyl:download' }]);
    for (const part of ['AbC123', 'x.zip', 'dl=1', '/d/']) expect(text).not.toContain(part);
    // On the report host, the form's own reloads come from fyl:report; fyl.at's pages from fyl:site.
    for (const [referrer, expected] of [['https://report.fyl.at/?link=https%3A%2F%2Ffyl.at%2Fd%2FAbC123', 'fyl:report'], ['https://fyl.at/', 'fyl:site'],
      ['https://fyl.at/d/AbC123', 'fyl:download']] as const) {
      const metrics = dataset(), { response } = await direct('https://report.fyl.at/en/', { METRICS: metrics.METRICS, REPORT_HOST: 'report.fyl.at' }, { headers: { ...html, Referer: referrer } });
      await response.arrayBuffer();
      expect([referrer, response.status, views(metrics.points)]).toEqual([referrer, 200, [expect.objectContaining({ kind: 'report', referrer: expected })]]);
      expect(JSON.stringify(metrics.points)).not.toContain('AbC123');
    }
  });

  it("never counts fyl's own tools or the operator's checks marked fyl-ops, and still counts the CLI", async () => {
    for (const agent of ['fyl-smoke/2.4.0', 'fyl-smoke', 'fyl-monitor', 'fyl-admin', 'fyl-ops', 'curl/8.5 fyl-ops', `${BROWSER} fyl-ops`,
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36 fyl-ops']) {
      const { status, views: counted } = await viewed('/en/', { headers: { ...html, 'User-Agent': agent } });
      expect([agent, status, counted]).toEqual([agent, 200, []]);
    }
    for (const agent of ['fyl-cli/2.4.0', 'fyl/2.3.0']) expect((await viewed('/en/', { headers: { 'User-Agent': agent } })).views).toMatchObject([{ client: 'cli' }]);
    // Only a marker of its own: a name that merely contains the letters stays what it is.
    expect((await viewed('/en/', { headers: { ...html, 'User-Agent': `${BROWSER} notfyl-opsx` } })).views).toMatchObject([{ client: 'browser' }]);
  });

  it('stays within Analytics Engine limits whatever a visitor sends', async () => {
    const long = '\u{10348}'.repeat(500);
    const { points } = await viewed(`/en/?utm_source=${encodeURIComponent(long)}&utm_campaign=${encodeURIComponent(long)}`, {
      headers: { ...html, Referer: `https://${'x'.repeat(63)}.${'y'.repeat(63)}.${'z'.repeat(63)}.example/${'p'.repeat(4000)}`, 'Accept-Language': 'a'.repeat(4000), 'CF-IPCountry': 'Z'.repeat(100) },
    });
    const point = points.find(entry => entry.blobs?.[0] === 'page_view');
    const blobs = (point?.blobs || []) as string[];
    expect(blobs).toHaveLength(10);
    expect(point?.indexes).toEqual(['page_view']);
    expect(point?.doubles).toEqual([1]);
    expect(blobs.reduce((total, blob) => total + new TextEncoder().encode(blob).length, 0)).toBeLessThanOrEqual(512);
  });
});
