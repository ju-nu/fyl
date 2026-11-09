// Global setup of the "shipped" Vitest project (vitest.config.ts): builds .build/assets the way `npm run deploy` does
// (scripts/minify_assets.mjs) before its tests import from there, and again before each rerun in watch mode, so they
// never run stale bytes. The tests run inside workerd without the file system, so tests/shipped.test.ts gets what it checks
// from here: every file's SHA-256 in dist/ and in the output, which ones were minified (with their source), and the
// text of the pages, scripts and stylesheets whose references it follows.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildAssets, files, OUT, SOURCE } from '../scripts/minify_assets.mjs';

const hashes = dir => Object.fromEntries(files(dir).map(path => [path, createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')]));

async function build(project) {
  const rows = await buildAssets();
  const text = dir => path => [path, readFileSync(join(dir, path), 'utf8')];
  project.provide('shipped', {
    source: hashes(SOURCE), output: hashes(OUT), minified: Object.fromEntries(rows.map(row => text(SOURCE)(row.path))),
    texts: Object.fromEntries(files(OUT).filter(path => /\.(html|js|css)$/.test(path)).map(text(OUT))),
  });
}

export default async function setup(project) {
  await build(project);
  // Watch mode: a change in dist/ reruns these tests (watchTriggerPatterns in vitest.config.ts). Rebuild first, then drop
  // the modules Vite still holds from the previous build: the watcher ignores .build/, or each rebuild would rerun again.
  project.onTestsRerun(async () => {
    await build(project);
    for (const path of files(OUT)) project.vitest.invalidateFile(`${OUT.split(sep).join('/')}/${path}`);
  });
}
