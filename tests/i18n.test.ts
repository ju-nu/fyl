import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import api from '../dist/api.js?raw';
import app from '../dist/app.js?raw';
import download from '../dist/download.js?raw';
import i18n from '../dist/i18n.js?raw';
import report from '../dist/report.js?raw';
import de from '../i18n/de.json';
import en from '../i18n/en.json';
import { format, LOCALES, negotiate } from '../src/i18n';
import { direct, file, pathOf, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.41.');

// The site in several languages (i18n/README.md): / only picks one, every page exists once per locale under /<lang>/,
// each self-canonical with hreflang for all of them, and shared download links keep their address and take the
// browser's language.
const html = { Accept: 'text/html' };
const manual = (path: string, headers: Record<string, string> = {}, bindings: Partial<Env> = {}) => direct(path, bindings, { headers: { ...html, ...headers }, redirect: 'manual' });
const PAGES = [['/', 'https://fyl.at/'], ['/privacy', 'https://fyl.at/en/privacy'], ['/report', 'https://report.fyl.at/']] as const;
const canonical = (code: string, page: string) => page === '/report' ? `https://report.fyl.at/${code}/` : `https://fyl.at/${code}${page}`;
const OG = { en: 'en_GB', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', nl: 'nl_NL' } as Record<string, string>;
const policy = (response: Response) => response.headers.get('Content-Security-Policy') || '';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the language switch at /', () => {
  it('redirects 302 by Accept-Language, q-values and regions included, to English when nothing fits, and keeps the query', async () => {
    for (const [language, code] of [['de-AT,de;q=0.9,en;q=0.8', 'de'], ['en-US,en;q=0.9', 'en'], ['es-419', 'es'], ['nl-BE', 'nl'], ['FR_ch', 'fr'],
      ['de;q=0.5, fr;q=0.9', 'fr'], ['ja, ko;q=0.9, nl;q=0.1', 'nl'], ['de;q=0, en', 'en'], ['de;q=0', 'en'], ['ja', 'en'], ['*', 'en'], ['x-klingon', 'en'],
      ['', 'en'], ['es;q=0.8, de;q=0.8', 'es'], ['de;q=1.0, fr;q=1', 'de'], ['de;q=abc', 'de'], ['a'.repeat(4000), 'en']] as const) {
      const { response } = await manual('/', { 'Accept-Language': language });
      expect([language.slice(0, 40), response.status, response.headers.get('Location')]).toEqual([language.slice(0, 40), 302, `/${code}/`]);
      expect(response.headers.get('Vary')).toBe('Accept, Accept-Language');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    const { response } = await manual('/?utm_source=newsletter&utm_campaign=launch', { 'Accept-Language': 'fr' });
    expect(response.headers.get('Location')).toBe('/fr/?utm_source=newsletter&utm_campaign=launch');
    // A management link's fragment never reaches the server; the browser keeps it across the redirect.
    expect((await manual('/', {})).response.headers.get('Location')).toBe('/en/');
    expect((await direct('/', {}, { method: 'POST' })).response.status).toBe(405);
  });

  it('falls back to the visitor\'s country (CF-IPCountry) only when the browser sends no Accept-Language', async () => {
    for (const [country, code] of [['AT', 'de'], ['ch', 'de'], ['MX', 'es'], ['FR', 'fr'], ['NL', 'nl'], ['US', 'en'], ['BE', 'en'], ['XX', 'en'], ['', 'en']] as const) {
      const { response } = await manual('/', { 'CF-IPCountry': country });
      expect([country, response.headers.get('Location')]).toEqual([country, `/${code}/`]);
    }
    // A header the site can't serve still means English, whatever the country: the browser's choice wins.
    expect((await manual('/', { 'Accept-Language': 'ja', 'CF-IPCountry': 'AT' })).response.headers.get('Location')).toBe('/en/');
    expect((await manual('/', { 'Accept-Language': 'fr', 'CF-IPCountry': 'AT' })).response.headers.get('Location')).toBe('/fr/');
  });

  it('never redirects a page of a locale by the browser language', async () => {
    for (const path of ['/de/', '/de/privacy', '/fr/', '/en/report', '/nl/download']) {
      const { response } = await manual(path, { 'Accept-Language': 'es' });
      expect([path, response.status, response.headers.get('Location')]).toEqual([path, 200, null]);
      expect(response.headers.get('Vary')).toBeNull();
      await response.arrayBuffer();
    }
  });

  it('moves the old addresses for good (301) to the English page, with their query', async () => {
    for (const [path, location] of [['/index.html', '/en/'], ['/privacy', '/en/privacy'], ['/privacy.html', '/en/privacy'], ['/report', '/en/report'],
      ['/report.html?link=x', '/en/report?link=x'], ['/download', '/en/download'], ['/download.html', '/en/download'], ['/de', '/de/'], ['/de?utm_source=x', '/de/?utm_source=x'],
      ['/de/index.html', '/de/'], ['/fr/privacy.html', '/fr/privacy'], ['/nl/report.html', '/nl/report']] as const) {
      const { response } = await manual(path, {}, { REPORT_HOST: '' } as unknown as Partial<Env>);
      expect([path, response.status, response.headers.get('Location')]).toEqual([path, 301, location]);
    }
    // Where the report form has its own host, its pages go there, in their language.
    const { response } = await manual('/de/report?link=abc', {}, { REPORT_HOST: 'report.fyl.at' } as unknown as Partial<Env>);
    expect([response.status, response.headers.get('Location')]).toEqual([302, 'https://report.fyl.at/de/?link=abc']);
    for (const path of ['/xx/', '/en/nope', '/en/app.js', '/de/sitemap.xml']) expect((await manual(path)).response.status, path).toBe(404);
  });
});

describe('the pages in every language', () => {
  it('are self-canonical, name every language and / (x-default) as alternates, and carry their language and og:locale', async () => {
    for (const code of LOCALES) for (const [page, fallback] of PAGES) {
      const { response } = await manual(`/${code}${page}`, {}, { REPORT_HOST: '' } as unknown as Partial<Env>);
      const text = await response.text(), where = `/${code}${page}`;
      expect([where, response.status]).toEqual([where, 200]);
      expect(text, where).toContain(`<html lang="${code}">`);
      expect(text, where).not.toContain('<!--');
      expect(text.match(/<meta http-equiv="content-language" content="([a-z]+)">/g), where).toEqual([`<meta http-equiv="content-language" content="${code}">`]);
      // "Report a file" goes straight to the form's own host, in this language, not through a redirect.
      expect(text, where).toContain(`href="https://report.fyl.at/${code}/"`);
      expect(text, where).not.toMatch(/href="\/[a-z]{2}\/report"(?! hreflang)/);
      expect([...text.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(match => match[1]), where).toEqual([canonical(code, page)]);
      const alternates = [...text.matchAll(/<link rel="alternate" hreflang="([a-z-]+)" href="([^"]+)">/g)].map(match => [match[1], match[2]]);
      expect(alternates, where).toEqual([...LOCALES.map(other => [other, canonical(other, page)]), ['x-default', fallback]]);
      expect(text, where).toContain(`<meta property="og:url" content="${canonical(code, page)}"><meta property="og:locale" content="${OG[code]}">`);
      // Link previews: exactly one og:title, og:description and og:type each, from the page's own strings.
      for (const tag of ['og:title', 'og:description', 'og:type'])
        expect([where, tag, text.match(new RegExp(`<meta property="${tag}" content="[^"]+">`, 'g'))?.length]).toEqual([where, tag, 1]);
      expect(text, where).toContain('<meta property="og:type" content="website">');
      expect(text, where).toContain(`<meta property="og:title" content="${(/<title>([^<]+)<\/title>/.exec(text) || [])[1]}">`);
      expect([...text.matchAll(/<meta property="og:locale:alternate" content="([a-z_A-Z]+)">/g)].map(match => match[1]), where).toEqual(LOCALES.filter(other => other !== code).map(other => OG[other]));
      expect(text, where).toMatch(/<title>[^<{}]+<\/title>/);
      // Every placeholder was filled: no {{…}} and no message key outside the scripts' JSON block.
      expect(text.replace(/<script type="application\/json"[^>]*>.*?<\/script>/s, ''), where).not.toMatch(/\{\{|\b(?:common|home|report|privacy|download)\.(?!fyl\.)[a-z]+(?:[A-Z]|\.[a-z])/);
      // The language menu: a link to this page in every language, the current one checked.
      const menu = [...text.matchAll(/<a class="menu-item" role="menuitemradio" aria-checked="(true|false)" href="([^"]+)" hreflang="([a-z]+)" lang="\3" data-lang="\3">/g)];
      expect(menu.map(match => [match[3], match[2], match[1]]), where).toEqual(LOCALES.map(other => [other, `/${other}${page}`, String(other === code)]));
      expect(text, where).toContain('popovertarget="lang-menu"');
      // Internal links stay in the language; the wordmark leads to its home page.
      for (const [, href] of text.matchAll(/<a\b[^>]*\bhref="(\/[^"]*)"/g)) if (!href.startsWith('/llms.txt') && !href.startsWith('/#')) expect(href, where).toMatch(/^\/(?:en|de|es|fr|nl)\//);
    }
  });

  it('name a link-preview picture of the page\'s language that is served as a JPEG', async () => {
    for (const code of LOCALES) {
      const page = await (await manual(`/${code}/`)).response.text();
      expect(page).toContain(`<meta property="og:image" content="https://fyl.at/og/${code}.jpg">`);
      expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
      const { response } = await manual(`/og/${code}.jpg`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      // Chat apps skip previews much above 300 KB.
      expect(bytes.length).toBeLessThan(150_000);
    }
  });

  it('keep the English copy, the brand and the site policy in every language', async () => {
    const english = await (await manual('/en/')).response.text();
    expect(english).toContain('<title>fyl.at — Share files up to 50 GB · Fyl for now.</title>');
    expect(english).toContain(`<p>${en['home.introHtml']}</p>`);
    for (const code of LOCALES) {
      const { response } = await manual(`/${code}/`);
      await response.arrayBuffer();
      // The same scripts and workers as the English page, so a translation can't widen what a page may run.
      expect(policy(response), code).toBe(policy((await manual('/en/')).response));
      expect(policy(response), code).toContain('https://fyl.at/i18n.js');
      expect(policy(response), code).not.toContain("'self'; worker");
    }
    const report = (await manual('/de/report', {}, { REPORT_HOST: '' } as unknown as Partial<Env>)).response;
    expect(policy(report)).toBe(policy((await manual('/en/report', {}, { REPORT_HOST: '' } as unknown as Partial<Env>)).response));
  });

  it('say on a translated privacy page that the English one is binding', async () => {
    const english = await (await manual('/en/privacy')).response.text(), german = await (await manual('/de/privacy')).response.text();
    expect(english).not.toContain('class="meta binding"');
    expect(german).toContain(`<p class="meta binding">${de['privacy.bindingHtml']}</p>`);
    expect(german).toContain('<a href="/en/privacy" hreflang="en">');
  });

  it('give the scripts their messages as a JSON block, in the page language, with nothing inline to run', async () => {
    for (const code of LOCALES) {
      const text = await (await manual(`/${code}/`)).response.text();
      const block = JSON.parse(/<script type="application\/json" id="fyl-i18n">(.*?)<\/script>/s.exec(text)?.[1] || '{}');
      expect([block.lang, typeof block.strings['home.multiple'], block.strings['common.size.gb']]).toEqual([code, 'string', expect.stringContaining('{n}')]);
      expect(text).not.toMatch(/<script(?![^>]*\b(?:src=|type="application\/json"))[^>]*>/);
    }
  });

  it('carry every message their scripts can show, the ones chosen by state included', async () => {
    const blockOf = async (path: string, headers: Record<string, string> = {}) =>
      JSON.parse(/<script type="application\/json" id="fyl-i18n">(.*?)<\/script>/s.exec(await (await manual(path, headers)).response.text())?.[1] || '{}').strings;
    const { receipt } = await file();
    for (const code of LOCALES) {
      // The delete dialog (named or not, the reviewed file's too) and the terminal hint of an encrypted link (password,
      // key in the link or not): keys picked by state, once assembled at run time and missing from the block.
      const home = await blockOf(`/${code}/`), download = await blockOf(pathOf(receipt.url), { 'Accept-Language': code });
      for (const key of ['home.deleteNamedHtml', 'home.deleteUnnamedHtml', 'home.deleteReviewNamedHtml', 'home.deleteReviewUnnamedHtml']) expect(home[key], `${code} ${key}`).toBeTypeOf('string');
      for (const key of ['download.hintE2ee', 'download.hintE2eeKey', 'download.hintE2eePassword', 'download.hintE2eePasswordKey', 'download.hintPlain']) expect(download[key], `${code} ${key}`).toBeTypeOf('string');
    }
    // No script assembles a key from a part that is no prefix (problems() checks the names it writes out whole).
    for (const [name, source] of Object.entries({ app, download, report, api, i18n })) {
      expect([name, [...source.matchAll(/'((?:common|home|download|report|privacy)\.[\w.]*\w)'\s*\+/g)].map(match => match[1])]).toEqual([name, []]);
    }
  });
});

describe('download links in the browser language', () => {
  it('keep their address and answer in the language the browser asks for, or ?lang= from the page menu, with Vary', async () => {
    const { receipt } = await file(), path = pathOf(receipt.url);
    for (const [headers, query, code] of [[{ 'Accept-Language': 'de-DE,de;q=0.9' }, '', 'de'], [{ 'Accept-Language': 'ja' }, '', 'en'], [{}, '', 'en'],
      [{ 'Accept-Language': 'de' }, '?lang=fr', 'fr'], [{ 'Accept-Language': 'nl' }, '?lang=xx', 'nl']] as const) {
      const { response } = await manual(path + query, headers);
      const text = await response.text();
      expect([code, response.status, response.headers.get('Location'), response.headers.get('Vary')]).toEqual([code, 200, null, 'Accept-Language']);
      expect(text, code).toContain(`<html lang="${code}"`);
      expect(text, code).toContain(`<meta property="og:locale" content="${OG[code]}">`);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      // The menu keeps this address: ?lang= of each language.
      expect([...text.matchAll(/href="([^"]+)" hreflang="[a-z]+" lang="[a-z]+" data-lang/g)].map(match => match[1])).toEqual(LOCALES.map(other => `?lang=${other}`));
      expect(policy(response)).toBe(policy((await manual(path)).response));
    }
  });

  it('show a closed link in the browser language too, without a redirect', async () => {
    const { response } = await manual('/d/' + 'Z'.repeat(43), { 'Accept-Language': 'es' });
    const text = await response.text();
    expect([response.status, response.headers.get('Vary')]).toEqual([404, 'Accept-Language']);
    expect(text).toContain('<html lang="es"');
    expect(text).toContain('<meta http-equiv="content-language" content="es">');
    expect(text).toContain('data-state="gone"');
    // Without Accept-Language, the visitor's country picks.
    expect(await (await manual('/d/' + 'Z'.repeat(43), { 'CF-IPCountry': 'NL' })).response.text()).toContain('<html lang="nl"');
  });
});

describe('the catalogs', () => {
  it('are complete and the generated pages up to date (scripts/build_i18n.mjs, run in Node by vitest.config.ts)', () => {
    expect(inject('i18nProblems')).toEqual([]);
  });

  it('format arguments and plurals alike in the Worker and the browser', async () => {
    vi.stubGlobal('window', globalThis);
    const messages = { one: '{count, plural, one {# day} other {# days}}', exact: '{count, plural, =0 {none} one {# file} other {# files}}', name: 'Hello {name}, {missing}' };
    vi.stubGlobal('document', { getElementById: () => ({ textContent: JSON.stringify({ lang: 'de', intl: 'de', strings: messages }) }) });
    // @ts-expect-error: a browser script without type declarations.
    await import('../dist/i18n.js');
    const browser = (globalThis as unknown as { FylText: { t(key: string, vars: object): string; size(bytes: number): string } }).FylText;
    for (const [key, vars, expected] of [['one', { count: 1 }, '1 day'], ['one', { count: 1500 }, '1.500 days'], ['exact', { count: 0 }, 'none'], ['exact', { count: 2 }, '2 files'],
      ['name', { name: 'Ada' }, 'Hello Ada, {missing}']] as const) {
      expect([key, format(messages[key], vars, 'de')]).toEqual([key, expected]);
      expect([key, browser.t(key, vars)]).toEqual([key, expected]);
    }
    expect(negotiate('de-AT')).toBe('de');
  });
});
