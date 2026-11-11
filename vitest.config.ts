import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';
import { problems } from './scripts/build_i18n.mjs';
import { minifies } from './scripts/minify_assets.mjs';

// Every secret is set explicitly: without them the Worker refuses to sign or hash, it has no development fallback.
const secrets = {
  ADMIN_TOKEN: 'test-operator-token-0123456789abcdef', NETWORK_HASH_KEY: 'test-network-hash-key-0123456789abcdef',
  GRANT_SIGNING_KEY: 'test-grant-signing-key-0123456789abcdef', MONITOR_TOKEN: 'test-monitor-token-0123456789abcdef',
  // Production's public Turnstile site key is in wrangler.jsonc; tests start with Turnstile off and turn it on themselves.
  TURNSTILE_SITE_KEY: '',
  // Tests open the report form on the public host unless they pass REPORT_HOST (tests/report-host.test.ts).
  REPORT_HOST: '',
  // The Access identities that read the dashboard as its owner; production keeps its list in a secret too.
  ADMIN_EMAILS: 'owner@example.org',
  // Encrypted uploads are on in tests whatever the emergency switch in wrangler.jsonc says (docs/E2EE.md §17); tests
  // that need it off say so themselves.
  E2EE_ENABLED: 'true',
};

// npm run deploy uploads dist/ with its own scripts and stylesheets minified (scripts/minify_assets.mjs). Every test
// file that imports one of those from dist/ runs a second time in the "shipped" project, where ../dist/ means the
// built .build/assets (all of it, so a minified script and the kept modules it loads stay one module graph, and
// vi.doMock of a kept module still applies). The list follows the imports, so a new test of such a file joins it by
// itself. tests/shipped.test.ts checks the build itself; .build/ is outside both projects' test files.
const tests = new URL('./tests/', import.meta.url);
const shipped = readdirSync(tests).filter(name => name.endsWith('.test.ts')
  && [...readFileSync(new URL(name, tests), 'utf8').matchAll(/['"]\.\.\/dist\/([^'"]+)['"]/g)].some(([, path]) => minifies(path)))
  .map(name => `tests/${name}`).concat('tests/shipped.test.ts');

// Each Worker test file calls from its own address range (useNetworkPrefix in tests/helpers.ts), so per-network rate
// limits and budgets never depend on another file: a file that uses the helpers without a range of its own, or a range
// another file has, stops the run here.
const ranges = new Map<string, string>();
for (const name of readdirSync(tests).filter(name => name.endsWith('.test.ts'))) {
  const source = readFileSync(new URL(name, tests), 'utf8');
  if (!/from '\.\/helpers'/.test(source)) continue;
  const range = /useNetworkPrefix\('([^']+)'\)/.exec(source)?.[1];
  if (!range) throw new Error(`tests/${name} uses tests/helpers.ts without useNetworkPrefix().`);
  if (ranges.has(range)) throw new Error(`tests/${name} and tests/${ranges.get(range)} both call from ${range}x.`);
  ranges.set(range, name);
}

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: secrets } })],
  // tests/shipped-setup.mjs rebuilds .build/assets before each rerun in watch mode; watching it would rerun forever.
  server: { watch: { ignored: ['**/.build/**'] } },
  test: {
    // The catalogs and the generated locale pages are checked here, in Node, where the files are (workerd has no file
    // system): tests/i18n.test.ts fails while a catalog misses a key or a page in dist/<lang>/ is stale.
    provide: { i18nProblems: problems(), bench: Boolean(process.env.FYL_BENCH) },
    // Several tests move real 50 MiB parts, which takes well over 5 s on a shared CI runner.
    testTimeout: 60_000,
    // expect.poll waits on work a Worker finishes after its response (a one-time link marked used); 1 s, the default,
    // ran out on a busy runner.
    expect: { poll: { timeout: 10_000 } },
    // In watch mode a change to a script or stylesheet in dist/ reruns the shipped tests too, on a fresh build.
    watchTriggerPatterns: [{ pattern: /\/dist\/.+\.(?:js|css)$/, testsToRun: () => shipped }],
    projects: [
      { extends: true, test: { name: 'dist', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/shipped.test.ts'] } },
      {
        extends: true,
        test: { name: 'shipped', include: shipped, globalSetup: ['tests/shipped-setup.mjs'] },
        resolve: { alias: [{ find: /^\.\.\/dist\//, replacement: fileURLToPath(new URL('./.build/assets/', import.meta.url)) }] },
      },
    ],
  },
});
