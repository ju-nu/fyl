# Contributing to fyl.at

Thanks for helping. This file says how to run fyl.at locally, how the tests are laid out, which rules a change must
keep, and how a change reaches production. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)), not in an
issue or a pull request.

## Set up

- Node 24 and Python 3.12 for the Worker, the site and the tests.
- For the native CLI only: the Rust toolchain of `cli-rs/rust-toolchain.toml` (rustup installs it), zig and
  cargo-zigbuild. The committed binaries in `dist/cli/` are enough for everything else.

```bash
npm ci
npm run dev    # http://127.0.0.1:4173 with local R2, Durable Objects and generated local secrets
```

`npm run dev` (`scripts/dev.mjs`) runs `wrangler dev` on 127.0.0.1 (`--port N`, `HOST` and `PUBLIC_BASE_URL` change
that), regenerates the locale pages first, and generates random local secrets once into `.wrangler/dev-secrets.env`
(ignored, never printed). It needs no Cloudflare account. The admin dashboard runs at `http://admin.localhost:4173/`
without Access and with sample statistics ([admin host](docs/OPERATIONS.md#admin-host-and-statistics)). Point the CLI
at its upload endpoint with `FYL_API_URL=http://127.0.0.1:4173/api/upload fyl ./file` (an installed `fyl`, or `dist/cli/<version>/fyl-<os>-<arch>`). The report form works without Turnstile locally (readiness
says `incomplete`).

`.env.example` lists the variables the operator scripts and wrangler read against a real deployment; you don't need
any of them for development. Never commit a value.

## Check a change

```bash
npm run ci          # lint, type check, Worker tests, Python tests, build dry run
```

`npm run ci` is what `Checks` runs on every pull request, and it must pass before a merge. Its parts:

| Command | What it does |
| --- | --- |
| `npm run lint` | Biome over the TypeScript and JavaScript (lint only, no formatter) |
| `npm run check` | `tsc` for `src/` and `tests/` |
| `npm test` | Vitest: the Worker tests in the Workers runtime with real local R2 and SQLite Durable Objects, and the browser code against a scripted page |
| `npm run test:cli` | The Python tests (`tests/test_*.py`) in parallel (`scripts/test_py.py`, about 45 s); `npm run test:cli -- test_cli` runs one module |
| `npm run build` | The CLI index, the minified assets and a `wrangler deploy --dry-run` |

Not part of `npm run ci`:

- `npm run test:rust` runs `cargo test --locked` in `cli-rs/` with the pinned toolchain. `Checks` runs it, with
  clippy (`-D warnings`), a RustSec audit and a byte-for-byte rebuild of the binaries, in its native job whenever
  `cli-rs/`, its build inputs or `tests/vectors/` change, and weekly. Run it whenever you touch the CLI.
- `FYL_BENCH=1 npx vitest run e2ee-core` runs the E2EE throughput benchmark (skipped otherwise).
- `Checks` also runs `npx wrangler types --check`, ruff, shellcheck at warning level, actionlint, gitleaks and the
  published-CLI check (`scripts/cli_published.sh`).

A single Vitest file: `npx vitest run tests/web-app.test.ts`. A single Python test:
`cd tests && python3 -m unittest -v test_cli.NativeClientTests.test_version_and_help`.

### Test layout

Worker and browser tests (Vitest, `tests/*.test.ts`):

- Shared helpers: `tests/helpers.ts` (requests against the Worker, uploads, operator calls through the admin host),
  `tests/sealed.ts` (encrypted uploads made with the browser core), `tests/fake-dom.ts` and `tests/fake-api.ts` (the
  scripted page the site's scripts run against), `tests/english.ts` (the English catalog).
- Every Worker test file that uses `tests/helpers.ts` calls `useNetworkPrefix('<range>.')` with a client address range
  no other file uses, so rate limits and budgets of one file never reach another; `vitest.config.ts` refuses to start
  otherwise.
- By area: upload and storage (`data-path`, `transfer-lifecycle`, `transfer-structure`, `budget`,
  `concurrency-races`, `resume-token`, `receipts`), downloads (`download-routing`, `download-page`, `one-time-pause`,
  `embedding`), encryption (`e2ee-core`, `e2ee-server`, `web-e2ee`), the site (`web-app`, `web-client`, `web-pages`,
  `page-contract`, `i18n`, `brand`, `llms`, `folder-zip`, `web-md5`), operations (`admin-host`, `access`, `reports`,
  `report-host`, `turnstile`, `metrics`, `page-views`, `billing`, `cli-index`), and `worker` and `shipped` (the
  minified build).
- A test file that imports a minified file from `dist/` runs twice: once against `dist/` and once in the `shipped`
  project against `.build/assets`. Don't test minified files by their source text.

Python tests (`tests/test_*.py`, unittest):

- Shared: `tests/native.py` (setup, the native binary, the E2EE size rules), `tests/fake_server.py` (a scripted fyl.at
  for the CLI) and `tests/fake_operator.py` (a scripted admin host).
- `test_cli` (the CLI against the fake server), `test_local_worker` (the CLI against a real local Worker),
  `test_folder_zip` (the folder-zip reference and vectors), `test_installer`, `test_release` and `test_workflows` (the
  installer, the release scripts and the workflow files), `test_admin`, `test_smoke`, `test_rollback` and
  `test_monitor` (the operator scripts).

Shared vectors in `tests/vectors/` (error classes, receipts, passwords, risky extensions, `e2ee/`, `folder-zip/`) are
read by the server, browser and Rust tests alike: change them together, and regenerate `e2ee/` only with
`scripts/e2ee_vectors.py` and `folder-zip/` only with `scripts/folder_zip.py`.

## Rules that must hold

**Customers stay anonymous.**

- Keep upload and download flows anonymous and usable without a browser. Do not add accounts, browser challenges,
  Access or Turnstile to machine-client routes. Turnstile guards only the report form (`POST /api/reports`), on only
  while the `TURNSTILE_SITE_KEY` var and the `TURNSTILE_SECRET` secret are both set, and fails closed (503) when
  siteverify gives no usable answer.
- The User-Agent never grants access. Its only uses: known link-preview bots (`PREVIEW_BOTS` in `src/index.ts`) get
  the download page instead of the file and are the only clients of the image preview route; `/cli/version.json`
  offers CLIs of the old numbering the bridge ([version scheme](docs/ARCHITECTURE.md#version-scheme)); and
  `download_started` and `page_view` count the kind of client (statistics only). Never classify statistics by a file
  name, a size or an address.

**Keys, passwords and links.**

- Do not log or commit file keys, management links or credentials. Upload keys travel only in `Authorization` headers
  or JSON bodies, never in URLs.
- Download passwords are access control, not encryption. Store only the PBKDF2 hash (`passwordRecord()`), never the
  password, not in logs or metrics either; keep a protected file's name out of its link, page, preview tags and public
  metadata until unlocked; keep tries counted per network and transfer in the Durable Object.
- Worker-issued values (grants, password fingerprints) are signed with `sign()`, a purpose prefix and
  `GRANT_SIGNING_KEY`; `NETWORK_HASH_KEY` only keys network hashes. There is no fallback key: a missing secret answers
  503 `misconfigured`, and tests and `npm run dev` set every secret explicitly.
- A resume token only continues, completes or cancels an upload. It must never reach `/api/transfers/:id` (delete,
  expiry, pause lift) or a receipt's `managementUrl`/`deleteToken`; those need the management key.
- An operator takedown (`removed`) is final and kept for good: no sender, alarm, cleanup or purge path may change that
  status or drop the record, because a client can derive the same transfer id again. A quarantine blocks every way to
  the file but never extends its lifetime, and the sender can still delete it.
- Keep R2 private, API and download responses uncached, management capabilities separate from public links, and the
  attachment filename headers intact.

**Pages.**

- `/d/` pages come from `dist/<lang>/download.html` (generated from `i18n/templates/download.html`), filled in by the
  Worker through `<html data-state>`, the `#fyl-state` JSON block and the Open Graph tags. A page never counts a
  download, opens a one-time session, sends `WWW-Authenticate` or shows a protected file's name. In-app links that
  should download directly use `?dl=1`.
- No inline scripts or styles. The Worker sets every page's CSP (`pagePolicy()` in `src/index.ts`): scripts and
  workers only from fyl's own script paths, never `'self'`, which would admit Cloudflare's `/cdn-cgi/` scripts; the
  report form, served only on `REPORT_HOST`, also allows `https://challenges.cloudflare.com`. `dist/_headers` keeps
  the `'self'` policy for every other file. Every module and worker the download and upload pages load lives under
  `/e2ee/` or `/vendor/`, which the policy names (`tests/e2ee-server.test.ts` walks the imports against it).
- Every element whose text can hold an E2EE key or a decrypted name has `translate="no"`
  ([E2EE.md §9.5](docs/E2EE.md#95-page-rules)). File responses keep `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` and the hotlink check.
- `dist/e2ee/`, `download.js`, `i18n.js`, `dist/_dl/` and `dist/vendor/` ship as written (`KEPT` in
  `scripts/minify_assets.mjs`): they are the code anyone can check against what fyl.at serves, so keep them readable
  and out of the minifier ([static assets](docs/OPERATIONS.md#static-assets)).
- Files under `dist/fonts/`, `dist/vendor/` and `dist/cli/<version>/` are served as immutable for a year: give a
  changed file a new name. The download page's code revalidates on every load instead (`no-cache` in `dist/_headers`).
- The frontend is live-only (no demo mode). Colours come from the tokens at the top of `dist/styles.css`; keep the
  light and dark themes in sync ([DESIGN.md](DESIGN.md)).

**Data and configuration.**

- Sizes are binary (1 GB = 1024³ bytes). File size, byte budgets, admission counts and the daily report cap are
  `wrangler.jsonc` vars, rate limits its `ratelimits`, not code; protocol constants live in `src/shared.ts`,
  `src/transfer.ts`, `src/index.ts` and `src/reports.ts` ([where each limit lives](docs/ARCHITECTURE.md#limits-and-retention)).
  The billing estimate's prices in `src/billing.ts` and [docs/COSTS.md](docs/COSTS.md) change together.
- Never rename or delete the `Transfer`, `Budget` or `Reports` exports or namespaces. Preserve live data and schema
  compatibility: migrations are additive (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`), and older record
  shapes keep working until their entry in [compatibility code](docs/ARCHITECTURE.md#compatibility-code) says
  otherwise.
- Metrics go through `metric()` in `src/shared.ts` with a fixed event name, a code and a number only, never addresses,
  network hashes, ids, keys, file names or User-Agents. Add new events to [docs/METRICS.md](docs/METRICS.md).
  `page_view` is the one event with more dimensions, all coarse: never add anything that identifies a visitor, a file
  or a link, and update the privacy page with any change.
- The admin host is behind Cloudflare Access and the Worker verifies the Access JWT (`accessOf()` in `src/access.ts`)
  before anything else there. The dashboard (`dist/admin/`) stays token-free and read-only; every state-changing
  operator route keeps requiring `ADMIN_TOKEN`. `DEV_ACCESS_BYPASS` and `DEV_FAKE_STATS` exist for `npm run dev` only.
- After changing bindings, vars, the compatibility date or wrangler, regenerate `worker-configuration.d.ts` with
  `npm run typegen` in a checkout without `.env` or `.dev.vars`, whose secret names would change the hash.

**Style.**

- Linters run without formatters, so the dense existing style stays: Biome for TypeScript and JavaScript, ruff
  (`ruff.toml`) for Python, shellcheck for the installer and shell scripts, clippy for the Rust CLI. rustfmt is not
  enforced: reformatting the CLI would change line numbers inside the released binaries.
- Comments say why, not what. Code, comments, docs and UI text are English.

## Languages

The public pages exist in English, German, Spanish, French and Dutch. Every user-facing string of the public site is a
key in the catalogs `i18n/<lang>.json`; the API, the CLI, `llms.txt` and the dashboard stay English.

1. Edit `i18n/templates/*.html` and `i18n/en.json`, never `dist/<lang>/` (it is generated and committed).
2. Add every new or changed key to all five catalogs (`de`, `en`, `es`, `fr`, `nl`), following the rules and glossary in
   [i18n/README.md](i18n/README.md).
3. `npm run build:i18n`, then commit the regenerated `dist/<lang>/*.html` and `dist/sitemap.xml`.
   `node scripts/build_i18n.mjs --check` lists every problem without writing; `tests/i18n.test.ts` fails while a
   catalog misses a key or a generated page is stale.

## Commits and pull requests

- Work on a branch and open a pull request against `main`. Keep commits small and clear; the subject says what changes
  in plain words ("Download page: the key field keeps focus after a wrong key"), the body says why when it isn't
  obvious.
- Run `npm run ci` (and `npm run test:rust` for CLI changes) before you push. Update the docs and `CHANGELOG.md` in the
  same pull request when behaviour changes.
- Merging into `main` is a production deploy: a green `Checks` run moves the `production` branch, and Cloudflare
  Workers Builds deploys only `production` ([deploy gate](docs/OPERATIONS.md#the-deploy-gate)). Pull requests from
  forks run `Checks` without the repository's secrets.

## Releases

Versions start at 1.0.0 and never reuse 2.0.0 to 2.5.1 ([version scheme](docs/ARCHITECTURE.md#version-scheme)). A
release bumps the version in `package.json`, `package-lock.json`, `cli-rs/Cargo.toml`, `cli-rs/Cargo.lock` and the
smoke User-Agent in `scripts/smoke.py`, rebuilds the CLI (`npm run build:native`, committed), and adds a
`## <version> — <date>` section to `CHANGELOG.md`, which becomes the GitHub release's notes. A published
`dist/cli/<version>/` never changes. The steps are in [OPERATIONS.md](docs/OPERATIONS.md#release).

## License

fyl.at is free software under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). By contributing
you agree that your contribution is licensed under the same terms. If you run a modified version as a network service,
the AGPL asks you to offer its users the corresponding source. Vendored code, fonts and test vectors keep their own
licenses ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
