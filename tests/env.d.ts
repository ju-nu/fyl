declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
// What tests/shipped-setup.mjs hands tests/shipped.test.ts: each file's SHA-256 in dist/ and in .build/assets, the
// source of each minified file, and the built pages, scripts and stylesheets as text; and from vitest.config.ts the
// problems of the catalogs and locale pages (tests/i18n.test.ts).
declare module 'vitest' {
  interface ProvidedContext {
    shipped: { source: Record<string, string>; output: Record<string, string>; minified: Record<string, string>; texts: Record<string, string> };
    /** What scripts/build_i18n.mjs finds wrong with the catalogs and the generated pages (problems()), as vitest.config.ts saw it. */
    i18nProblems: string[];
    /** Whether FYL_BENCH is set: the throughput benchmark in tests/e2ee-core.test.ts runs only then. */
    bench: boolean;
  }
}
export {};
