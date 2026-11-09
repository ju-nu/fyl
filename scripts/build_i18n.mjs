// Builds the site's pages in every language (i18n/README.md): i18n/templates/*.html with the catalogs i18n/<lang>.json
// become dist/<lang>/{index,privacy,report,download}.html, and dist/sitemap.xml lists them. The output is committed,
// like dist/_redirects, so `npm run dev`, the tests and `wrangler dev` serve dist/ as it is; `npm run build:assets` runs
// this first, and the tests fail while a generated file is stale or a catalog is incomplete (problems()).
//
// A template names a message as {{key}}, with arguments as {{key name:other.key count=3}} (another message, a number).
// Keys ending in "Html" may hold the inline markup their English holds; every other value is plain text, escaped here.
// {{@…}} are the page's own parts: @lang, @base (/<lang>), @seo (canonical, hreflang, og:url, og:locale), @strings
// (the JSON block #fyl-i18n with the messages the page's scripts use), @languageButton and @languageMenu (the footer's
// language menu), @binding (the note on a translated privacy page that the English one is binding), @source (the public
// repository, which the footer links to). Every message may name {base}, {report}, {source} and {releases}.
//
// A catalog other than en.json may be missing (all five locales are still built, in English) or lack a key (that key
// falls back to English), so a page never breaks; problems() names both once the catalog exists.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const I18N = join(root, 'i18n'), DIST = join(root, 'dist');
/** en, de, es, fr, nl: code, native name, og:locale and the Intl locale of each (i18n/locales.json, read by the Worker too). */
export const LOCALES = JSON.parse(readFileSync(join(I18N, 'locales.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const PUBLIC = config.vars.PUBLIC_BASE_URL.replace(/\/$/, ''), REPORT_HOST = config.vars.REPORT_HOST || '';
/** The public repository with fyl's source, and its releases with the checksums of each release's files. */
export const SOURCE = 'https://github.com/ju-nu/fyl-at', RELEASES = SOURCE + '/releases';

/**
 * The pages: the template, the path inside a locale, whether search engines get it (canonical and hreflang; the
 * download page is noindex), and keys the page's JSON block carries besides those its scripts name: the Worker reads
 * the download page's to write its preview tags (previewTags() in src/index.ts).
 */
export const PAGES = [
  { name: 'index', path: '/', indexed: true },
  { name: 'privacy', path: '/privacy', indexed: true },
  { name: 'report', path: '/report', indexed: true },
  { name: 'download', path: '/download', indexed: false, server: ['download.og', 'download.description', 'download.encryptedTitle', 'common.size.', 'common.duration.', 'common.type'] },
];

const read = file => JSON.parse(readFileSync(file, 'utf8'));
/** The catalogs that exist, by code; en.json always does. */
export function catalogs() {
  return Object.fromEntries(LOCALES.map(({ code }) => [code, join(I18N, code + '.json')]).filter(([, file]) => existsSync(file)).map(([code, file]) => [code, read(file)]));
}

const escapeHTML = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

/**
 * A message with its arguments (the format of i18n/README.md, as dist/i18n.js and src/i18n.ts read it): {name}, and
 * {count, plural, one {…} other {…}} with # for the number and =N for an exact one. A name without a value stays.
 */
export function format(message, vars, intl) {
  const number = value => new Intl.NumberFormat(intl).format(value), rules = new Intl.PluralRules(intl);
  let out = '', index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    if (open < 0) { out += message.slice(index); break; }
    out += message.slice(index, open);
    let depth = 0, end = open;
    for (; end < message.length; end++) { if (message[end] === '{') depth++; else if (message[end] === '}' && --depth === 0) break; }
    const body = message.slice(open + 1, end), [name, kind] = body.split(',').map(part => part.trim());
    if (kind === 'plural' && name in vars) {
      const count = Number(vars[name]), options = {};
      for (const [, choice, text] of body.slice(body.indexOf(',', body.indexOf(',') + 1) + 1).matchAll(/\s*(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) options[choice] = text;
      const chosen = options['=' + count] ?? options[rules.select(count)] ?? options.other ?? '';
      out += format(chosen.replaceAll('#', number(count)), vars, intl);
    } else out += /^\w+$/.test(body) && body in vars ? vars[body] : message.slice(open, end + 1);
    index = end + 1;
  }
  return out;
}

/** The address of a page in a locale, the address hreflang's x-default names, and the page's path in a locale. */
const url = (page, code) => page.name === 'report' && REPORT_HOST ? `https://${REPORT_HOST}/${code}/` : `${PUBLIC}/${code}${page.path}`;
const fallbackUrl = page => page.name === 'index' ? PUBLIC + '/' : page.name === 'report' && REPORT_HOST ? `https://${REPORT_HOST}/` : url(page, 'en');

/** The scripts a template loads from dist/ (config.js comes from the Worker) and the message keys they name. */
function scriptKeys(template, english) {
  const keys = new Set();
  for (const [, src] of template.matchAll(/<script\b[^>]*\bsrc="\/([\w./-]+\.js)"/g)) {
    if (!existsSync(join(DIST, src))) continue;
    for (const [, key] of readFileSync(join(DIST, src), 'utf8').matchAll(/'((?:common|home|download|report|privacy)\.[\w.]*)'/g))
      for (const name of Object.keys(english)) if (key.endsWith('.') ? name.startsWith(key) : name === key) keys.add(name);
  }
  return keys;
}

/** One page in one locale. `strings`: the locale's catalog ({} where it has none); English fills every gap. */
export function render(page, code, strings, english) {
  const template = readFileSync(join(I18N, 'templates', page.name + '.html'), 'utf8');
  const locale = LOCALES.find(item => item.code === code), base = '/' + code;
  // The report form lives on its own host where one is set (report.fyl.at/<lang>/): links go there directly, not
  // through the public host's redirect.
  const report = REPORT_HOST ? `https://${REPORT_HOST}/${code}/` : base + '/report';
  const message = key => {
    if (!(key in english)) throw new Error(`${page.name}.html names ${key}, which en.json doesn't have.`);
    return typeof strings[key] === 'string' ? strings[key] : english[key];
  };
  const text = (key, vars = {}) => {
    const html = key.endsWith('Html'), value = format(message(key), { base, report, source: SOURCE, releases: RELEASES, ...Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, html ? escapeHTML(value) : value])) }, locale.intl);
    return html ? value : escapeHTML(value);
  };
  // content-language names the page's language for tools that ignore <html lang>; every page carries it.
  const seo = () => `<meta http-equiv="content-language" content="${code}">` + (page.indexed ? [
    `<link rel="canonical" href="${url(page, code)}">`,
    ...LOCALES.map(item => `<link rel="alternate" hreflang="${item.code}" href="${url(page, item.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${fallbackUrl(page)}">`,
    `<meta property="og:url" content="${url(page, code)}"><meta property="og:locale" content="${locale.og}">`,
    ...LOCALES.filter(item => item.code !== code).map(item => `<meta property="og:locale:alternate" content="${item.og}">`),
    // The link-preview picture in the page's language (scripts/og_images.mjs renders it).
    `<meta property="og:image" content="${PUBLIC}/og/${code}.jpg"><meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${text('og.imageAlt')}"><meta name="twitter:card" content="summary_large_image">`,
  ].join('') : '');
  const strings_ = () => {
    const keys = new Set([...scriptKeys(template, english), ...Object.keys(english).filter(key => (page.server || []).some(prefix => key.startsWith(prefix)))]);
    const block = { lang: code, intl: locale.intl, strings: Object.fromEntries([...keys].map(key => [key, message(key)])) };
    return `<script type="application/json" id="fyl-i18n">${JSON.stringify(block).replaceAll('<', '\\u003c')}</script>`;
  };
  // The language menu looks like the theme menu: a popover of the same items, each a plain link to this page in that
  // language (the Worker points the download page's at ?lang=, the report host's at /<lang>/).
  const button = () => `<button class="btn btn-quiet lang-trigger" type="button" popovertarget="lang-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${text('common.languageIs', { name: locale.name })}"><svg class="i" aria-hidden="true"><use href="#i-globe"/></svg><span>${escapeHTML(locale.name)}</span></button>`;
  const menu = () => `<div class="menu" id="lang-menu" popover role="menu" aria-label="${text('common.language')}">\n` + LOCALES.map(item =>
    `<a class="menu-item" role="menuitemradio" aria-checked="${item.code === code}" href="/${item.code}${page.path}" hreflang="${item.code}" lang="${item.code}" data-lang="${item.code}"><span class="lang-code" aria-hidden="true">${item.code.toUpperCase()}</span><span>${escapeHTML(item.name)}</span><svg class="i on" aria-hidden="true"><use href="#i-check"/></svg></a>\n`).join('') + '</div>';
  const parts = { lang: () => code, base: () => base, report: () => report, source: () => SOURCE, seo, strings: strings_, languageButton: button, languageMenu: menu,
    binding: () => code === 'en' ? '' : `<p class="meta binding">${text('privacy.bindingHtml')}</p>` };
  const page_ = template.replace(/\{\{([@\w.]+)((?:\s+\w+[:=][\w.]+)*)\s*\}\}/g, (_, key, args) => {
    if (key.startsWith('@')) {
      if (!parts[key.slice(1)]) throw new Error(`${page.name}.html names {{${key}}}, which is no part of a page.`);
      return parts[key.slice(1)]();
    }
    const vars = {};
    for (const [, name, sign, value] of args.matchAll(/(\w+)([:=])([\w.]+)/g)) vars[name] = sign === ':' ? format(message(value), {}, locale.intl) : new Intl.NumberFormat(locale.intl).format(Number(value));
    return text(key, vars);
  });
  if (/\{\{/.test(page_)) throw new Error(`${page.name}.html has a placeholder this script can't read: ${/\{\{[^}]*\}\}/.exec(page_)[0]}`);
  // Served pages carry no HTML comments: the templates' notes stay in i18n/templates/, and that dist/<lang>/ is generated
  // is said in i18n/README.md (the staleness test catches a hand edit).
  return page_.replace(/<!--[\s\S]*?-->\n?/g, '');
}

/** sitemap.xml: every indexed page of fyl.at in every locale, each with its alternates (the report form has its own host). */
export function sitemap() {
  const pages = PAGES.filter(page => page.indexed && !(page.name === 'report' && REPORT_HOST));
  const alternates = page => LOCALES.map(item => `<xhtml:link rel="alternate" hreflang="${item.code}" href="${url(page, item.code)}"/>`).join('')
    + `<xhtml:link rel="alternate" hreflang="x-default" href="${fallbackUrl(page)}"/>`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + pages.flatMap(page => LOCALES.map(item => `<url><loc>${url(page, item.code)}</loc>${alternates(page)}</url>\n`)).join('') + '</urlset>\n';
}

/** Every generated file, by its path under dist/, with the content it should have. */
export function outputs() {
  const all = catalogs(), english = all.en;
  const files = { 'sitemap.xml': sitemap() };
  for (const { code } of LOCALES) for (const page of PAGES) files[`${code}/${page.name}.html`] = render(page, code, all[code] || {}, english);
  return files;
}

/** Writes the generated files that changed; returns their paths. */
export function generate() {
  const changed = [];
  for (const [path, content] of Object.entries(outputs())) {
    const file = join(DIST, path);
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    changed.push(path);
  }
  return changed;
}

// The markup of a message: its tags as written, in order. A translation keeps the English ones exactly.
const tags = text => [...String(text).matchAll(/<\/?[a-z][^>]*>/gi)].map(match => match[0]);
// The names a message's arguments use ({name} and the counted name of a plural), sorted.
const names = text => [...new Set([...String(text).matchAll(/\{(\w+)(?=[,}])/g)].map(match => match[1]))].sort();

// The branch selectors of every plural in a message ('one', 'other', '=0', …), nested plurals included.
function pluralSelectors(text) {
  const found = [], value = String(text);
  for (const match of value.matchAll(/\{\w+,\s*plural,/g)) {
    let at = match.index + match[0].length;
    for (;;) {
      const selector = /^\s*(=\d+|[a-z]+)\s*\{/.exec(value.slice(at));
      if (!selector) break;
      found.push(selector[1]);
      at += selector[0].length;
      for (let depth = 1; depth && at < value.length; at++) depth += value[at] === '{' ? 1 : value[at] === '}' ? -1 : 0;
    }
  }
  return found;
}

/**
 * What is wrong with the catalogs and the generated files, as sentences (empty when nothing is): a key a present
 * catalog lacks or has too many, a value that isn't text, other arguments or markup than the English one, a plural
 * without `other` or with a branch its language never selects (Intl.PluralRules: "few" means nothing in English),
 * markup in a plain key, a key a script names that en.json lacks or assembles from a part that is no prefix, and a
 * generated file that is stale.
 */
export function problems() {
  const found = [], all = catalogs(), english = all.en;
  for (const [code, catalog] of Object.entries(all)) {
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const key of Object.keys(english)) if (!(key in catalog)) found.push(`i18n/${code}.json lacks ${key}.`);
    for (const [key, value] of Object.entries(catalog)) {
      if (!(key in english)) { found.push(`i18n/${code}.json has ${key}, which en.json doesn't.`); continue; }
      if (typeof value !== 'string') { found.push(`i18n/${code}.json: ${key} is not a string.`); continue; }
      if (names(value).join() !== names(english[key]).join()) found.push(`i18n/${code}.json: ${key} uses {${names(value).join('} {')}}, English {${names(english[key]).join('} {')}}.`);
      if (key.endsWith('Html') ? tags(value).join('') !== tags(english[key]).join('') : /<\/?[a-z]/i.test(value)) found.push(`i18n/${code}.json: ${key} has other markup than the English.`);
      if (/\{\w+,\s*plural,/.test(value) && !/\bother\s*\{/.test(value)) found.push(`i18n/${code}.json: ${key} is a plural without "other".`);
      for (const selector of pluralSelectors(value))
        if (!selector.startsWith('=') && !categories.includes(selector)) found.push(`i18n/${code}.json: ${key} has a plural branch "${selector}", which ${code} never selects.`);
    }
  }
  for (const file of ['app.js', 'api.js', 'download.js', 'report.js', 'i18n.js'])
    for (const [, key] of readFileSync(join(DIST, file), 'utf8').matchAll(/\b(?:t|tHtml|text)\('((?:common|home|download|report|privacy)\.[\w.]*\w)'\s*[,)]/g))
      if (!(key in english)) found.push(`dist/${file} names ${key}, which en.json doesn't have.`);
  // A key a script assembles from a part that isn't a prefix ('home.delete' + …) never reaches the page's block, which
  // carries only the keys the scripts name whole or by a prefix ending in "." (scriptKeys()): the page shows the key.
  for (const file of ['app.js', 'api.js', 'download.js', 'report.js', 'i18n.js'])
    for (const [, key] of readFileSync(join(DIST, file), 'utf8').matchAll(/'((?:common|home|download|report|privacy)\.[\w.]*\w)'\s*\+/g))
      found.push(`dist/${file} builds a key from '${key}' + …: write each key out whole, or join to a prefix ending in ".".`);
  try {
    for (const [path, content] of Object.entries(outputs()))
      if (!existsSync(join(DIST, path)) || readFileSync(join(DIST, path), 'utf8') !== content) found.push(`dist/${path} is stale: run npm run build:i18n.`);
  } catch (error) { found.push(String(error.message)); }
  return found;
}

// Run directly (npm run build:i18n, npm run build:assets, npm run dev), not imported (vitest.config.ts). With --check it
// only reports, like CI would.
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  if (process.argv.includes('--check')) {
    const found = problems();
    for (const line of found) console.error(line);
    process.exit(found.length ? 1 : 0);
  }
  const changed = generate();
  console.log(changed.length ? `Generated ${changed.map(path => relative(root, join(DIST, path))).join(', ')}.` : 'The locale pages are up to date.');
  const found = problems().filter(line => !line.endsWith('is stale: run npm run build:i18n.'));
  for (const line of found) console.warn('Warning: ' + line);
}
