import { describe, expect, it } from 'vitest';
import { PREVIEW_BYTES } from '../src/shared';
import { call, direct, file, finish, init, operator, pageOf, part, pathOf, post, record, edit, useNetworkPrefix, type Receipt } from './helpers';

useNetworkPrefix('198.18.11.');

// Hotlink protection and chat link previews (contract §14.3 and §14.5).
const PASSWORD = 'tide-lamp-41';
const HOTLINK = { error: "fyl.at files can't be embedded on other sites. Open the link instead.", code: 'hotlink' };
const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
const SITES = [undefined, 'none', 'same-origin', 'same-site', 'cross-site'] as const;
const DESTS = [undefined, 'document', 'iframe', 'frame', 'image', 'video', 'audio', 'track', 'embed', 'object', 'script', 'style', 'font', 'empty', 'worker', 'manifest'] as const;
type Site = typeof SITES[number];
type Dest = typeof DESTS[number];
/** What a browser sends for a request of this kind, or nothing (curl, wget, the CLI) without them. */
const accept = (dest: Dest) => dest === 'document' || dest === 'iframe' || dest === 'frame' ? html : dest === 'image' ? 'image/avif,image/webp,*/*;q=0.8' : '*/*';
const browser = (site: Site, dest: Dest): Record<string, string> =>
  ({ Accept: accept(dest), ...(site ? { 'Sec-Fetch-Site': site } : {}), ...(dest ? { 'Sec-Fetch-Dest': dest } : {}) });
/**
 * What /d/ answers: another site's page may navigate to a link but load it as nothing else (403 hotlink), and its
 * navigation to the file itself (?dl=1, a grant) opens the page; everything else as before hotlink protection.
 */
function expected(method: 'GET' | 'HEAD', query: string, site: Site, dest: Dest) {
  const foreign = site === 'cross-site' || site === 'same-site';
  if (foreign && dest !== 'document') return 'hotlink';
  if (method === 'GET' && !query && accept(dest).includes('text/html')) return 'page';
  return foreign && query ? 'page' : 'file';
}
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

/** Uploads `content` as `name`; a one-time or protected file with the options. */
async function upload(name: string, content: Uint8Array, options: { once?: boolean; password?: string } = {}) {
  const session = await init(content.length, options.once ?? false, name, options.password);
  const receipt = await finish(session, [await part(session, content)]);
  return { session, receipt, content, path: pathOf(receipt.url) };
}
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
const image = (...head: (number | string)[]) => {
  const start = head.flatMap(value => typeof value === 'string' ? ascii(value) : [value]);
  return Uint8Array.from([...start, ...Array.from({ length: 200 }, (_, index) => index % 251)]);
};
const PNG = image(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR');
const JPEG = image(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF');
const GIF = image('GIF89a');
const WEBP = image('RIFF', 0xd0, 0, 0, 0, 'WEBPVP8 ');
const AVIF = image(0, 0, 0, 0x1c, 'ftyp', 'avif', 0, 0, 0, 0, 'avif', 'mif1', 'miaf');
const AVIF_COMPATIBLE = image(0, 0, 0, 0x1c, 'ftyp', 'mif1', 0, 0, 0, 0, 'mif1', 'miaf', 'avif');
const HEIC = image(0, 0, 0, 0x18, 'ftyp', 'heic', 0, 0, 0, 0, 'mif1', 'heic');
const ZIP = image('PK', 3, 4, 20, 0);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const BOTS = ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'WhatsApp/2.23.20.0 A', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'];
const bot = (agent = BOTS[0]) => ({ 'User-Agent': agent, Accept: '*/*' });
const preview = (path: string, headers: Record<string, string> = bot(), method = 'GET') => call(path + '?preview=1', { method, headers });
/** The Open Graph and Twitter tags of a page, by name; each name must appear once. */
function tagsOf(page: string) {
  const head = page.slice(0, page.indexOf('</head>')), tags: Record<string, string> = {};
  for (const [, name, content] of head.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)">/g)) {
    expect(tags, name).not.toHaveProperty(name);
    tags[name] = content.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  }
  expect(head.match(/<meta (?:property|name)="(?:og|twitter):/g)?.length ?? 0).toBe(Object.keys(tags).length);
  return tags;
}
const generic = (title: string, description: string) => ({ 'og:site_name': 'fyl.at', 'og:type': 'website', 'og:locale': 'en_GB', 'og:title': title, 'og:description': description, 'twitter:card': 'summary' });

describe('hotlink protection', () => {
  it('answers every combination of Sec-Fetch-Site and Sec-Fetch-Dest, for GET and HEAD, on the link and the file', async () => {
    const { receipt, session, payload } = await file(), path = pathOf(receipt.url);
    let downloads = 0;
    for (const method of ['GET', 'HEAD'] as const) for (const query of ['', '?dl=1', '?grant=1.' + 'g'.repeat(43)]) for (const site of SITES) for (const dest of DESTS) {
      const response = await call(path + query, { method, headers: browser(site, dest) }), outcome = expected(method, query, site, dest);
      const label = `${method} ${query || 'link'} site=${site} dest=${dest}: ${outcome}`;
      if (outcome === 'hotlink') {
        expect(response.status, label).toBe(403);
        if (method === 'GET') expect(await response.json(), label).toEqual(HOTLINK); else await response.text();
      } else if (outcome === 'page') {
        expect([response.status, response.headers.get('Content-Type')?.split(';')[0]], label).toEqual([200, 'text/html']);
        if (method === 'GET') expect((await pageOf(response)).data, label).toMatchObject({ state: 'ready', downloadUrl: receipt.url + '?dl=1' });
        else expect(await response.text(), label).toBe('');
      } else {
        expect([response.status, response.headers.get('Content-Disposition')?.split(';')[0]], label).toEqual([200, 'attachment']);
        // No other site can embed a file or read it with a no-cors fetch.
        expect(response.headers.get('Cross-Origin-Resource-Policy'), label).toBe('same-origin');
        if (method === 'GET') { expect(await bytes(response), label).toEqual(payload); downloads++; } else await response.text();
      }
    }
    // Every file response counted once, a refused request or a page nothing: the 3 sites that aren't another site's, with the
    // 13 destinations that don't ask for HTML on the link, and all 16 with ?dl=1 or a grant.
    expect(downloads).toBe(3 * (13 + 2 * 16));
    expect((await record(session.uploadId)).downloads).toBe(downloads);
    const range = await call(path, { headers: { Range: 'bytes=0-3', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' } });
    expect([range.status, range.headers.get('Cross-Origin-Resource-Policy')]).toEqual([206, 'same-origin']);
    expect(await bytes(range)).toEqual(payload.slice(0, 4));
    expect((await call(path, { headers: { Range: 'bytes=0-3', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'video' } })).status).toBe(403);
  });

  it('opens no one-time session for another site, and lets the page download what its link posted elsewhere pointed to', async () => {
    const { receipt, session, payload } = await file(true), path = pathOf(receipt.url);
    for (const query of ['', '?dl=1']) for (const method of ['GET', 'HEAD']) for (const dest of ['image', 'video', 'empty', 'iframe'] as const) {
      const embedded = await call(path + query, { method, headers: browser('cross-site', dest) });
      expect(embedded.status).toBe(403);
      await embedded.text();
    }
    const navigate = (site: Site) => ({ ...browser(site, 'document'), 'Sec-Fetch-Mode': 'navigate' });
    for (const site of ['cross-site', 'same-site'] as const) {
      const opened = await call(path + '?dl=1', { headers: navigate(site) });
      expect((await pageOf(opened)).data).toMatchObject({ state: 'ready', once: true, downloadUrl: receipt.url + '?dl=1' });
    }
    expect(await record(session.uploadId)).toMatchObject({ downloads: 0 });
    expect(await record(session.uploadId)).not.toHaveProperty('session');
    // The page's own button (same-origin) downloads it.
    const download = await call(path + '?dl=1', { headers: navigate('same-origin') });
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await bytes(download)).toEqual(payload);
  });

  it('opens the password page for a grant link posted elsewhere, while fyl.at, bookmarks and download tools still use it', async () => {
    const { receipt, payload } = await file(false, PASSWORD), path = pathOf(receipt.url);
    const form = (headers: Record<string, string>) => call(path, { method: 'POST', body: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { Accept: html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at', ...headers } });
    const { downloadUrl } = (await pageOf(await form({ 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' }))).data;
    expect(downloadUrl).toMatch(/\?grant=/);
    const granted = pathOf(String(downloadUrl)) + new URL(String(downloadUrl)).search;
    const opened = await call(granted, { headers: browser('cross-site', 'document') });
    expect((await pageOf(opened)).data).toMatchObject({ state: 'protected', name: null, downloadUrl: null });
    const head = await call(granted, { method: 'HEAD', headers: browser('same-site', 'document') });
    expect([head.status, head.headers.get('Content-Type')?.split(';')[0], await head.text()]).toEqual([200, 'text/html', '']);
    for (const dest of ['image', 'empty', 'iframe'] as const) {
      const embedded = await call(granted, { headers: browser('cross-site', dest) });
      expect([embedded.status, await embedded.json()]).toEqual([403, HOTLINK]);
    }
    for (const headers of [browser('same-origin', 'document'), browser('none', 'document'), { 'User-Agent': 'curl/8.5.0' }]) {
      const download = await call(granted, { headers });
      expect(download.headers.get('Content-Disposition')).toContain('attachment');
      expect(await bytes(download)).toEqual(payload);
    }
    // Another site's script can't post the password form, nor can its page.
    const scripted = await form({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty' });
    expect([scripted.status, await scripted.json()]).toEqual([403, HOTLINK]);
    const posted = await form({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document', Origin: 'https://evil.example' });
    expect(posted.status).toBe(403);
    await posted.text();
  });
});

describe('chat link previews', () => {
  it('gives a shown file Open Graph tags with its name, size, type and expiry, and an image its picture', async () => {
    const picture = await upload('holiday.png', PNG);
    const page = await call(picture.path, { headers: { Accept: html } });
    const { html: markup, data } = await pageOf(page);
    expect(data).toMatchObject({ state: 'ready', name: 'holiday.png', size: PNG.length, downloadUrl: picture.receipt.url + '?dl=1' });
    expect(tagsOf(markup)).toEqual({
      'og:site_name': 'fyl.at', 'og:type': 'website', 'og:locale': 'en_GB', 'og:title': 'holiday.png', 'og:description': `${PNG.length}\u00a0bytes · PNG image · expires in 24 hours`,
      'og:url': picture.receipt.url, 'og:image': picture.receipt.url + '?preview=1', 'og:image:type': 'image/png', 'og:image:alt': 'holiday.png',
      'twitter:card': 'summary_large_image',
    });
    // Bots get the same page.
    for (const agent of BOTS) expect(tagsOf((await pageOf(await call(picture.path, { headers: bot(agent) }))).html)['og:image'], agent).toBe(picture.receipt.url + '?preview=1');
    // Other files get no picture; the relative expiry follows the lifetime; a name's markup stays text.
    const archive = await upload('a "quoted" <b>&\'x\'.zip', new Uint8Array(3000));
    const change = (receipt: Receipt, expiresIn: number) => call(`/api/transfers/${receipt.id}`, { method: 'PATCH', body: JSON.stringify({ expiresIn }),
      headers: { Authorization: 'Bearer ' + receipt.deleteToken, 'Content-Type': 'application/json' } }).then(response => response.text());
    for (const [expiresIn, when] of [[600, '10 minutes'], [86400 * 3, '3 days'], [604800, '7 days']] as const) {
      await change(archive.receipt, expiresIn);
      const { html: text } = await pageOf(await call(archive.path, { headers: { Accept: html } }));
      expect(text.slice(0, text.indexOf('</head>'))).not.toContain('<b>');
      expect(tagsOf(text)).toEqual({ 'og:site_name': 'fyl.at', 'og:type': 'website', 'og:locale': 'en_GB', 'og:title': 'a "quoted" <b>&\'x\'.zip',
        'og:description': `2.9\u00a0KB · ZIP archive · expires in ${when}`, 'og:url': archive.receipt.url, 'twitter:card': 'summary' });
    }
    // Still uploading: no expiry yet, and no picture.
    const early = await init(PREVIEW_BYTES, false, 'later.png');
    expect(tagsOf((await pageOf(await call(`/d/${early.uploadId}`, { headers: { Accept: html } }))).html)).toEqual({ 'og:site_name': 'fyl.at', 'og:type': 'website', 'og:locale': 'en_GB',
      'og:title': 'later.png', 'og:description': '8.0\u00a0MB · PNG image · still uploading', 'og:url': early.url, 'twitter:card': 'summary' });
    expect((await post('/api/upload/abort', early)).status).toBe(200);
    // A one-time link shows its name, but never a picture.
    const once = await upload('once.png', PNG, { once: true });
    expect(tagsOf((await pageOf(await call(once.path, { headers: { Accept: html } }))).html)).toMatchObject({ 'og:title': 'once.png', 'twitter:card': 'summary' });
    expect(tagsOf((await pageOf(await call(once.path, { headers: { Accept: html } }))).html)).not.toHaveProperty('og:image');
  });

  it('keeps generic text for protected, quarantined and gone links', async () => {
    const locked = await upload('secret-plan.png', PNG, { password: PASSWORD });
    const lockedTags = { ...generic('A protected file on fyl.at', 'A password-protected file shared with you on fyl.at.'), 'og:url': locked.receipt.url };
    const shown = await pageOf(await call(locked.path, { headers: { Accept: html } }));
    expect(tagsOf(shown.html)).toEqual(lockedTags);
    // Unlocked as well: the page shows the name now, the tags still don't.
    const unlocked = await pageOf(await call(locked.path, { method: 'POST', body: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { Accept: html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } }));
    expect(unlocked.data).toMatchObject({ state: 'unlocked', name: 'secret-plan.png' });
    expect(tagsOf(unlocked.html)).toEqual(lockedTags);
    for (const page of [shown.html, unlocked.html]) expect(page.slice(0, page.indexOf('</head>')).replace(/<script type="application\/json" id="fyl-state">.*?<\/script>/s, '')).not.toContain('secret-plan');
    const goneTags = generic('fyl.at — Fyl for now.', 'A file shared with you on fyl.at, temporary file sharing.');
    const reviewed = await upload('reviewed.png', PNG);
    expect((await operator('/api/admin/quarantine', { method: 'POST', body: JSON.stringify({ id: reviewed.receipt.id, note: 'report under review' }) })).status).toBe(200);
    const quarantined = await call(reviewed.path, { headers: { Accept: html } });
    expect(quarantined.status).toBe(403);
    const { html: hidden, data } = await pageOf(quarantined);
    expect(data).toMatchObject({ state: 'gone', reason: 'quarantined' });
    expect(tagsOf(hidden)).toEqual(goneTags);
    const deleted = await upload('deleted.png', PNG);
    await call(`/api/transfers/${deleted.receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + deleted.receipt.deleteToken } }).then(response => response.text());
    expect(tagsOf((await pageOf(await call(deleted.path, { headers: { Accept: html } }))).html)).toEqual(goneTags);
  });

  it("replaces preview tags the page itself may carry, so a chat app finds only this link's", async () => {
    const picture = await upload('own-tags.png', PNG);
    const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta property="og:title" content="fyl.at"><meta property="og:image" content="/static.png">'
      + '<meta name="twitter:card" content="summary"><meta name="description" content="kept"></head><body><a id="download" href="#">Download</a></body></html>';
    const assets = { fetch: async () => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) } as unknown as Fetcher;
    const { response } = await direct(picture.path, { ASSETS: assets }, { headers: { Accept: html } });
    const { html: text } = await pageOf(response);
    expect(tagsOf(text)).toMatchObject({ 'og:title': 'own-tags.png', 'og:image': picture.receipt.url + '?preview=1', 'twitter:card': 'summary_large_image' });
    expect(text).toContain('<meta name="description" content="kept">');
    expect(text).not.toContain('/static.png');
  });

  it('serves the picture to link-preview bots only: sniffed, inline, for at most 5 minutes, without counting a download', async () => {
    const picture = await upload('holiday.png', PNG);
    for (const agent of BOTS) {
      const response = await preview(picture.path, bot(agent));
      expect(response.status, agent).toBe(200);
      expect(Object.fromEntries(['Content-Type', 'Content-Length', 'Content-Disposition', 'X-Content-Type-Options', 'Content-Security-Policy', 'Cache-Control', 'Vary',
        'Cross-Origin-Resource-Policy'].map(name => [name, response.headers.get(name)]))).toEqual({
        'Content-Type': 'image/png', 'Content-Length': String(PNG.length), 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'public, max-age=300', Vary: 'User-Agent', 'Cross-Origin-Resource-Policy': 'same-origin',
      });
      expect(await bytes(response)).toEqual(PNG);
    }
    const head = await preview(picture.path, bot(), 'HEAD');
    expect([head.status, head.headers.get('Content-Type'), await head.text()]).toEqual([200, 'image/png', '']);
    expect(await record(picture.session.uploadId)).toMatchObject({ downloads: 0 });
    // A browser opening the preview address (in-app ones naming a bot's app too) gets the download page like any link.
    for (const headers of [{ 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0', Accept: html, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
      { 'User-Agent': 'Mozilla/5.0 (iPhone) Mobile WhatsApp/2.23', Accept: html, 'Sec-Fetch-Mode': 'navigate' }] as Record<string, string>[]) {
      const page = await preview(picture.path, headers);
      expect([page.status, page.headers.get('Content-Type')?.split(';')[0]], JSON.stringify(headers)).toEqual([200, 'text/html']);
      expect((await pageOf(page)).data).toMatchObject({ state: 'ready', name: 'holiday.png' });
    }
    // Images the page loads, download tools and the CLI get 404, from this site and any other.
    for (const headers of [{ 'User-Agent': 'Mozilla/5.0', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' },
      { 'User-Agent': 'curl/8.5.0', Accept: '*/*' }, { 'User-Agent': 'Wget/1.21.4' }, { 'User-Agent': 'fyl-cli/1.0.1' }, {}] as Record<string, string>[]) {
      const refused = await preview(picture.path, headers);
      expect([refused.status, (await refused.json<{ code: string }>()).code], JSON.stringify(headers)).toEqual([404, 'not_found']);
    }
    // Another site's page can't load it either, whatever User-Agent it claims.
    const embedded = await preview(picture.path, { ...bot(), 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'image' });
    expect([embedded.status, await embedded.json()]).toEqual([403, HOTLINK]);
    expect(await record(picture.session.uploadId)).toMatchObject({ downloads: 0 });
    // Never cached past the expiry.
    await edit(picture.session.uploadId, stored => { stored.expiresAt = Date.now() + 100000; });
    const soon = await preview(picture.path);
    expect(Number(/max-age=(\d+)/.exec(soon.headers.get('Cache-Control') || '')?.[1])).toBeLessThanOrEqual(100);
    await soon.arrayBuffer();
    // Counted as preview_served with the type, never an id or a name; DOWNLOAD_RATE applies.
    const points: AnalyticsEngineDataPoint[] = [];
    const counted = await direct(picture.path + '?preview=1', { METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } } }, { headers: bot() });
    expect(counted.response.status).toBe(200);
    await counted.response.arrayBuffer();
    expect(points).toEqual([{ indexes: ['preview_served'], blobs: ['preview_served', 'png'], doubles: [PNG.length] }]);
    const limited = await direct(picture.path + '?preview=1', { DOWNLOAD_RATE: { limit: async () => ({ success: false }) } as unknown as RateLimit }, { headers: bot() });
    expect(limited.response.status).toBe(429);
    await limited.response.text();
  });

  it('serves each image type as its first bytes prove it, never SVG and never a file whose bytes are no image', async () => {
    const served: [string, Uint8Array, string][] = [['a.png', PNG, 'image/png'], ['b.jpg', JPEG, 'image/jpeg'], ['c.JPEG', JPEG, 'image/jpeg'], ['d.gif', GIF, 'image/gif'],
      ['e.gif', image('GIF87a'), 'image/gif'], ['f.webp', WEBP, 'image/webp'], ['g.avif', AVIF, 'image/avif'], ['h.avif', AVIF_COMPATIBLE, 'image/avif'],
      // Named as another image type: served as what its bytes are.
      ['i.jpg', PNG, 'image/png']];
    for (const [name, content, type] of served) {
      const { path } = await upload(name, content), response = await preview(path);
      expect([response.status, response.headers.get('Content-Type')], name).toEqual([200, type]);
      expect(await bytes(response)).toEqual(content);
    }
    // Slack fetches the picture through its image proxy.
    const slack = await preview((await upload('slack.png', PNG)).path, bot('Slack-ImgProxy (+https://api.slack.com/robots)'));
    expect([slack.status, slack.headers.get('Content-Type')]).toEqual([200, 'image/png']);
    await slack.arrayBuffer();
    // An ftyp box claiming to be huge, with 'avif' only near the end of the file: GET and HEAD both refuse it, without
    // scanning the whole file.
    const sprawling = Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...ascii('ftyp'), ...ascii('<html><script>alert(1)</script>'), ...Array<number>(300).fill(32), ...ascii('avif'), 0, 0, 0, 0]);
    // A renamed archive, SVG in any name, HEIC posing as AVIF, a real image with a name that isn't one: no preview, and no og:image.
    for (const [name, content] of [['archive.png', ZIP], ['drawing.svg', SVG], ['drawing.png', SVG], ['photo.avif', HEIC], ['sprawling.avif', sprawling], ['photo.txt', JPEG], ['photo', PNG]] as const) {
      const { path } = await upload(name, content);
      for (const method of ['GET', 'HEAD']) {
        const refused = await preview(path, bot(), method);
        expect(refused.status, `${method} ${name}`).toBe(404);
        await refused.text();
      }
      if (!/\.(png|avif)$/.test(name)) expect(tagsOf((await pageOf(await call(path, { headers: { Accept: html } }))).html), name).not.toHaveProperty('og:image');
    }
  });

  it('never previews a one-time, protected, unfinished, quarantined, gone or too large file, nor an unknown link', async () => {
    const refused = async (path: string, label: string) => {
      const response = await preview(path);
      expect([response.status, (await response.json<{ code: string }>()).code], label).toEqual([404, 'not_found']);
    };
    const once = await upload('once.png', PNG, { once: true });
    await refused(once.path, 'one-time');
    expect(await record(once.session.uploadId)).not.toHaveProperty('session');
    const locked = await upload('locked.png', PNG, { password: PASSWORD });
    await refused(locked.path, 'protected');
    const early = await init(PNG.length, false, 'early.png');
    await part(early, PNG);
    await refused(`/d/${early.uploadId}/early.png`, 'still uploading');
    const reviewed = await upload('reviewed.png', PNG);
    expect((await operator('/api/admin/quarantine', { method: 'POST', body: JSON.stringify({ id: reviewed.receipt.id, note: 'report under review' }) })).status).toBe(200);
    await refused(reviewed.path, 'quarantined');
    const deleted = await upload('deleted.png', PNG);
    await call(`/api/transfers/${deleted.receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + deleted.receipt.deleteToken } }).then(response => response.text());
    await refused(deleted.path, 'deleted');
    // Closed before its cleanup ran (the name still stored), or past its expiry before its alarm: no preview either.
    const closing = await upload('closing.png', PNG);
    await edit(closing.session.uploadId, stored => { stored.status = 'consumed'; });
    await refused(closing.path, 'closed, not cleaned yet');
    const lapsed = await upload('lapsed.png', PNG);
    await edit(lapsed.session.uploadId, stored => { stored.expiresAt = Date.now() - 1; });
    await refused(lapsed.path, 'expired, alarm not run yet');
    await refused(`/d/${'x'.repeat(43)}/missing.png`, 'unknown');
    // PREVIEW_BYTES exactly is shown; a byte more is not, and its page names no picture.
    const largest = new Uint8Array(PREVIEW_BYTES);
    largest.set(PNG);
    const fits = await upload('largest.png', largest);
    const response = await preview(fits.path);
    expect([response.status, Number(response.headers.get('Content-Length'))]).toEqual([200, PREVIEW_BYTES]);
    expect((await bytes(response)).length).toBe(PREVIEW_BYTES);
    expect(tagsOf((await pageOf(await call(fits.path, { headers: { Accept: html } }))).html)).toHaveProperty('og:image');
    const larger = new Uint8Array(PREVIEW_BYTES + 1);
    larger.set(PNG);
    const big = await upload('larger.png', larger);
    await refused(big.path, 'too large');
    expect(tagsOf((await pageOf(await call(big.path, { headers: { Accept: html } }))).html)).not.toHaveProperty('og:image');
    // Nothing counted a download or opened a session; the one-time link still downloads whole for its first client.
    for (const { session } of [fits, big]) expect(await record(session.uploadId)).toMatchObject({ downloads: 0 });
    const download = await call(once.path, { headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' } });
    expect(await bytes(download)).toEqual(PNG);
  });
});
