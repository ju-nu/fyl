// Builds the folder `npm run deploy` uploads: a copy of dist/ in .build/assets with the site's own scripts and
// stylesheets minified (docs/OPERATIONS.md#static-assets). dist/ stays the source: `npm run dev` serves it as written,
// and every other file is copied byte for byte (HTML, _headers, fonts, images, dist/cli/).
//
// Only whitespace and comments go (esbuild's minifyWhitespace), never names or syntax: identifiers stay as written, so
// an error report from a browser still names the function, and pretty-printing a served file gives back the source's
// code, rule for rule, so a grep or the DevTools Styles panel finds what the source says. minifySyntax would merge CSS
// rules into selector lists the source doesn't have, rewrite values and inline constants for 331 more bytes of brotli
// over all nine files (styles.css even grows). Most of the saving is the comments anyway. No target is set, so nothing
// is lowered or polyfilled, and each file keeps its kind: a classic script stays one, a module keeps import and export.
//
// npm run build (the dry run in npm run ci) and the "shipped" project of the Vitest config build the same folder, so
// CI and the browser-module tests run the bytes production gets. Only .build/assets is emptied, never the rest of
// .build, where the dry run writes its bundle.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { transform } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SOURCE = join(root, 'dist'), OUT = join(root, '.build', 'assets');

// Shipped exactly as written: the code that sees encryption keys, so that what fyl.at serves can be compared byte for
// byte with the public source (smoke.py --pages does after every deploy): the E2EE core and its workers, the download
// page's code, the download service worker and the vendored libraries (already as their authors publish them) stay
// readable, and so does i18n.js, which the download page loads before download.js.
export const KEPT = ['e2ee/', 'download.js', 'i18n.js', '_dl/', 'vendor/'];

/** Whether the build minifies this file of dist/ (a path relative to dist/, with forward slashes). */
export const minifies = path => /\.(js|css)$/.test(path) && !KEPT.some(kept => kept.endsWith('/') ? path.startsWith(kept) : path === kept);

/** Every file under a folder, as sorted paths relative to it with forward slashes. */
export const files = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();

/** Copies dist/ to .build/assets and minifies the files minifies() names; returns their sizes before and after. */
export async function buildAssets() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(dirname(OUT), { recursive: true });
  cpSync(SOURCE, OUT, { recursive: true });
  const rows = [];
  for (const path of files(OUT).filter(minifies)) {
    const source = readFileSync(join(OUT, path));
    // charset utf8 keeps the UI copy's "…" and "—" as they are instead of \u escapes (the pages are UTF-8, and so
    // were these files). Legal comments (/*! … */, @license) would stay; none of these files has one today.
    const { code } = await transform(source.toString('utf8'), {
      loader: path.endsWith('.css') ? 'css' : 'js', minifyWhitespace: true, charset: 'utf8', sourcefile: path,
    });
    writeFileSync(join(OUT, path), code);
    rows.push({ path, raw: [source.length, Buffer.byteLength(code)], brotli: [brotli(source), brotli(code)] });
  }
  return rows;
}

// Node's default brotli level is 11, about what a CDN gets for a static file; the table is an estimate of the wire size.
const brotli = data => brotliCompressSync(data).length;

/** The size table: each minified file, the total, and what the home page's first visit loads of them. */
export function table(rows) {
  const kb = bytes => (bytes / 1024).toFixed(1).padStart(6) + ' KiB';
  const saved = ([before, after]) => `${kb(before)} → ${kb(after)} (−${Math.round(100 * (before - after) / before)} %)`;
  const line = (name, row) => `${name.padEnd(22)} ${saved(row.raw).padEnd(34)} ${saved(row.brotli)}`;
  const sum = list => ({ raw: [0, 1].map(i => list.reduce((total, row) => total + row.raw[i], 0)), brotli: [0, 1].map(i => list.reduce((total, row) => total + row.brotli[i], 0)) });
  // The scripts and stylesheets the English upload page names (config.js comes from the Worker; fonts and HTML don't change).
  const home = [...readFileSync(join(OUT, 'en', 'index.html'), 'utf8').matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="\.?\/([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  return [`${'File'.padEnd(22)} ${'Raw'.padEnd(34)} Brotli`, ...rows.map(row => line(row.path, row)), line('Total', sum(rows)),
    line('Home page, first visit', sum(rows.filter(row => home.includes(row.path)))), `  (${rows.filter(row => home.includes(row.path)).map(row => row.path).join(', ')})`].join('\n');
}

// Run directly (npm run build:assets), not imported (vitest.config.ts, tests/shipped-setup.mjs). Node resolves symlinks
// in import.meta.url but not in argv[1], so both are compared as real paths: through a symlinked checkout a plain
// comparison failed, the script exited 0 without building, and the deploy would have uploaded whatever an earlier run
// left in .build/assets. (import.meta.main needs Node 24.2; this box runs 22.)
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (isMain()) {
  const rows = await buildAssets();
  console.log(`Copied dist/ to ${relative(root, OUT)}/, minified ${rows.length} files; kept as written: ${KEPT.join(', ')} and everything that isn't JS or CSS.`);
  console.log(table(rows));
}
