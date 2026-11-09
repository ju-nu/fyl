// Renders the link-preview pictures: dist/og/<lang>.jpg (1200×630, og:image of the home, privacy and report pages,
// from scripts/og-image.html with the og.* strings of i18n/<lang>.json) and dist/apple-touch-icon.png (180×180, from
// dist/favicon.svg). The PNGs are committed; run this after changing the picture or its strings.
// Playwright is not a dependency of fyl: point FYL_PLAYWRIGHT at an installed copy's package folder, e.g.
//   npx -y playwright@1.56.1 install chromium && FYL_PLAYWRIGHT="$(npm root -g)/playwright" node scripts/og_images.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(process.env.FYL_PLAYWRIGHT ? pathToFileURL(process.env.FYL_PLAYWRIGHT + '/index.mjs').href : 'playwright')
  .catch(() => { console.error('Playwright not found: set FYL_PLAYWRIGHT to its package folder (see the top of this file).'); process.exit(1); });
const locales = JSON.parse(readFileSync(root + 'i18n/locales.json', 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(root + 'scripts/og-image.html').href);
for (const { code } of locales) {
  const strings = JSON.parse(readFileSync(`${root}i18n/${code}.json`, 'utf8'));
  await page.evaluate(async strings => {
    for (const id of ['headline', 'subline', 'expires']) document.getElementById(id).textContent = strings['og.' + id];
    await document.fonts.ready;
    // A longer headline gets a smaller size until it fits on one line.
    const headline = document.getElementById('headline');
    for (let size = 98; headline.scrollWidth > headline.clientWidth && size > 60; size -= 2) headline.style.fontSize = size + 'px';
  }, strings);
  // JPEG: a gradient this size is about 300 KB as PNG, and some chat apps skip previews of that size.
  await page.screenshot({ path: `${root}dist/og/${code}.jpg`, type: 'jpeg', quality: 88 });
  console.log(`Rendered dist/og/${code}.jpg`);
}
const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
// Inline, so the page needs no file access; full-bleed, since the platforms round the corners themselves.
const svg = readFileSync(root + 'dist/favicon.svg', 'utf8').replace('rx="9"', 'rx="0"').replace('<svg ', '<svg width="180" height="180" ');
await icon.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg}`);
await icon.screenshot({ path: `${root}dist/apple-touch-icon.png` });
console.log('Rendered dist/apple-touch-icon.png');
await browser.close();
