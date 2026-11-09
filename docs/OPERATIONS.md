# fyl.at operations

How fyl.at runs on Cloudflare and how the operator works it: resources, deploys and releases, secrets, the monitor,
the admin host, reports and incidents. Account-specific identifiers appear as placeholders (`<account-id>`,
`<zone-id>`, `<namespace-id>`, `<policy-id>`, `<ruleset-id>`); the ones the Worker needs (account id, Access team and
AUD, Turnstile site key) are committed in `wrangler.jsonc`, and none of them is a credential. How the service is built
is in [ARCHITECTURE.md](ARCHITECTURE.md), the protocol in [CLI-API.md](CLI-API.md).

## Resources

| Resource | Configuration |
| --- | --- |
| Worker | `fyl-at`; `src/index.ts`; compatibility date in `wrangler.jsonc`; `nodejs_compat` |
| Domains | `fyl.at`, `admin.fyl.at` (the admin host, behind Cloudflare Access) and `report.fyl.at` (the report form, [Turnstile](#turnstile)), custom domains on `fyl-at` (`routes` in `wrangler.jsonc`; the deploy creates their DNS records); workers.dev and preview URLs disabled, so every request goes through a configured domain and its policies |
| Static assets | `dist/`, deployed as `.build/assets` with the site's own scripts and stylesheets minified ([below](#static-assets)), `ASSETS` binding; every request runs the Worker first (`run_worker_first: true`), so the admin host checks Cloudflare Access before any file and `/admin`, `/admin/*` (the dashboard, served on the admin host only) never leave on `fyl.at`; on `fyl.at` the Worker answers `/api/*`, `/d/*` and `/config.js`, sets the Content-Security-Policy of the pages (scripts and workers from fyl's own paths only; [E2EE](#end-to-end-encryption)), answers `/report` with a 302 to `report.fyl.at`, counts the page views and hands every other path to the asset binding; `dist/_headers` sets the policy of every other file and the cache rules; `dist/llms.txt` tells agents how to use the site and is served as `text/markdown` |
| R2 | `fyl-at-files`, binding `FILES`, Standard, location hint WEUR, private ([below](#r2-bucket)) |
| Durable Objects (SQLite) | `Transfer` (binding `TRANSFERS`, one object per transfer), `Budget` (binding `BUDGET`, object `admission-v1`), `Reports` (binding `REPORTS`, object `reports-v1`); exports declared in `wrangler.jsonc`, namespaces (`<namespace-id>`) created by the deploy |
| Metrics | Workers Analytics Engine dataset `fyl_events`, binding `METRICS`; event names, codes, numbers and coarse dimensions only, kept three months ([METRICS.md](METRICS.md)) |
| Version metadata | binding `CF_VERSION_METADATA`: readiness's `version` (the live deploy's tag and upload time), shown in the dashboard's status strip |
| Logs | Workers observability on, 10 % head sampling, query strings redacted, invocation logs off (they record every path, which can hold a raw file's name or a key pasted into the path); application logs carry no keys or URLs |
| Secrets | [Secrets and rotation](#secrets-and-rotation) |
| Plan | Workers Paid: Free's 10 ms CPU limit and daily request caps are too small for 50 GB uploads |

`wrangler deploy` handles code, assets, vars, rate-limit bindings, the Durable Object exports and the custom domains.
The bucket's lifecycle rules, TLS and the zone's firewall, cache and notification settings are separate resources that
a deploy keeps. Keep `wrangler.jsonc` the source of truth for bindings, vars, limits, exports and domains. Never rename
or delete the `Transfer`, `Budget` or `Reports` exports, replace their namespaces, or clear live SQL state in an
ordinary update.

### Vars

| Var | Value | Meaning |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://fyl.at` | Base of every link the Worker builds |
| `MAX_FILE_BYTES` | 53687091200 (50 GB) | Largest file |
| `MAX_STORED_BYTES` | 5497558138880 (5 TB) | Stored payload, copies and reserved bytes of all uploads not yet cleaned up |
| `MAX_DAILY_UPLOAD_BYTES` | 1099511627776 (1 TB) | Confirmed and reserved part bytes per UTC day, whole service |
| `MAX_ACTIVE_UPLOADS` | 100000 | Uploads not yet released after cleanup, whole service |
| `MAX_DAILY_UPLOADS` | 50000 | Uploads admitted per UTC day, whole service |
| `MAX_DAILY_UPLOADS_PER_NETWORK` | 500 | Uploads admitted per network and UTC day |
| `MAX_DAILY_UPLOAD_BYTES_PER_NETWORK` | 268435456000 (250 GB) | Part bytes per sending network and UTC day |
| `MAX_ACTIVE_UPLOADS_PER_NETWORK` | 50 | Running (unfinished) uploads per network |
| `MAX_STORED_BYTES_PER_NETWORK` | 268435456000 (250 GB) | Stored bytes per network that started the uploads |
| `MAX_DAILY_REPORTS_PER_NETWORK` | 50 | Report cases per network and UTC day |
| `TURNSTILE_SITE_KEY` | the widget's public site key | The report form's Turnstile widget; the check is on only with the secret `TURNSTILE_SECRET` set too ([Turnstile](#turnstile)) |
| `E2EE_ENABLED` | `"true"` | Whether new end-to-end encrypted uploads are taken; an emergency switch ([E2EE](#end-to-end-encryption)) |
| `ADMIN_HOST` | `admin.fyl.at` | The admin host: every request to it needs a valid Cloudflare Access token ([admin host](#admin-host-and-statistics)) |
| `REPORT_HOST` | `report.fyl.at` | The report form's own host; empty keeps the form on the public host (development) ([Turnstile](#turnstile)) |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | Zero Trust team: issuer and signing keys of the Access tokens |
| `ACCESS_AUD` | the Access app's AUD tag | Audience the Worker requires in Access tokens on the admin host |
| `ANALYTICS_ACCOUNT_ID` | `<account-id>` | Account whose Analytics Engine SQL API the statistics query, and whose GraphQL analytics the billing estimate reads |
| `BILLING_CYCLE_DAY` | `"28"` | Day of the month (1 to 31, UTC) the Cloudflare billing cycle starts, for the dashboard's estimate of the open bill; 29 to 31 count as the last day of a shorter month. Check the day on the Cloudflare billing page if the estimate's period looks off |

The operator identities (`ADMIN_EMAILS`) are a Worker secret, not a var ([secrets](#secrets-and-rotation)). Sizes are
binary (1 GB = 1024³ bytes); how each cap is counted is in [budget semantics](ARCHITECTURE.md#budget-semantics). After
changing a var, regenerate `worker-configuration.d.ts` with `npm run typegen` in a checkout without `.env` or
`.dev.vars` (their secret names change the hash; `Checks` runs `npx wrangler types --check`).

### Rate limits

Native limits count per network (an IPv4 address or an IPv6 /64) and Cloudflare location, set in `ratelimits` in
`wrangler.jsonc`. This is the one route-to-limit mapping:

| Limit | Per minute | Routes |
| --- | ---: | --- |
| `INIT_RATE` | 30 | `POST /api/upload/init` |
| `PART_RATE` | 600 | `/api/upload/part`, `/api/upload/status`, `/api/upload/complete`, `/api/upload/abort` |
| `DOWNLOAD_RATE` | 300 | every `/d/` request (any method, the unlock form, the image preview and malformed ids included, before the id is checked), and `/api/transfers/:id` with an `Authorization` header or another method than GET (owner GET, PATCH, DELETE) |
| `STATUS_RATE` | 120 | `GET /api/transfers/:id` without `Authorization` (download pages polling an upload or a countdown) |
| `REPORT_RATE` | 5 | `POST /api/reports` |
| `ADMIN_RATE` | 10 | `/api/admin/…` (both hosts), `/api/stats` and `/api/billing`, before the token check; the operator's Access sign-in reading the dashboard's data on the admin host skips it |

`/api/health`, `/config.js` and static assets have no Worker rate limit. Parts allow roughly 500 MB/s per network
with four parallel uploads (the CLI allows up to eight); downloads leave room for multi-connection download managers.
A refusal answers 429 `rate_limited` and counts `rate_limited` with the limit's name. A per-location rate limit is not
a global cap: the Budget enforces the byte and upload caps and the Reports object the daily report cap across
locations.

## Deploy, release and rollback

### The deploy gate

```text
pull request ─ merge ─▶ main ─ Checks (GitHub) green ─▶ Deploy gate fast-forwards production ─▶ Workers Builds deploys production
```

- `.github/workflows/deploy.yml` (Deploy gate) runs when `Checks` completes on a push to `main` in this repository.
  Only on success, and only while `main` still points at that commit, `scripts/promote.sh` fast-forwards `production`
  to it (never `--force`; it skips when production already contains it and creates the branch if it is missing).
- It pushes over SSH with the repository secret `FYL_DEPLOY_KEY`, the private half of the repository's write deploy
  key "Deploy gate"; the `production` ruleset lets deploy keys through and everyone else but admins not. `GITHUB_TOKEN`
  can't be used: GitHub refuses it any branch update that brings in changes to `.github/workflows/`. A deploy key
  reaches this repository only and doesn't expire. Without the secret the run fails with a clear message and
  production stays where it is.
- **Never push to `production` by hand.** A commit on production that isn't on main makes every later fast-forward
  fail. The one safe manual recovery is pushing a commit that main already has:
  `git push origin <main-sha>:refs/heads/production`.
- Cloudflare Workers Builds (Cloudflare GitHub App) is attached to the `fyl-at` Worker and builds only `production`:

| Setting | Value |
| --- | --- |
| Production branch | `production` (non-production branch builds stay disabled, so branches never reach production storage) |
| Build command | `npm run check` (a type check, build cache on: `production` only receives commits whose `Checks` run, the full `npm run ci`, passed on `main`) |
| Deploy command | `npm run deploy` |
| Root directory | `/` |
| Build variables | `NODE_VERSION=24`, `PYTHON_VERSION=3.12` |
| API token | Created and stored by Cloudflare; not in Git |

`npm run deploy` regenerates the CLI index, builds `.build/assets` ([static assets](#static-assets)), runs
`scripts/check_secrets.mjs`, then `wrangler deploy --assets .build/assets --tag v<version> --message "fyl <version>"`,
then `python3 scripts/smoke.py --pages`. `check_secrets.mjs` refuses the deploy when `NETWORK_HASH_KEY`,
`GRANT_SIGNING_KEY` or `ADMIN_TOKEN` is missing or a development-only secret (`DEV_ACCESS_BYPASS`, `DEV_FAKE_STATS`)
is set; it warns when `MONITOR_TOKEN`, `CF_ANALYTICS_TOKEN` or `ADMIN_EMAILS` is missing or
`GRANT_SIGNING_KEY_PREVIOUS` is still set, and only warns if the listing itself fails. It prints names, never values.
`smoke.py --pages` checks health and every page's Content-Security-Policy and scripts on https://fyl.at and the form
on https://report.fyl.at (scripts and workers only from fyl's own paths, no script a zone feature injected, the
download page's code revalidating), and that every file the build keeps as written is served byte for byte as in
`dist/`, printing their `SHA256SUMS` into the build log. It needs no uploads or credentials and tries seven times 10 s
apart while the version spreads, a network error included. Its failure turns the build red after the new version is
live: look at it at once, and run the same command from a checkout to see whether production or the build machine's
view is wrong. Each build posts a `Workers Builds: fyl-at` check on the commit; its log should say "Worker secrets
present". Always deploy through `npm run deploy`: an untagged version is never a rollback target.

A manual deploy needs a scoped `CLOUDFLARE_API_TOKEN` in the ignored `.env` and should stay an exception, since
production then serves something the branch doesn't show: `npm ci && npm run ci && npm run deploy`.

### Release

Versions follow the [version scheme](ARCHITECTURE.md#version-scheme): the numbering started at 1.0.0 with the public
release, and 2.0.0 to 2.5.1 are never used again.

1. Update the version in `package.json` and the lockfile, `cli-rs/Cargo.toml` and `cli-rs/Cargo.lock`
   (`cargo update --workspace --offline` in `cli-rs/`), and the smoke User-Agent in `scripts/smoke.py`.
2. `npm run build:native` builds the binaries into `dist/cli/<version>/` and keeps the previous version's folder (an
   installer that read an older `/cli/latest` still finds its files); `build_cli.py` writes `SHA256SUMS`,
   `dist/cli/latest` and `dist/cli/version.json`, and `scripts/cli_licenses.py` the license texts of the linked
   crates, `cli-rs/THIRD-PARTY-LICENSES.txt`.
3. Add the `## <version> — <date>` section to `CHANGELOG.md`, open a pull request and merge it once `Checks` passes.
4. The Deploy gate moves production; Workers Builds deploys it. `.github/workflows/release.yml` then runs
   `scripts/release.sh`: only for the commit production has, it waits until `https://fyl.at/cli/latest` serves the new
   version (60 tries, 20 s apart) and publishes the GitHub release `v<version>` with the four binaries and
   `SHA256SUMS`, its notes being only that version's CHANGELOG section (`scripts/release_notes.py`). An existing
   release must carry exactly the committed `SHA256SUMS`; it is never overwritten.
5. Check that `/cli/latest` and `/cli/<version>/SHA256SUMS` match the release assets, run `npm run admin -- ready` and
   `npm run smoke` (`-- --multipart` after any change to the upload or download path).

Published CLI files never change: once production has `dist/cli/<version>/`, `Checks` fails on any change in that
folder (`scripts/cli_published.sh`), so a rebuild needs a version bump. The native job of `Checks` (RustSec audit,
clippy, `cargo test`, reproducible rebuild compared byte for byte) runs when the CLI, its build inputs or
`tests/vectors/` changed since what production has (`scripts/cli_changed.sh`), and weekly. The Release workflow hangs off the Deploy gate
through `workflow_run`, which GitHub allows to chain only three levels deep: keep further automation out of that chain.

Dependabot (`.github/dependabot.yml`) opens weekly update PRs for npm, Cargo (`cli-rs/`) and GitHub Actions (minor and
patch grouped per ecosystem, majors separately, versions at least 14 days old). They go through `Checks` like any PR,
and merging one deploys; a Cargo update changes the CLI, so it needs a version bump, `npm run build:native` and `python3 scripts/cli_licenses.py` (the license texts of the linked crates; the native job checks them).

### Rollback

Fix forward by default. `npm run rollback` (`scripts/rollback.py`) lists the Worker's recent versions with their tags
and marks which are targets:

```bash
npm run rollback                                   # versions, tags, which are targets
npm run rollback -- <version-id>                   # what a rollback would do; changes nothing
npm run rollback -- <version-id> --yes [--message TEXT]
npm run admin -- reconcile                         # right after a rollback, and again after the fix-forward deploy
```

- Only versions tagged `v1.0.0` or later are targets (`ROLLBACK_FLOOR`). Untagged versions (secret or dashboard
  changes, uploads) are refused, and so is every version tagged in the old numbering (`v2.0.0` to `v2.5.1`,
  `OLD_NUMBERING`), which came before 1.0.0 whatever its number says. The first possible target is the `v1.0.0`
  version itself, once something newer serves.
- A tagged version that provably never served traffic (uploaded, in none of the listed deployments) also needs
  `--accept-caveats`; so does any target that the script's `CAVEATS` list applies to.
- The target runs with the secret values it was deployed with: set any secret rotated since then again afterwards.
- Rollback restores no deleted R2 object and undoes no zone policy. Raise the floor when a release makes older
  versions unsafe. In an E2EE incident switch encryption off first ([E2EE](#end-to-end-encryption)).

## Secrets and rotation

All Worker secrets except `TURNSTILE_SECRET` and `ADMIN_EMAILS` need at least 32 characters; a shorter one counts as
missing. Generate them with `openssl rand -base64 48` (64 characters). Never print, log or commit a value;
`npx wrangler secret list` shows the names. `.env.example` lists the names the operator scripts and wrangler read.

| Secret | Where | Used for | Without it |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | Worker; `FYL_ADMIN_TOKEN` in the ignored local `.env` | Operator API (compared as a hash in constant time) | `/api/admin/*` answers 404 (readiness answers to `MONITOR_TOKEN` alone) |
| `NETWORK_HASH_KEY` | Worker only | HMAC of client networks for budgets, one-time sessions, password tries and reports | Every request that needs a network hash (downloads, uploads, reports) answers 503 `misconfigured`; one shorter than 32 characters still hashes, but readiness reports it missing |
| `GRANT_SIGNING_KEY` | Worker only | Signs download grants (`fyl-grant:`) and the password part of init fingerprints (`fyl-password:`) | Password uploads and the unlock form answer 503 `misconfigured`, no grant passes; HTTP Basic downloads still work |
| `GRANT_SIGNING_KEY_PREVIOUS`, `GRANT_SIGNING_KEY_ROTATED_AT` | Worker, only while rotating | The previous key passes grants that expire within an hour (and a minute) of the rotation time | Nothing: they are optional |
| `MONITOR_TOKEN` | Worker and GitHub repository secret, same value | Read-only: `GET /api/admin/ready` and, on the admin host, `GET /api/billing` only | The Monitor workflow fails ([monitor](#monitor)) |
| `ADMIN_EMAILS` | Worker only | The operator's Access identities (comma-separated e-mail addresses) that read the dashboard's data without the operator token | Fails closed: no identity is the operator, so the dashboard's reads answer 401 in the browser; the service token and operator token still work; `npm run deploy` warns |
| `TURNSTILE_SECRET` | Worker only | Siteverify of the report form's Turnstile token; on only together with the `TURNSTILE_SITE_KEY` var | The report form works without the check and loads nothing from Cloudflare, readiness shows `turnstile: incomplete`. A value Cloudflare rejects: reports answer 503 `misconfigured` |
| `CF_ANALYTICS_TOKEN` | Worker only (optional) | Read-only API token (Account Analytics Read) for the admin host's statistics and billing estimate ([how to create it](#admin-host-and-statistics)) | `/api/stats` answers 503 `stats_unconfigured`, `/api/billing` 503 `billing_unconfigured`, so the Monitor workflow fails on its billing check; `npm run deploy` warns. Expired, revoked or without the permission: 503 `billing_refused` |
| `FYL_DEPLOY_KEY` | GitHub repository secret (private key of the write deploy key "Deploy gate") | Deploy gate pushes `production` | The Deploy gate fails and production stays put |
| `FYL_ACCESS_CLIENT_ID`, `FYL_ACCESS_CLIENT_SECRET` | Ignored local `.env` and GitHub repository secrets; not on the Worker | The Cloudflare Access service token (the app's non-identity policy) that lets `npm run admin`, the monitor and the smoke test through to `admin.fyl.at`; its expiry is `TOKEN_EXPIRES` in `scripts/monitor.py` | Those tools stop at Access ("Cloudflare Access refused"); the public site is not affected |

Rotation (each `wrangler secret put` deploys a new version at once):

- `ADMIN_TOKEN`: `token="$(openssl rand -base64 48)"`, `printf '%s' "$token" | npx wrangler secret put ADMIN_TOKEN`,
  then put the same value into `FYL_ADMIN_TOKEN` in `.env` and `unset token`. No effect on users.
- `MONITOR_TOKEN`: the same way, putting one value on the Worker and with `printf '%s' "$token" | gh secret set MONITOR_TOKEN`;
  the monitor fails until both match.
- `GRANT_SIGNING_KEY`: (1) if you still have the current value, `printf '%s' "$old" | npx wrangler secret put GRANT_SIGNING_KEY_PREVIOUS`;
  (2) `openssl rand -base64 48 | npx wrangler secret put GRANT_SIGNING_KEY`;
  (3) `date -u +%Y-%m-%dT%H:%M:%SZ | npx wrangler secret put GRANT_SIGNING_KEY_ROTATED_AT`; (4) an hour later
  `npx wrangler secret delete GRANT_SIGNING_KEY_PREVIOUS` and `… GRANT_SIGNING_KEY_ROTATED_AT`. Readiness fails from
  step 1 until step 3. The previous key passes only grants it signed before the rotation, so even a leaked previous
  key mints nothing usable an hour later. Readiness (`checks.rotation`) and therefore the monitor fail while the
  previous key is still set more than an hour and a minute after `ROTATED_AT`, or set without it. Without step 1,
  unexpired grants stop working and recipients type the password again; an init retry of a protected upload across
  the rotation gets 409.
- `NETWORK_HASH_KEY`: `openssl rand -base64 48 | npx wrangler secret put NETWORK_HASH_KEY`. Every network gets new
  hashes: today's per-network counts, password tries and report counts start over, the per-network stored bytes of
  running and stored uploads stay with the old hash (the cap effectively restarts for up to 8 days), and open one-time
  download sessions can't be continued (the same network now looks like another one, which gets 410 `consumed`).
- `ADMIN_EMAILS`: `npx wrangler secret put ADMIN_EMAILS` and type the addresses. Secrets survive later deploys.
- `FYL_DEPLOY_KEY`: `ssh-keygen -t ed25519 -N '' -f deploy`, add `deploy.pub` as a write deploy key
  (`gh repo deploy-key add deploy.pub --allow-write --title "Deploy gate"`), `gh secret set FYL_DEPLOY_KEY < deploy`,
  delete both files and the old key.
- `CF_ANALYTICS_TOKEN`: create a new read-only token as in [admin host and statistics](#admin-host-and-statistics),
  `npx wrangler secret put CF_ANALYTICS_TOKEN`, then delete the old token. The dashboard keeps working throughout.
- Access service token, before it expires: in Zero Trust → Access → Service credentials → Service Tokens either
  refresh the token in place (it keeps its credentials and gets a new expiry), or create a new one, add it to the
  app's service-token policy, replace both values in `.env` and with `gh secret set FYL_ACCESS_CLIENT_ID` /
  `gh secret set FYL_ACCESS_CLIENT_SECRET`, and delete the old token. Then run Actions → Monitor once and update
  `TOKEN_EXPIRES` in `scripts/monitor.py`.
- `TURNSTILE_SECRET`: rotate the widget's secret key in the Cloudflare dashboard (Turnstile), then
  `npx wrangler secret put TURNSTILE_SECRET` and paste the new key. A new site key goes into `wrangler.jsonc` and is
  deployed like code.

**Moving `ADMIN_EMAILS` from a var to the secret** (once, for a Worker deployed with `ADMIN_EMAILS` in `vars`).
wrangler refuses `wrangler secret put NAME` while the deployed Worker has a plain var of that name, so the order is
fixed:

1. Deploy the release that drops the var (the normal flow, or `npm run deploy`). The deploy prints
   "Warning: ADMIN_EMAILS is not set". Until step 2 the operator's browser sign-in reads nothing on the dashboard
   (`/api/admin/ready`, `/api/admin/uploads`, `/api/admin/reports`, `/api/stats` and `/api/billing` answer 401 there),
   because `src/access.ts` fails closed; the operator token with the service token (`npm run admin`), the monitor and
   the public site keep working. Do it in a quiet window and run step 2 right after.
2. `npx wrangler secret put ADMIN_EMAILS` and type the address (comma-separated for several). No redeploy is needed:
   the secret put creates a new version itself.
3. Verify: `npx wrangler secret list` names `ADMIN_EMAILS`; the dashboard on `https://admin.fyl.at` shows readiness,
   uploads and reports in the operator's browser; `npm run admin -- ready` still works; a later `npm run deploy`
   prints no `ADMIN_EMAILS` warning.

## Turnstile

Cloudflare Turnstile guards the report form, and nothing else. It is on only while the var `TURNSTILE_SITE_KEY` and
the Worker secret `TURNSTILE_SECRET` are both set; readiness shows `turnstile`: `on`, `off` or `incomplete` (only one
of them set: the form then works without the check). Protocol and error codes: [reports](CLI-API.md#turnstile).

- **Widget:** in the Cloudflare dashboard under Turnstile, Managed mode; it must list the hostname `report.fyl.at`
  (the Worker accepts only tokens solved on `REPORT_HOST`, or on `PUBLIC_BASE_URL`'s host when `REPORT_HOST` is empty,
  for the action `report`). Its site key is public and committed as the `TURNSTILE_SITE_KEY` var in `wrangler.jsonc`;
  change it only there, because a deploy replaces vars set in the dashboard. Its secret key is the Worker secret. Never
  use one of Cloudflare's test keys in production: the Worker skips the host and action checks for test-key answers,
  and readiness would still show `on`.
- **Check:** `npm run admin -- ready` prints `turnstile: on`. `/config.js` then carries `turnstileSiteKey`, and
  `https://report.fyl.at/` shows the widget above *Send report*. The monitor doesn't look at `turnstile`.
- **CSP and origin:** the form lives on its own host `report.fyl.at` (var `REPORT_HOST`, a custom domain of the same
  Worker), which serves only the form, its files, `/config.js` and `POST /api/reports`; `fyl.at/report` answers 302 to
  it with the query kept. Its policy is the pages' policy plus `https://challenges.cloudflare.com` for scripts and
  frames; no page on `fyl.at` allows another origin, so Turnstile's script never runs with the origin where the upload
  page may remember encryption keys ([E2EE](#end-to-end-encryption)).
- **Fails closed:** when siteverify can't be reached (10 s timeout) or gives no readable answer, every report gets 503
  `temporarily_unavailable` and `turnstile_failed` counts `unavailable`. If that lasts, switch the check off with
  `npx wrangler secret delete TURNSTILE_SECRET` (readiness: `incomplete`, the form works without the check and loads
  nothing from Cloudflare), and put the secret back once siteverify works. A secret Cloudflare rejects gives 503
  `misconfigured` with the log event `{"event":"misconfigured","missing":"TURNSTILE_SECRET"}`.
- **Data:** the Worker sends Cloudflare the secret, the token and the client's address and stores neither the token nor
  the address; tokens are never logged, and `turnstile_failed` counts the reason only ([metrics](METRICS.md)). The
  privacy page says so.

## End-to-end encryption

Optional end-to-end encryption is offered to everyone ([E2EE.md](E2EE.md)). The service stores ciphertext, a generic
name, the exact size, `head`, `meta` and each part's pinned MD5; it never sees a key unless a user puts one into a path.

- **Emergency switch.** The var `E2EE_ENABLED` gates only new encrypted inits (403 `e2ee_disabled`) and the upload
  page's Encryption option (`/config.js`); running encrypted uploads, existing files and their downloads keep working,
  so switching it off strands nothing. Readiness shows `e2ee: on` or `off` (it changes neither `ready` nor `reasons`).
  To switch it off, change it to `"false"` in `wrangler.jsonc` and merge (the deploy carries it). In an emergency the
  Cloudflare dashboard (Worker → Settings → Variables) switches it at once, but the next deploy from `main` puts back
  what `wrangler.jsonc` says, so commit the same change right away. Switch off first before anything else in an E2EE
  incident.
- **Zone settings the pages rely on** ([E2EE.md §17](E2EE.md#17-release-gating)): HTML-injecting features stay off for
  fyl.at (Bot Fight Mode and JavaScript detections, Rocket Loader, Email Address Obfuscation, Web Analytics
  auto-injection, Zaraz), no WAF or rate-limit rule with a challenge action on `/d/*`, Network Error Logging off (its
  reports carry full URLs), Workers invocation logs off. Cloudflare can inject its Web Analytics beacon for some
  visitors even with the zone's RUM setting off, so a configuration rule "Disable RUM" for all incoming requests stays
  in place. The pages' CSP would block injected `/cdn-cgi/` scripts anyway, and `smoke.py --pages` fails when a zone
  feature injects one. Re-check after zone-wide changes.
- **Reports about encrypted files** ([E2EE.md §15.4](E2EE.md#154-malicious-sender-and-reports)). The operator sees
  ciphertext, a generic name and the size, and can't match re-uploads by content. Judge such reports on plausibility
  (the reporter's description, the category, how the link was spread); quarantine is reversible, so quarantine first
  when in doubt. Never ask a reporter for the key: the form and the API refuse one in the details, the name or the
  email ("Don't paste the key here."). A key that reaches the operator anyway is used only with `fyl download` on an
  isolated machine (no shared folders, nothing synced), never recorded in the case or its notes, and the decrypted
  file is deleted after the decision; the case notes say only what was seen.
- **Signals.** After a deploy and after changes, watch `part_refused` with `part_changed`, `part_corrupt` and
  `head_mismatch` and the `upload_completed` count with code `e2ee` ([metrics](METRICS.md)). A run of `head_mismatch`
  or `part_corrupt` points at a client or storage fault; stopping new encrypted uploads means switching the var off.

## R2 bucket

- `fyl-at-files`: Standard storage class, location hint WEUR, jurisdiction "default". That is a placement hint, not an
  EU-jurisdiction guarantee.
- The r2.dev managed domain is disabled, the bucket has no custom domain and no CORS rules: every read and write goes
  through the Worker.
- Lifecycle rules under `files/`: `fyl-abort-incomplete` aborts incomplete multipart uploads after 2 days,
  `fyl-expiry-backstop` deletes objects after 8 days (Cloudflare's "Default Multipart Abort Rule", 7 days, covers all
  prefixes). The application's 24-hour upload window and its expiry are the real controls; the rules are backstops for
  failed cleanups.
- R2 completes a multipart upload from non-contiguous part numbers, which the part slots rely on.

## TLS, firewall and caching

Zone TLS is Full (strict), minimum TLS 1.2, with Always Use HTTPS and six-month HSTS (no subdomain inclusion or
preload). Browser Integrity Check stays enabled for the website. Bot Fight Mode and JavaScript detections are disabled;
Free-plan Bot Fight Mode does not support route exceptions.

The custom firewall ruleset (`<ruleset-id>`) has the rule `fyl_machine_clients`. It matches host `fyl.at` and paths
starting `/api/`, `/d/` and `/cli/`, and skips only the `bic` and `securityLevel` checks. It does not skip other custom
rules, managed WAF, DDoS protection or rate limits. Do not add a browser challenge, Access application, Turnstile
dependency or User-Agent allowlist to these anonymous service routes. The rule doesn't cover `admin.fyl.at`; if
Browser Integrity Check or the security level ever challenges the operator tools there (they send the service token,
from GitHub's runners too), add that host with `/api/` to the rule: Access still guards it.

The cache ruleset (`<ruleset-id>`) has the rule `fyl_private_no_cache`, which disables caching on `/api/`, `/d/` and
`/config.js` on `fyl.at`. The Worker also sends `no-store` on API responses, downloads and pages; keep both layers, since
a cached one-time download would bypass the access policy. The image preview sends `public, max-age` of at most 300
seconds and never past the expiry, which the cache rule still keeps out of Cloudflare's cache. Static assets stay
cacheable: `/cli/<version>/` files, fonts and the vendored QR and MD5 scripts for a year as immutable, `/cli/latest`,
`/cli/version.json` and `/cli/install` for 60 seconds, `/llms.txt` for an hour. The download page's code revalidates on
every load (`no-cache`): `download.js`, `theme.js`, `e2ee/`, `_dl/` and the vendored ChaCha20-Poly1305
(`vendor/noble-ciphers-2.4.0/`), so a fixed deployment takes effect on the next page load (`dist/_headers`,
[E2EE.md §9.5](E2EE.md#95-page-rules)). Re-check these rules after zone-wide security or cache changes. For an
immediate edge block beyond a takedown, add an exact transfer-path block to the custom firewall ruleset.

## Private controls and retention

Private keys are 32 random bytes, generated by the client (`clientKey`) or the server. Public ids are random too,
unless a client sends its `clientKey` with an `Idempotency-Key`: then the id is derived from both (SHA-256), so an init
retry finds the same transfer. That is why a takedown keeps its record for good. A key authorises one transfer only;
its hash and its resume token's hash are stored in the transfer's Durable Object. Keys never travel in URLs (they go in
`Authorization` headers or JSON bodies); a `key` in the query string authorises nothing (400 without a header key, 403
`denied` next to a wrong one). Never enable raw query or header logging or send management links to analytics.

Client networks are stored only as HMACs keyed with `NETWORK_HASH_KEY`:

| Hash | Of | Kept |
| --- | --- | --- |
| Daily network hash | the network (/56) and the UTC day | on the upload's Budget reservation until 30 days after admission (rows of released uploads), on pending part attempts until they settle, in the per-day network counts for about two days, and in report cases until their deletion |
| Stable network hash | `fyl-live:` and the network (/56) | on the Budget reservations of uploads not yet cleaned up and in the per-network stored sums; dropped with the last of that network's uploads, at most about 8 days after admission |
| Per-transfer hash | the network and the transfer id (/64 for one-time sessions, /56 for password tries) | in the transfer's record and tables; cleanup deletes it with the file |

What cleanup clears and what the tombstone keeps is in [retention](ARCHITECTURE.md#limits-and-retention). Report cases
keep the transfer id, category, details, the reporter's name and email if given, the daily network hash and the
decisions until 183 days after closing. The web client keeps recent uploads with their management links in local
storage (up to 20, each until forgotten or a day after its link expires), passwords and encryption keys only in the
tab's session storage unless the sender ticks "Remember the password on this device" or "Remember keys on this
device", and an interrupted upload with its key (no password, no encryption key) until it finishes, is discarded or
its 24-hour window ends. The CLI keeps no state on disk.

## Static assets

`dist/` is the site's source and what `npm run dev` and the tests serve; its pages `dist/<lang>/*.html` and
`sitemap.xml` are generated from `i18n/` and committed ([languages](ARCHITECTURE.md#languages)). `npm run deploy`
uploads a build of it: `npm run build:assets` regenerates the locale pages (`scripts/build_i18n.mjs`, a no-op when they
are current), then `scripts/minify_assets.mjs` empties `.build/assets` (only that folder), copies `dist/` there and
minifies the site's own scripts and stylesheets with esbuild (a pinned dev dependency), and
`wrangler deploy --assets .build/assets` uploads that folder. `--assets` replaces only the folder: the `ASSETS` binding
and `run_worker_first` still come from `wrangler.jsonc`, `_headers` from the copied files.
`npm run build`, the dry run at the end of `npm run ci`, builds and reads the same folder, so every deploy's path is
tested first. `.build/` is ignored by git, biome and Vitest.

- **Minified:** `app.js`, `api.js`, `report.js`, `theme.js`, `md5-worker.js`, `admin/admin.js`, `styles.css`,
  `download.css` and `admin/admin.css`. Only whitespace and comments go (esbuild's `minifyWhitespace`), never
  identifiers or syntax: an error report still names the function, and pretty-printing a served file gives back the
  source's code rule for rule. `minifySyntax` is off on purpose: it merged rules into selector lists the source doesn't
  have, rewrote values and inlined constants, for 331 bytes of brotli over all nine files. No target is set, so nothing
  is lowered or polyfilled. A new script or stylesheet in `dist/` is minified unless it falls under the next point
  (`KEPT` in the script).
- <a id="kept-as-written"></a>**Kept as written, byte for byte:** `dist/e2ee/` (the E2EE core and its workers),
  `download.js`, `i18n.js` (the download page loads it first), `_dl/sw.js` (the download service worker) and
  `dist/vendor/`. This is the code that sees encryption keys, and it is public: anyone can compare what fyl.at serves
  with `dist/` at the tagged commit. After every deploy `scripts/smoke.py --pages` (and `npm run smoke`) fetches each of
  these files from the live site, fails when one differs from `dist/` by a single byte (naming it), and prints their
  SHA-256 sums in `sha256sum` form to the build log (`served_code()`; the list is `KEPT` of
  `scripts/minify_assets.mjs`, which `tests/test_smoke.py` compares). Everything that isn't JavaScript or CSS is
  copied unchanged as well: HTML, `_headers`, fonts, images and `dist/cli/`.
- **Size:** the nine minified files shrink by about a quarter (with brotli from about 74 to 52 KiB); the script prints
  the table.
- **Tests:** every Vitest file that imports a minified file from `dist/` (found by its imports) runs a second time in
  the `shipped` project, where `../dist/` means `.build/assets`; its global setup (`tests/shipped-setup.mjs`) builds the
  folder first. `tests/shipped.test.ts` checks the build: every file of `dist/` and nothing else, the kept files
  byte-identical, every named function still named, and every script, stylesheet, font, worker and module a page or
  script loads present.

## Monitor

`.github/workflows/monitor.yml` runs hourly (minute 17) and on demand ("Run workflow"). `scripts/monitor.py` checks
`https://fyl.at/api/health`, then `GET https://admin.fyl.at/api/admin/ready` and `GET https://admin.fyl.at/api/billing`
with the repository secret `MONITOR_TOKEN` and the Access service token (repository secrets `FYL_ACCESS_CLIENT_ID`,
`FYL_ACCESS_CLIENT_SECRET`), and fails when health or readiness fail, readiness names any reason (`open_reports`,
`overdue_cleanups`, `storage_60`, `daily_60`, or a code added later), or the estimated bill so far reached the alert.
A failed run is GitHub's e-mail to the account that last changed the cron line in `monitor.yml` (a failed manual run
goes to whoever started it), with Actions notifications on.

- **What the log shows.** The Actions log of a public repository is public, so there the monitor prints only whether
  the run passed and the names of the checks that failed (health, readiness, attention, billing, setup): no dollars,
  capacity, counts, pause state or hints. `npm run monitor` run locally (with `MONITOR_TOKEN` and the service token in
  the environment or `.env`) prints the reason codes, counts, percentages, dollars and a hint for each problem.
- **Tries.** A request that gets no JSON answer is tried up to three times, 10 s apart. The estimate is asked only
  once readiness answered. When Cloudflare's analytics don't answer (502 `billing_unavailable`, a timeout) the run
  only warns, and the next hour asks again. A misconfiguration fails: 401 (the token differs), 403 or a redirect to the
  sign-in (Access refused the service token, or it expired: `TOKEN_EXPIRES` in `scripts/monitor.py`), 404, 503
  `billing_unconfigured` (`CF_ANALYTICS_TOKEN` or `BILLING_CYCLE_DAY` missing on the Worker), 503 `billing_refused`
  (Cloudflare refused `CF_ANALYTICS_TOKEN`; [create a new one](#admin-host-and-statistics)).
- **Billing alert.** The estimate is the dashboard's ([billing estimate](#admin-host-and-statistics)). The run fails
  once the total so far is at or above the repository variable `BILLING_ALERT_USD` (default **15**), and then every
  hour until the cycle starts over or the alert is raised. Locally the run also prints the meters above their
  allowances and `Pace:`, a rough figure for the whole cycle (informational, it never fails a run). Set the variable
  (not a secret) with `gh variable set BILLING_ALERT_USD --body 18`, then "Run workflow" once;
  `gh variable delete BILLING_ALERT_USD` brings back 15. It takes a plain number of dollars above 0 (`18`, `12.50`);
  anything else fails the run. The total is compared as shown, in cents rounded half up. Locally:
  `BILLING_ALERT_USD=18 npm run monitor`.
- **Two alerts on the bill.** Cloudflare's own account budget alert mails only once the cycle's usage charges reach its
  threshold, and doesn't say which meter. Keep `BILLING_ALERT_USD` below that threshold, so the monitor mails first,
  and after a deliberate rise in usage raise it rather than living with hourly mails ([cost alerts](COSTS.md#cost-alerts)).
- **Not reasons:** `turnstile` (a missing `TURNSTILE_SECRET` doesn't fail the monitor) and `paused` (`true` while
  `npm run admin -- pause` holds new uploads, printed as a notice locally; the dashboard shows `Uploads: PAUSED`).
- **Quiet repositories.** GitHub disables a schedule after 60 days without repository activity and may delay or drop
  runs under load. If the mails stop, check Actions → Monitor and enable it again.
- The monitor fails every hour while a report stays open: decide cases promptly, or expect hourly mails. It runs no
  smoke test and reads no statistics.

## Admin host and statistics

`https://admin.fyl.at` is the operator's host, served by the same Worker (a custom domain in `wrangler.jsonc`) and set
by the vars `ADMIN_HOST`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and the secret `ADMIN_EMAILS`.

- **Cloudflare Access** app on `admin.fyl.at` (self-hosted, 24 h sessions, HttpOnly cookie with SameSite=Lax; Strict
  loops the sign-in at `/cdn-cgi/access/authorized` in Safari) with two policies: an identity policy for the
  operator's e-mail (one-time PIN) for the browser, and a non-identity policy for the service token in
  `FYL_ACCESS_CLIENT_ID` / `FYL_ACCESS_CLIENT_SECRET`, used by `npm run admin`, the monitor and the smoke test.
- **The Worker checks Access again** (`src/access.ts`): every request to `ADMIN_HOST` needs a
  `Cf-Access-Jwt-Assertion` signed RS256 by one of the team's keys (`https://<team>/cdn-cgi/access/certs`, cached an
  hour, fetched again for an unknown key id at most every 30 s, 5 s timeout, keys up to a day old still verify while
  that endpoint fails), with `aud` containing `ACCESS_AUD`, `iss` `https://<team>` and `exp`/`nbf`/`iat` within a minute
  of leeway; anything else answers 403 `access_denied` and serves nothing. A missing team domain or AUD refuses
  everything (`misconfigured`). An identity token whose e-mail is in `ADMIN_EMAILS` is the operator; a service token
  (`common_name`) or another identity passes Access but reads nothing without the operator token (or, for readiness
  and the billing estimate only, `MONITOR_TOKEN`). Neither the token nor the e-mail is logged; `access_denied` counts
  the reason.
- **What the host serves:** `/` the dashboard (`dist/admin/`; on `fyl.at` every `/admin` path answers 404), `/api/stats`,
  `/api/billing`, and the operator API `/api/admin/*`. Everything is `no-store` with the site's strict CSP. The
  operator's sign-in alone reads `GET /api/stats`, `/api/billing`, `/api/admin/ready`, `/api/admin/uploads` and
  `/api/admin/reports` (the queue without details, contact, network hash or transfer id) and skips `ADMIN_RATE`; every
  change and every other view needs `ADMIN_TOKEN` (scripts only: the dashboard holds no token).
- **The dashboard** (`dist/admin/`): a status strip (readiness, open reports, the last 24 hours' counters that should
  stay at zero, the `fyl-at` Worker's errors and the live version), tiles for page views, uploads, data, downloads and
  storage in use, the funnel from visit to download, charts per day, a product mix (how transfers ended, downloads per
  transfer, lifetimes, sizes, clients, options), ranked lists (pages, referrers, campaigns, countries, devices,
  languages, clients), the panel "This billing cycle", readiness and the open reports with the commands to decide them,
  and the range's operational events. Days are Vienna days. A visitor is a browser page view that named a language
  (`isVisitor()` in `src/stats.ts`); curl, the CLI, bots and scripts are shown as automated traffic beside it, and
  fyl's own tools (`OWN_TOOLS` in `src/index.ts`) are left out of every figure.
- **Statistics** (`GET /api/stats?range=1d|7d|30d|90d`, `src/stats.ts`): SQL queries against Analytics Engine
  (`POST /client/v4/accounts/<account-id>/analytics_engine/sql`, counts as `SUM(_sample_interval)`) with the read-only
  secret `CF_ANALYTICS_TOKEN`, answered as aggregates only and kept 60 s in the location's cache under a key that
  carries `SHAPE_VERSION`: bump it whenever `shape()`'s answer changes, so a dashboard just deployed never reads an old
  body. Where counting began is fixed per kind in `COUNTED_SINCE`. Without the secret 503 `stats_unconfigured`; an SQL
  API failure 502 `stats_unavailable` (logged as `stats_failed` with the status only).
- **Billing estimate** (`GET /api/billing`, `src/billing.ts`): the current billing cycle so far, from midnight UTC on
  `BILLING_CYCLE_DAY`, read in one GraphQL Analytics request for the whole account with the same `CF_ANALYTICS_TOKEN`,
  priced with the dated table in [COSTS.md](COSTS.md#prices-and-the-dashboards-estimate) (`PRICES` in
  `src/billing.ts`; change both), kept 15 minutes in the location's cache. It is an estimate for the whole Cloudflare
  account, not fyl alone, by design: exact figures would need Billing Read, which also opens the billing profile.
  Without the secret or with an invalid day 503 `billing_unconfigured`; a token Cloudflare refuses 503
  `billing_refused`; any other GraphQL failure 502 `billing_unavailable`. The answer also carries `pace`,
  `storageByDay` and `workerErrors` (the `fyl-at` Worker's requests and errors of the last 24 hours, best effort).
- **Creating `CF_ANALYTICS_TOKEN`:** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token,
  permission **Account → Account Analytics → Read**, account resources: this account only, no zone permissions; note
  the end date if you set a TTL (when it runs out, the dashboard loses its statistics and estimate and the monitor fails
  every hour with `billing_refused`). Then `npx wrangler secret put CF_ANALYTICS_TOKEN` and paste it. Check: the
  dashboard's tiles and "This billing cycle" fill in; `npm run deploy` no longer warns.
- **Local development:** `npm run dev` also serves `http://admin.localhost:4173/` without Access (`--var` flags set
  `ADMIN_HOST=admin.localhost`, empty `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` and `DEV_ACCESS_BYPASS=1`; the bypass needs all
  three, so production can't have it, and `npm run deploy` refuses a `DEV_*` secret) and sample statistics and billing
  estimate (`DEV_FAKE_STATS=1`; `FYL_DEV_STATS=live npm run dev` reads the real ones with a `CF_ANALYTICS_TOKEN` in
  `.dev.vars`). `FYL_BASE_URL=http://admin.localhost:4173 npm run admin -- ready` works against it with the local
  operator token from `.wrangler/dev-secrets.env`.

## Reports, abuse and incidents

### Daily routine

The Monitor workflow mails a failure when anything waits ([monitor](#monitor)). Then:

```bash
npm run admin -- ready                         # health checks, reason codes, capacity, open reports
npm run admin -- reports                       # open queue: priority 1 (CSAM) to 4, then oldest first
npm run admin -- report R-7K3M9Q2XPA           # one case and its history
npm run admin -- show <id or download link>    # the transfer: name, status, quarantine, open case ids
npm run admin -- decide R-7K3M9Q2XPA quarantine --note "reviewing malware report"
npm run admin -- decide R-7K3M9Q2XPA restore --note "checked, harmless"     # lifts it, closes the case (restored)
npm run admin -- decide R-7K3M9Q2XPA remove --note "confirmed malware"      # takedown, final; asks for "yes" or --yes
npm run admin -- decide R-7K3M9Q2XPA reject --note "not a violation"        # closes the case, the file stays as it is
npm run admin -- decide R-7K3M9Q2XPA note --note "asked the reporter for details"
```

- `quarantine` blocks every way to the file (403 `quarantined`) while the case stays open; the sender can still delete
  it, and expiry and cleanup go on. `restore` lifts it, `remove` takes the file down for good, `reject` leaves the
  transfer as it is. Rejecting the last open case of a quarantined file is refused (409): restore or remove decide it.
  Every decision needs `--note` with at least 3 characters (the reason is recorded); `note` only needs text.
- Without a case: `npm run admin -- quarantine TARGET --note T`, `restore TARGET --note T`,
  `takedown TARGET --note T [--yes]`. A quarantine made this way is recorded in the transfer's open cases only, and
  `show` is the only place that lists it.
- TARGET is a bare transfer id or the exact download link; anything else is refused. Every changing command takes
  `--dry-run`. `reports` pages with `--after CASE` (the listing prints the next command) and filters with
  `--transfer TARGET` and `--status open|closed|all`.
- Reports about an end-to-end encrypted file: judge on plausibility and never ask for the key
  ([E2EE](#end-to-end-encryption)).
- Reports about a link that closed within the last 7 days are accepted with "already gone when reported"; they stay
  open until decided or about 8 days after filing. Cases on a file that is gone close by themselves (outcome `expired`,
  or `removed` after a takedown). Contact details are only in the case; reporters get no notification. Priority 1 cases
  (child sexual abuse material) come first in the queue.

### Takedown and emergencies

A takedown closes the transfer for everyone at once: the R2 object, multipart parts, name and reservation are cleaned
up in the same request, and the link answers 410 `removed` for good. Its small record is never purged, so the id never
takes a new upload. An id without a transfer can be taken down too, which blocks it in advance (`existed: false`). An
abort or `DELETE` by the sender afterwards keeps the reason `removed`. If the Reports object fails, the takedown still
happens and the command warns that the open cases did not record the reason (`reportsUpdated: false`).

```bash
npm run admin -- pause        # refuse new uploads and every further part; downloads continue
npm run admin -- resume
npm run admin -- status       # switch, stored and daily bytes (payload, copies, reserved, attempted), network limits, overdue cleanups
npm run admin -- reconcile    # recount the budget from its rows (after a rollback, or when networks get 429s they should not)
```

Refused parts don't count against the attempt cap, so interrupted uploads resume after `resume` within their 24
hours. If immediate edge blocking is needed beyond a takedown, add an exact transfer-path block in the custom firewall
ruleset. Never delete a bucket or namespace to handle one report.

`npm run admin` talks to `https://admin.fyl.at` with the operator token and the Access service token (both from the
environment or `.env`). It sends them only over HTTPS (`FYL_BASE_URL` may be plain HTTP only for localhost,
`*.localhost`, 127.0.0.1 or [::1], where no service token is needed) and refuses redirects; a redirect to the Access
sign-in or a 403 from Access says the service token was refused. The operator routes have their own rate limit
(`ADMIN_RATE`, 10 a minute per network, before the token check).

### Reading the signals

| Signal | Meaning and first step |
| --- | --- |
| `open_reports` | Cases wait: `npm run admin -- reports` |
| `overdue_cleanups` | A reservation is still active more than 8 days and an hour after admission: its transfer's cleanup never ran or never reached the release. The Budget's daily alarm reconciles it (`cleanup_reconciled` by outcome in [METRICS.md](METRICS.md)); `npm run admin -- reconcile` does it at once. Still there afterwards: `cleanup_retry` by code |
| `storage_60`, `daily_60` | Stored bytes or today's volume reached 60 % of the global cap: check `status`; raise the var or pause before uploads get 429 |
| `ready: false` | A check failed: `npm run admin -- ready` names it (secrets, rotation, r2, budget, reports) |
| 503 `misconfigured` | A Worker secret is missing, or Cloudflare rejects `TURNSTILE_SECRET` (reports only); the log names it (`{"event":"misconfigured","missing":…}`) |
| `turnstile_failed` | Reports refused by the Turnstile check, by reason. A run of `unavailable` means siteverify fails and nobody can report: see [Turnstile](#turnstile) for switching the check off |
| 429 | A rate limit (`rate_limited`), a budget (`storage_capacity`, `daily_budget`, `network_*`), a report limit or a paused password |
| 503 `uploading` | A link whose upload hasn't completed yet |
| 403 `e2ee_disabled` | `E2EE_ENABLED` is off: new encrypted uploads are refused ([switch](#end-to-end-encryption)) |
| `part_refused` `part_changed`, `part_corrupt`, `head_mismatch` | Encrypted parts that changed under a resume, were stored damaged, or a completed file with another head; a run of the last two points at a client or storage fault |
| 410 | An intentionally closed transfer, with its reason |

Structured log events: `request_failed`, `operation_failed`, `cleanup_retry_scheduled` (with the failing step),
`misconfigured`, `reports_unavailable`. `curl -fsS https://fyl.at/api/health` is a basic HTTP check.

## Notifications, analytics and DNS

- **Cloudflare notifications** to the operator's address: Workers Observability real-time issues
  (`workers_observability_real_time_issue`) and event alerts (`workers_observability_alert`, firing and resolved), the
  account's billing budget alert (`<policy-id>`) and Cloudflare's account abuse notifications (`<policy-id>`). All are
  notifications, not limits. Cloudflare can still forward abuse reports it receives; the site's own report form is the
  way in. Alert rules on `fyl_events` are not set up (the Workers Observability alerts API is not documented yet);
  until then the hourly monitor mails these cases.
- **Analytics:** server-side events go to Workers Analytics Engine `fyl_events` ([METRICS.md](METRICS.md)). Cloudflare
  Web Analytics is not enabled for fyl.at, and the "Disable RUM" configuration rule keeps its beacon out
  ([E2EE](#end-to-end-encryption)). Cloudflare's Custom Dashboards can't chart Analytics Engine.
- **E-mail DNS:** `TXT fyl.at "v=spf1 -all"`, `TXT _dmarc.fyl.at "v=DMARC1; p=reject; adkim=s; aspf=s"` and a null
  `MX fyl.at 0 .`, since fyl.at sends no mail, so spoofed `@fyl.at` senders are rejected. The null MX also means the
  zone receives no mail: the security contact `security@fyl.at` ([SECURITY.md](../SECURITY.md), `security.txt`)
  needs a mail route first, for example Cloudflare Email Routing, which replaces the null MX with its own MX records
  and forwards the address to the operator; SPF and DMARC stay as they are. DNSSEC is off.

## Verification

`npm run ci` lints, type-checks, runs the Worker tests (real local R2 and SQLite Durable Objects, the browser upload
client, the website and download page against a scripted page; the tests of minified files run a second time against
the minified build) and the Python tests (the CLI against the native binary, the installer, the operator, monitor,
rollback, smoke and release scripts), and builds the minified assets and a dry-run bundle from them
([CONTRIBUTING.md](../CONTRIBUTING.md)).

After each deployment run `npm run smoke` (with `FYL_ACCESS_CLIENT_ID` and `FYL_ACCESS_CLIENT_SECRET` set for the admin
checks): it checks every page's policy and scripts and the kept code's bytes (as the deploy does), the report and
privacy pages, that `fyl.at` answers 404 for `/admin` and `/api/stats`, that `admin.fyl.at` refuses requests without
Access and serves the dashboard and readiness with the service token, that a report on an unknown link is refused,
readiness (with `MONITOR_TOKEN` or `FYL_ADMIN_TOKEN`), the versioned CLI files against `SHA256SUMS`, then makes small real transfers with the published CLI (regular, one-time, password and end-to-end
encrypted uploads, `fyl download`, `fyl rm`), checks HTTPS, no-cache, filename, CORP and hotlink behaviour, the download
page, ranges, private controls, one-time consumption, Basic Auth and the unlock form, and removes its files.
`npm run smoke -- --multipart` uses four 52 MiB uploads (regular, one-time, password, end-to-end encrypted) and fails
if the CLI had to retry; run it after every change to the upload or download path. Both count toward production
budgets and never print management links; test files expire after five minutes if cleanup fails.

On a Mac, `sh scripts/mac-check.sh` installs fyl into a temporary folder and tests install, signature, messages,
uploads, one-time links, Ctrl+C with `--resume` and the x86_64 build under Rosetta, deletes its uploads and uploads the
report with fyl itself.

The largest production test so far is a 10 GiB upload (205 parts, every part checked against R2's MD5 ETag, no
retries) and its one-time download with an identical SHA-256. The 50 GB declaration boundary and an oversized
completion manifest are tested without transferring 50 GB, which is not a 50 GB load test. Before raising quotas,
size them against Cloudflare billing and usage data.
