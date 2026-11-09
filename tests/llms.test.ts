import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/i18n';
import { direct, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.17.');

// /llms.txt (llmstxt.org) tells agents how to use fyl.at. It is a static file, served as Markdown, and must stay true to
// what the site and the CLI do. The only repository it names is the public one with fyl's source.
describe('llms.txt', () => {
  it('is served as Markdown with a title, a summary and the sections agents need', async () => {
    const { response } = await direct('/llms.txt', {});
    const text = await response.text();
    expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'text/markdown; charset=utf-8']);
    expect(text.startsWith('# fyl.at\n\n> ')).toBe(true);
    for (const heading of ['## Install the CLI', '## Upload', '## Download', '## Delete', '## Limits and errors', '## Rules', '## Optional'])
      expect(text).toContain('\n' + heading + '\n');
    expect(text).toContain('curl -fsSL https://fyl.at/cli/install | sh');
    // GitHub only as the public repository and its releases, nothing else there (no other repository, no raw files).
    const github = [...text.matchAll(/github[^\s)]*/gi)].map(match => match[0]);
    expect(github.length).toBeGreaterThan(0);
    for (const mention of github) expect(['github.com/ju-nu/fyl', 'github.com/ju-nu/fyl/releases']).toContain(mention);
  });

  it('is announced to agents: a footer link, a describedby link in every page, and Link headers on every page', async () => {
    const LINKS = '<https://fyl.at/llms.txt>; rel="describedby"; type="text/markdown", <https://fyl.at/llms.txt>; rel="alternate"; type="text/markdown"';
    for (const path of ['/en/', '/de/', '/en/privacy', '/fr/download', '/d/' + 'Z'.repeat(43)]) {
      const { response } = await direct(path, {}, { headers: { Accept: 'text/html' } });
      const html = await response.text();
      if (!path.startsWith('/d/')) expect([path, html.includes('<link rel="describedby" type="text/markdown" href="/llms.txt"'), html.includes('<a href="/llms.txt"')]).toEqual([path, true, true]);
      expect([path, response.headers.get('Link')]).toEqual([path, LINKS]);
    }
    // The language switch at / names it too, for agents that never follow the redirect.
    expect((await direct('/', {}, { headers: { Accept: 'text/html' }, redirect: 'manual' })).response.headers.get('Link')).toBe(LINKS);
  });

  it('is what / answers to an agent: llms.txt itself unless the request asks for HTML first', async () => {
    const manual = await (await direct('/llms.txt', {})).response.text();
    for (const accept of [null, '*/*', 'text/plain', 'text/markdown, text/html;q=0.9', 'text/plain, text/html;q=0.5', 'application/json']) {
      const { response } = await direct('/', {}, { headers: accept === null ? {} : { Accept: accept }, redirect: 'manual' });
      expect([accept, response.status, response.headers.get('Content-Type'), response.headers.get('Vary')]).toEqual([accept, 200, 'text/markdown; charset=utf-8', 'Accept, Accept-Language']);
      expect(await response.text()).toBe(manual);
    }
    // Browsers, and crawlers and link-preview bots whatever they accept, get the language switch.
    for (const [accept, agent] of [['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Mozilla/5.0'], ['text/html;q=0.9, text/plain;q=0.9', 'Mozilla/5.0'],
      ['application/xhtml+xml', 'Mozilla/5.0'], ['*/*', 'Mozilla/5.0 (compatible; bingbot/2.0)'], ['*/*', 'facebookexternalhit/1.1'], ['*/*', 'Googlebot/2.1']] as const) {
      const { response } = await direct('/', {}, { headers: { Accept: accept, 'User-Agent': agent }, redirect: 'manual' });
      expect([accept, agent, response.status]).toEqual([accept, agent, 302]);
    }
    expect((await direct('/', {}, { method: 'HEAD', headers: { Accept: '*/*' }, redirect: 'manual' })).response.status).toBe(200);
  });

  it('names only options the CLI has and pages that exist', async () => {
    const text = await (await direct('/llms.txt', {})).response.text();
    const install = await (await direct('/cli/install', {})).response.text();
    expect(install).toContain('/usr/local/bin');
    // CLI options, plus the curl and jq flags of the curl-only recipe.
    for (const option of text.match(/--[a-z]+/g) || []) expect(['--expires', '--once', '--password', '--encrypt', '--manage', '--json', '--resume', '--help', '--version', '--check', '--retry', '--data', '--arg', '--argjson']).toContain(option);
    for (const path of ['/en/privacy', '/cli/latest']) expect((await direct(path, { REPORT_HOST: '' } as unknown as Partial<Env>)).response.status, path).toBe(200);
  });
});

// The source is public: every page's footer links the repository, and the privacy page also its releases, whose
// checksums say what a release holds. No page names any other GitHub address.
describe('the public source', () => {
  it('is linked from every page\'s footer in every language, and from the privacy page with its releases', async () => {
    for (const code of LOCALES) for (const page of ['/', '/privacy', '/report', '/download']) {
      const path = `/${code}${page}`, html = await (await direct(path, { REPORT_HOST: '' } as unknown as Partial<Env>, { headers: { Accept: 'text/html' } })).response.text();
      const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
      expect([path, (footer.match(/href="https:\/\/github\.com\/ju-nu\/fyl"/g) || []).length]).toEqual([path, 1]);
      const github = [...html.matchAll(/https?:\/\/(?:www\.)?github\.com[^"'\s<)]*/g)].map(match => match[0]);
      expect([path, github.every(url => ['https://github.com/ju-nu/fyl', 'https://github.com/ju-nu/fyl/releases'].includes(url))]).toEqual([path, true]);
      if (page === '/privacy') expect([path, html.includes('href="https://github.com/ju-nu/fyl/releases"')]).toEqual([path, true]);
    }
  });
});

// robots.txt points crawlers and agents to llms.txt and the sitemap, keeps them out of the API, the CLI's binaries and
// the service worker, and leaves /d/ crawlable so the download pages' noindex header is seen.
describe('robots.txt and sitemap.xml', () => {
  it('names llms.txt and the sitemap, blocks only what is no page, and keeps /d/ crawlable', async () => {
    const { response } = await direct('/robots.txt', {});
    const text = await response.text();
    expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'text/plain; charset=utf-8']);
    expect(text).toContain('https://fyl.at/llms.txt');
    expect(text).toContain('\nSitemap: https://fyl.at/sitemap.xml\n');
    const disallowed = [...text.matchAll(/^Disallow: (.+)$/gm)].map(match => match[1]);
    expect(disallowed).toEqual(['/api/', '/cli/', '/_dl/']);
  });

  it('serves security.txt (RFC 9116) as plain text, with a contact, a future expiry and its canonical address', async () => {
    const { response } = await direct('/.well-known/security.txt', {});
    const text = await response.text();
    expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'text/plain; charset=utf-8']);
    const fields = Object.fromEntries(text.trim().split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    expect(fields).toMatchObject({ Contact: 'mailto:security@fyl.at', 'Preferred-Languages': 'en, de', Canonical: 'https://fyl.at/.well-known/security.txt',
      Policy: 'https://github.com/ju-nu/fyl/blob/main/SECURITY.md' });
    // Expires must lie in the future and less than a year and a day ahead (RFC 9116 §2.5.5 recommends at most a year).
    const left = Date.parse(fields.Expires) - Date.now();
    expect(left > 0 && left < 366 * 86400000, fields.Expires).toBe(true);
  });

  it('lists every page in every language, each with all its alternates, and only pages that exist', async () => {
    const { response } = await direct('/sitemap.xml', {});
    const xml = await response.text();
    expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'application/xml; charset=utf-8']);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    const entries = [...xml.matchAll(/<url><loc>https:\/\/fyl\.at([^<]*)<\/loc>(.*?)<\/url>/g)];
    expect(entries.map(match => match[1])).toEqual([...LOCALES.map(code => `/${code}/`), ...LOCALES.map(code => `/${code}/privacy`)]);
    for (const [, path, links] of entries) {
      const alternates = [...links.matchAll(/<xhtml:link rel="alternate" hreflang="([a-z-]+)" href="https:\/\/fyl\.at([^"]*)"\/>/g)].map(match => [match[1], match[2]]);
      const page = path.slice(3);
      expect(alternates).toEqual([...LOCALES.map(code => [code, `/${code}${page}`]), ['x-default', page === '/' ? '/' : '/en' + page]]);
      expect((await direct(path, {}, { headers: { Accept: 'text/html' } })).response.status, path).toBe(200);
    }
  });
});
