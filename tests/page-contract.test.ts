import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import api from '../dist/api.js?raw';
import app from '../dist/app.js?raw';
import download from '../dist/download.js?raw';
import i18n from '../dist/i18n.js?raw';
import report from '../dist/report.js?raw';
import theme from '../dist/theme.js?raw';
import zip from '../dist/zip.js?raw';
import { LOCALES } from '../src/i18n';

// The page tests (tests/web-app.test.ts) run the scripts against a scripted page that makes up any element a script
// asks for, so they can't see an id or a selector that no longer matches the markup. This reads the markup instead:
// every id a page's scripts look up, and every selector they query, matches an element of that page in every
// language, or one the scripts write themselves (their template strings).
const SCRIPTS: Record<string, string> = { 'api.js': api, 'app.js': app, 'download.js': download, 'i18n.js': i18n, 'report.js': report, 'theme.js': theme, 'zip.js': zip };
// Not in dist/: the Worker writes /config.js, and injects the download page's state block into the served page.
const GENERATED = { scripts: ['config.js'], ids: ['fyl-state'] };
const PAGES = ['/', '/download', '/report', '/privacy'];

interface Element { tag: string; attributes: Map<string, string> }
/** The start tags in `text` (markup or a script's template strings) with their attributes. */
const elementsOf = (text: string): Element[] => [...text.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map(([, tag, rest]) => {
  const attributes = new Map<string, string>();
  for (const [, name, , bare, double, single] of rest.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
    attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '');
  return { tag: tag.toLowerCase(), attributes };
});
/** One compound selector (tag, #id, .class, [attribute] or [attribute="value"]); pseudo-classes don't narrow it here. */
function compound(selector: string) {
  const plain = selector.replace(/:[a-z-]+(?:\([^)]*\))?/g, '');
  return {
    tag: /^[a-z][a-z0-9-]*/.exec(plain)?.[0] ?? null,
    id: /#([-\w]+)/.exec(plain)?.[1] ?? null,
    classes: [...plain.matchAll(/\.([-\w]+)/g)].map(match => match[1]),
    attributes: [...plain.matchAll(/\[([-\w]+)(?:="([^"]*)")?\]/g)].map(([, name, value]) => [name, value] as const),
  };
}
const matches = (element: Element, wanted: ReturnType<typeof compound>) =>
  (!wanted.tag || element.tag === wanted.tag) && (!wanted.id || element.attributes.get('id') === wanted.id)
  && wanted.classes.every(name => (element.attributes.get('class') ?? '').split(/\s+/).includes(name))
  // A value a script fills in (${…}) can be any value.
  && wanted.attributes.every(([name, value]) => element.attributes.has(name)
    && (value === undefined || element.attributes.get(name) === value || (element.attributes.get(name) ?? '').includes('${')));
/** Each part of a selector list, each compound of a descendant selector, matches some element. */
const found = (selector: string, elements: Element[]) =>
  selector.split(',').every(part => part.trim().split(/\s+/).every(piece => elements.some(element => matches(element, compound(piece)))));
const lookups = (source: string) => ({
  ids: new Set([...source.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)].map(match => match[1])),
  selectors: new Set([...source.matchAll(/(?:querySelector(?:All)?|closest)(?:\?\.)?\('([^']+)'\)/g)].map(match => match[1])),
});

describe('the ids and selectors the page scripts use', () => {
  it('match the markup of their page in every language', async () => {
    for (const code of LOCALES) for (const page of PAGES) {
      const where = `/${code}${page}`, html = await (await env.ASSETS.fetch('https://fyl.at' + where)).text();
      const names = [...html.matchAll(/<script\b[^>]*\bsrc="\/([^"?]+\.js)/g)].map(match => match[1]).filter(name => !GENERATED.scripts.includes(name));
      expect(names.filter(name => !(name in SCRIPTS)), `${where}: scripts this test doesn't read`).toEqual([]);
      const elements = [html, ...names.map(name => SCRIPTS[name])].flatMap(elementsOf);
      const ids = new Set([...elements.map(element => element.attributes.get('id')), ...GENERATED.ids]);
      for (const name of names) {
        const { ids: wanted, selectors } = lookups(SCRIPTS[name]);
        expect([...wanted].filter(id => !ids.has(id)), `${where}: ids ${name} looks up`).toEqual([]);
        expect([...selectors].filter(selector => !found(selector, elements)), `${where}: selectors ${name} queries`).toEqual([]);
      }
    }
  });

  it('finds what the scripts look up, and refuses what no page has', async () => {
    // The extraction sees the scripts' lookups at all: a change to how they look up elements must not empty the check.
    expect(lookups(app).ids.size).toBeGreaterThan(100);
    expect(lookups(download).ids.size).toBeGreaterThan(30);
    expect(lookups(report).ids.size).toBeGreaterThan(15);
    expect(lookups(theme).selectors.size).toBeGreaterThan(3);
    const elements = elementsOf(await (await env.ASSETS.fetch('https://fyl.at/en/')).text());
    expect(['#dropzone .if-folders', 'input[name="lifetime"]:checked', '[data-cli-tab]'].filter(selector => !found(selector, elements))).toEqual([]);
    expect(['#nope', '.nope', '[data-nope]', 'input[name="nope"]', '#dropzone .nope'].filter(selector => found(selector, elements))).toEqual([]);
  });
});
