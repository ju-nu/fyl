import { describe, expect, inject, it } from 'vitest';

// What `npm run deploy` uploads: .build/assets, built from dist/ by scripts/minify_assets.mjs (the "shipped" project's
// global setup, tests/shipped-setup.mjs, builds it and hands over hashes and texts; workerd has no file system).
const { source, output, minified, texts } = inject('shipped');
const kept = Object.keys(source).filter(path => !(path in minified));
// Answered by the Worker (src/index.ts), not a file.
const WORKER = ['config.js'];
// A reference as the browser resolves it: relative to the page's address (en/index.html is served at /en/) or the script's.
const resolve = (reference: string, from: string) => new URL(reference, 'https://fyl.at/' + from.replace(/(^|\/)index\.html$/, '$1')).pathname.slice(1);

describe('deployed assets (.build/assets)', () => {
  it('holds every file of dist/ and nothing else', () => {
    expect(Object.keys(output)).toEqual(Object.keys(source));
    expect(Object.keys(source)).toEqual(expect.arrayContaining(['en/index.html', 'de/privacy.html', 'cli/latest', 'cli/install', '_headers', '_redirects']));
  });

  it("minifies the site's own scripts and stylesheets and nothing else", () => {
    expect(Object.keys(minified)).toEqual(['admin/admin.css', 'admin/admin.js', 'api.js', 'app.js', 'download.css', 'md5-worker.js', 'report.js', 'styles.css', 'theme.js', 'zip.js']);
    for (const [path, text] of Object.entries(minified)) expect(texts[path].length, path).toBeLessThan(text.length);
  });

  it("copies the encryption code, the download page's script, the service worker, vendored code and every other file byte for byte", () => {
    expect(kept).toEqual(expect.arrayContaining(['download.js', 'i18n.js', '_dl/sw.js', 'e2ee/age.js', 'e2ee/core.js', 'e2ee/crc32.js', 'e2ee/jobs.js', 'e2ee/worker.js',
      'vendor/noble-ciphers-2.4.0/chacha.js', 'vendor/spark-md5-3.0.2.js', 'vendor/qrcode-generator-2.0.4.js', 'en/download.html', 'fonts/plex-sans-400.woff2']));
    for (const path of kept) expect(output[path], path).toBe(source[path]);
  });

  it('keeps the names: every named function of the source is still there', () => {
    // No identifier minification, so an error report names the function and the served code reads back when formatted.
    let checked = 0;
    for (const [path, text] of Object.entries(minified).filter(([path]) => path.endsWith('.js'))) {
      const names = [...text.matchAll(/\bfunction\*?\s+([A-Za-z_$][\w$]*)|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g)]
        .map(match => match[1] || match[2]);
      for (const name of names) expect(texts[path], `${path}: ${name}`).toMatch(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`));
      checked += names.length;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('has every script, stylesheet, icon and font a page names', () => {
    for (const [page, html] of Object.entries(texts).filter(([path]) => path.endsWith('.html'))) {
      // Files only: canonical and hreflang links name pages, which the Worker answers (/<lang>/).
      const references = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"|<link\b(?![^>]*\brel="(?:canonical|alternate)")[^>]*\bhref="([^"]+)"/g)].map(match => resolve(match[1] || match[2], page));
      expect(references.length, page).toBeGreaterThan(1);
      for (const path of references) if (!WORKER.includes(path)) expect(output, `${page} → ${path}`).toHaveProperty([path]);
    }
    const scripts = (page: string) => [...texts[page].matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => resolve(match[1], page));
    expect(scripts('en/index.html')).toEqual(['theme.js', 'i18n.js', 'config.js', 'zip.js', 'api.js', 'app.js']);
    expect(scripts('de/download.html')).toEqual(['theme.js', 'i18n.js', 'download.js']);
  });

  it('has every module, worker and script the scripts load, and every file a stylesheet names', () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(texts).filter(([path]) => path.endsWith('.js'))) {
      // Dynamic and static imports, workers, the service worker and scripts added by setting .src. esbuild writes
      // double quotes, the sources mostly single ones.
      const loads = [/\b(?:import|importScripts|new Worker|serviceWorker\.register)\(\s*(['"])([^'"]+\.js)\1/g, /\.src\s*=\s*(['"])([^'"]+\.js)\1/g,
        /(?:^|[;}])\s*(?:import|export)\b[^'"\n;]*\bfrom\s*(['"])([^'"]+)\1/gm];
      for (const match of loads.flatMap(pattern => [...text.matchAll(pattern)])) {
        const path = resolve(match[2], file);
        found.push(path);
        expect(output, `${file} → ${path}`).toHaveProperty([path]);
      }
    }
    expect(found).toEqual(expect.arrayContaining(['md5-worker.js', 'vendor/spark-md5-3.0.2.js', 'vendor/qrcode-generator-2.0.4.js', 'e2ee/age.js', 'e2ee/jobs.js',
      'e2ee/crc32.js', 'e2ee/worker.js', '_dl/sw.js', 'vendor/noble-ciphers-2.4.0/chacha.js']));
    const named: string[] = [];
    for (const [file, text] of Object.entries(texts).filter(([path]) => path.endsWith('.css'))) {
      for (const match of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
        if (match[2].startsWith('data:')) continue;
        named.push(resolve(match[2], file));
        expect(output, `${file} → ${match[2]}`).toHaveProperty([resolve(match[2], file)]);
      }
    }
    expect(named).toEqual(expect.arrayContaining(['fonts/plex-sans-400.woff2', 'fonts/plex-sans-700.woff2', 'fonts/jetbrains-mono-400.woff2']));
  });
});
