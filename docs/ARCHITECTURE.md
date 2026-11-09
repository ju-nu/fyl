# fyl.at architecture

How the service is built, where each limit lives, how uploads are accounted, which compatibility code is still in the
tree and which limits are accepted. The HTTP protocol is in [CLI-API.md](CLI-API.md), the Cloudflare configuration
and the runbooks in [OPERATIONS.md](OPERATIONS.md), the events the Worker counts in [METRICS.md](METRICS.md), the
encryption profile in [E2EE.md](E2EE.md). The product intent is in [PRODUCT.md](../PRODUCT.md).

## How it works

fyl.at is one Cloudflare Worker (`src/index.ts`) with three SQLite Durable Object classes, one private R2 bucket and
Workers Static Assets. The Worker runs first for every request (`assets.run_worker_first: true` in `wrangler.jsonc`):
it sets each page's Content-Security-Policy, counts page views without identifiers, serves the report form on its
own host (`report.fyl.at`) and the private dashboard and operator API on `admin.fyl.at` behind Cloudflare Access, and
answers the JSON API and the guarded downloads. Every other path goes to the asset binding.

The Worker streams file bodies to and from R2 without touching chunks in JavaScript. Keep it that way: hashing each
50 MiB part in a JavaScript stream cost about 2 s of CPU and failed with "Worker exceeded CPU time limit". R2's part
ETag already is the part's MD5, which the CLI checks for every part and the browser checks when it resumes.

- **Transfer** (`src/transfer.ts`, binding `TRANSFERS`, one object per transfer): the record as one JSON row (name,
  size, lifetime, key hashes, password hash, status, quarantine), a `parts` table (the confirmed attempt per part: ETag,
  R2 slot, finish time), an `attempts` table (attempts not yet settled, each with its own R2 part number),
  `tries`/`wrong_tries` for password tries, and for an encrypted transfer its `mode`, `head` and `meta` in the record
  and a `pins` table (each part's MD5, pinned before its body is sent). It decides every download, one-time claim,
  password try and completion. Cleanup drops every table but the record, and `head` and `meta` with them.
- **Budget** (`src/budget.ts`, binding `BUDGET`, object `admission-v1`): admission and byte accounting only
  ([semantics](#budget-semantics)); file bodies and ordinary reads never pass through it.
- **Reports** (`src/reports.ts`, binding `REPORTS`, object `reports-v1`): report cases and their events, kept apart
  from the transfers so a case outlives its file.
- **R2** (binding `FILES`): objects at `files/<transfer id>`, content type `application/octet-stream` and no other
  metadata; the file name is kept only in the transfer's Durable Object. No r2.dev or public bucket domain exists.
- **Metrics** (binding `METRICS`): the Workers Analytics Engine dataset `fyl_events` ([METRICS.md](METRICS.md)).

**Uploads.** Clients send 50 MiB parts, four in flight (the CLI allows up to eight). A transfer with `n` parts gets
`min(9, floor(10000 / n))` R2 part numbers per part (`MAX_SLOTS`, `R2_PARTS` in `src/transfer.ts`; 9 for a 50 GB file).
Every admitted attempt writes its own slot, so a late attempt never overwrites a confirmed part, and the completion
sends R2 the confirmed slots. When every slot of a part is busy the answer is 503 `part_busy`. R2 accepts these
non-contiguous part numbers. The Worker validates admission, the declared size, the part layout and the session
capability, then streams each part into R2; completion checks the stored ETags, and both clients accept a completion
only with a valid receipt.

**Downloads.** Every download checks authoritative state in the transfer's object: single byte ranges, one-time
sessions ([rules](CLI-API.md#one-time-download-sessions)), passwords and grants ([rules](CLI-API.md#passwords)),
quarantine. HEAD, download pages and link previews never count a download. API and download responses are never
cached. Durable Object alarms enforce expiry and retry physical deletion; R2 lifecycle rules are the backstop.

**Pages.** `dist/` is the site's source. The public pages exist once per language (below); the Worker fills the
download page through `<html data-state>`, the `#fyl-state` JSON block and the Open Graph tags. The deploy uploads a
build of `dist/` in which the site's own scripts and stylesheets are minified (whitespace and comments only) and the
code that handles encryption keys ships byte for byte ([static assets](OPERATIONS.md#static-assets)).

### Languages

The public pages exist in English, German, Spanish, French and Dutch (`i18n/locales.json`, one list for the build
and the Worker; [i18n/README.md](../i18n/README.md) has the catalog rules and the glossary for translators).

- **Build:** `i18n/templates/*.html` and the catalogs `i18n/<lang>.json` become `dist/<lang>/{index,privacy,report,download}.html`
  and `dist/sitemap.xml` (`npm run build:i18n`, `scripts/build_i18n.mjs`; also run by `npm run build:assets` and
  `npm run dev`). The output is committed, so `dist/` stays what dev, tests and `wrangler dev` serve. Edit the templates
  and catalogs, never `dist/<lang>/`. A missing key falls back to English; `tests/i18n.test.ts` fails while a present
  catalog misses or adds a key, changes a placeholder or markup, or a generated file is stale
  (`node scripts/build_i18n.mjs --check` says which).
- **Routing** (`src/index.ts`, `src/i18n.ts`): `/` picks a language for browsers, 302 (never 301) to `/<lang>/` by
  `Accept-Language` with `Vary: Accept, Accept-Language` and `no-store`, keeping the query; it is hreflang's
  x-default. A request to `/` that doesn't ask for HTML (curl, most agents' fetch tools) gets `llms.txt` itself
  (`text/markdown`, with `Link` headers `rel="describedby"` and `rel="alternate"`); crawlers and link-preview bots
  always get the switch. A browser navigation to a page address that doesn't exist (not a file, `/api`, `/cli`,
  `/d` or `/.well-known`) answers 302 to the home page of its language.
  `/<lang>/`, `/<lang>/privacy`, `/<lang>/report` (302 to `report.fyl.at/<lang>/` where the report host is set) and the
  bare `/<lang>/download` never redirect by language. Old addresses (`/index.html`, `/privacy`, `/report` without a
  report host, `/download`, any `*.html`, `/<lang>`) answer 301 to the English (or the locale's) page. Download links
  `/d/<id>` keep their address: the Worker serves `/<lang>/download` by `?lang=` (the page's language menu) or
  `Accept-Language`, with `Vary: Accept-Language`, and writes the preview tags from that page's messages
  (`messagesOf()`).
- **SEO:** each locale page is self-canonical, with hreflang alternates for all locales plus x-default, `og:url`,
  `og:locale` and the other locales as `og:locale:alternate`, a translated title and description and `<html lang>`.
  The sitemap lists every locale URL of home and privacy with `xhtml:link` alternates. No cookies: the language menu
  is a set of plain links.
- **Scripts:** `dist/i18n.js` (kept as written, `no-cache`, loaded first) reads the page's JSON block `#fyl-i18n` into
  `window.FylText`; numbers, sizes, durations and dates use Intl with the page's language. The API's JSON errors stay
  English; the pages translate known codes (`common.error.<code>`). The English privacy page is the binding one.

## Limits and retention

Sizes are binary (1 GB = 1024³ bytes). A network is an IPv4 address or an IPv6 /64 for rate limits and one-time
sessions, and an IPv4 address or an IPv6 /56 for budgets, password tries and report limits (`networkOf()` in
`src/shared.ts`). The vars are set in `wrangler.jsonc` ([vars](OPERATIONS.md#vars)); the rest are constants in code.

| Control | Value | Where |
| --- | --- | --- |
| Per file | 50 GB | `MAX_FILE_BYTES` (var) |
| Part size / parallelism | 50 MiB / 4 in the browser, CLI `--workers` 1–8 (default 4) | `PART_BYTES` (`src/shared.ts`), both clients |
| R2 slots per part | `min(9, floor(10000 / parts))` | `MAX_SLOTS`, `R2_PARTS` (`src/transfer.ts`) |
| Part attempts | 20 admitted attempts per part, then 409 `part_limit`; refused attempts don't count | `PART_ATTEMPTS` (`src/transfer.ts`) |
| Attempt lease | 6 hours, then the slot and reserved bytes are free and a late report gets 503 `lease_expired` | `ATTEMPT_LEASE_MS` (`src/shared.ts`) |
| Lifetime | 300–604800 seconds, default 86400 | `validExpiry` (`src/shared.ts`), default in `src/index.ts` |
| Upload window | 24 hours | `UPLOAD_TTL_MS` (`src/shared.ts`) |
| One-time session | 15 minutes idle, 24 hours at most | `DOWNLOAD_IDLE_MS`, `DOWNLOAD_SESSION_MAX_MS` (`src/shared.ts`) |
| Tombstone | 7 days after cleanup; takedowns are kept for good | `TOMBSTONE_TTL_MS` (`src/shared.ts`) |
| Stored bytes, whole service | 5 TB | `MAX_STORED_BYTES` (var) |
| Uploaded bytes per UTC day, whole service | 1 TB | `MAX_DAILY_UPLOAD_BYTES` (var) |
| Uploads | 50,000 admitted per day, 100,000 not yet cleaned up | `MAX_DAILY_UPLOADS`, `MAX_ACTIVE_UPLOADS` (vars) |
| Per network and day | 500 uploads admitted, 250 GB uploaded (counted for the network sending the parts) | `MAX_DAILY_UPLOADS_PER_NETWORK`, `MAX_DAILY_UPLOAD_BYTES_PER_NETWORK` (vars) |
| Per network at once | 50 running uploads; 250 GB stored (counted for the network that started the uploads) | `MAX_ACTIVE_UPLOADS_PER_NETWORK`, `MAX_STORED_BYTES_PER_NETWORK` (vars) |
| Reports | 50 cases per network and day; closed cases kept 183 days | `MAX_DAILY_REPORTS_PER_NETWORK` (var), `RETENTION_MS` (`src/reports.ts`) |
| Rate limits per network and Cloudflare location | init 30/min, parts and upload control 600/min, downloads and management 300/min, public status polls 120/min, reports 5/min, operator routes 10/min | `ratelimits` in `wrangler.jsonc` ([routes](OPERATIONS.md#rate-limits)) |
| Download password | 6–200 code points after NFC, no controls; PBKDF2-HMAC-SHA-256, 100,000 iterations, 16-byte salt | `validPassword`, `PASSWORD_ITERATIONS` (`src/shared.ts`) |
| Wrong passwords | 5 in a row pause that network for 15 minutes; 50 from all networks within 15 minutes pause the transfer for 15 minutes | `PASSWORD_TRIES`, `PASSWORD_TRANSFER_TRIES`, `PASSWORD_PAUSE_MS` (`src/shared.ts`) |
| Download grant | 1 hour after unlocking on the page | `GRANT_MS` (`src/index.ts`) |
| Image preview | ready, not protected, not one-time, not quarantined, PNG/JPEG/GIF/WebP/AVIF by name and first bytes, at most 8 MB | `PREVIEW_BYTES`, `previewType` (`src/shared.ts`) |
| Body limits | init and abort 8 KiB, completion 2 MiB, PATCH 1 KiB, reports 16 KiB, operator decisions 8 KiB, pause switch 256 bytes, unlock form 4 KiB | `src/index.ts` |

Part size and worker counts are repeated in `cli-rs/` and `dist/api.js`, the password rule in `dist/api.js` and
`dist/download.js`, the password pause in `dist/app.js`, the risky-extension list of `src/shared.ts` in
`dist/download.js`; change them together. Native rate limits are approximate per Cloudflare location; the Budget
enforces the byte and upload caps authoritatively. None of these caps is a Cloudflare spending limit: at the 5 TB
storage cap, R2 storage alone costs about $82 a month ([costs](COSTS.md)).

**Retention.** A successful cleanup aborts the multipart upload, deletes the R2 object and releases the budget
reservation, then clears the name, fingerprint, password hash, salt and tries, quarantine and one-time session from
the record, drops every other table, and schedules the purge 7 days later, when `deleteAll()` drops the object
completely (the link then answers 404 instead of 410). The tombstone keeps the id, size, lifetime settings, times,
status, download count, object key and the hashes of the management key, resume token and completion (so the sender's
`DELETE` still answers). Takedowns are never purged: a client can derive the same id again from its client key and
Idempotency-Key, so the record keeps the id from taking a new upload. Released Budget reservations (with their daily
network hash) are deleted 30 days after admission. R2 lifecycle backstops under `files/`: incomplete multipart uploads
are aborted after 2 days, objects deleted after 8 days; the application's own deadlines don't wait for them.

## Budget semantics

From `src/budget.ts` (the class comment is authoritative):

- **reserved**: bytes of admitted part attempts not yet settled (the Worker hasn't reported R2's result). Temporary
  admission control only: an attempt that never settles stops counting after `ATTEMPT_LEASE_MS` (6 hours).
- **stored payload** (`used` of an upload): its unique confirmed part bytes, a part confirmed twice counting once.
- **copies** (`copies` of an upload): a part R2 stored again in another of its slots (a retry whose first attempt did
  arrive, a second client) is held there until the completion drops every copy it doesn't name, or the cleanup aborts
  the upload. Each such copy counts its bytes until then; one written over in the same slot doesn't.
  `MAX_STORED_BYTES` checks the stored payload and copies of live uploads plus reserved bytes; an upload's payload is
  released only once its cleanup removed the bytes from R2.
- **daily payload**: confirmed part bytes R2 stored (each part once, plus each copy), charged to the UTC day their
  attempt was admitted, plus reserved bytes admitted that day. `MAX_DAILY_UPLOAD_BYTES` applies to it.
- **attempted bytes**: every admitted attempt's bytes per day, failed and duplicate ones too. An indicator for the
  operator without a limit, and no billing guarantee.
- **network daily payload**: the daily payload per network of the request that sends the part (today's network hash,
  which rotates daily), limited by `MAX_DAILY_UPLOAD_BYTES_PER_NETWORK`. A resumed upload counts where it is sent from.
- **running uploads per network**: uploads admitted under today's network hash that neither completed nor were
  released, at most `MAX_ACTIVE_UPLOADS_PER_NETWORK`; a completed upload stays stored but no longer runs.
- **network stored bytes**: what `MAX_STORED_BYTES` counts (payload, copies and reserved bytes), per network that
  admitted the upload, for the upload's whole life and wherever its parts come from; at most
  `MAX_STORED_BYTES_PER_NETWORK`. It needs a hash that doesn't rotate (`live_hash`, an HMAC of `fyl-live:` and the
  network), kept only on active reservations and in the `live` sums, both dropped once the cleanup released the
  upload's bytes: at most the upload window plus the longest lifetime (8 days).
- A part reserves (a pending row) before R2 may receive it, then confirms or releases it; each booking is idempotent
  and atomic, so a crash leaves at most a pending row that the lease ends. Only reserved bytes are ever confirmed: an
  attempt whose lease ended is refused, so no byte counts that the caps didn't admit. Sums live in maintained
  aggregates (totals, daily, networks), updated in the same transaction and reconciled from the rows by the alarm.

At init the declared size must still fit every byte cap (stored, daily, network daily, network stored) and the count
caps must have room (`storage_capacity`, `daily_budget`, `network_budget`, `network_uploads`); each part then checks
the byte caps for its own bytes. Nothing is charged for a declared size alone. R2 may hold a part in all of its slots
(at most 9 × 50 MiB) until the completion or cleanup drops the copies. The Budget's daily alarm ends expired leases,
reconciles the aggregates (logging `budget_drift` for each aggregate that was off) and prunes old rows;
`npm run admin -- reconcile` does the same at once.

## Version scheme

The public release started the numbering at **1.0.0** for the service (the Worker version tag `v1.0.0`) and the CLI
(`fyl 1.0.0`). Before it, fyl was developed privately and its Worker versions were tagged `v2.0.0` to `v2.5.1`;
Cloudflare's deployment history still lists them. Those numbers are never used again: after 1.x comes 3.0.0, or 2.5.2
at the earliest. `OLD_NUMBERING` in `scripts/rollback.py` refuses those tags as rollback targets, `scripts/build_cli.py`
refuses them as a version. The CLI 1.0.0 binary also takes an offered 2.0.0 to 2.5.1 for an older version; from 1.0.1
on the CLI compares versions plainly, so a reused number would still confuse 1.0.0 installs. Version numbers
such as "since 2.4.0" in comments and older docs refer to those releases, which all came before 1.0.0.

## Compatibility code

Code that exists only for data written by earlier versions. Before removing an entry, check its trigger and note the
evidence (deploy time, an Analytics query) in the change that removes it.

- **Until 2027-01-30:** the dashboard's handling of Analytics rows written before 2026-11-01 in `src/stats.ts` (the
  `internal` referrer, the empty client and closed-reason blobs, `unknown` clients and `COUNTED_SINCE`) and the
  matching "Not recorded (older)" remainders in `dist/admin/admin.js`. Rows of those shapes were last written about
  2026-11-01 and leave the 90-day range then.
- **Stays for good:** `alarm()` and `schedule()` in `src/transfer.ts` never purge a takedown, whatever purge date it
  carries. Takedowns made between 2026-10-28 11:32 and 16:55 UTC got one and cannot be ruled out; without the check
  such a link could be purged and take an upload again.
- **Stays for good:** `Transfer.access()` takes only the management key for a record without `resumeHash`. Takedown
  placeholders have none, and neither do records closed before 2026-10-28 16:55 UTC, which takedowns keep for good.
  Likewise a record without `slots` (closed before 2026-10-30 16:40 UTC, or a placeholder) is never uploaded to.

Not compatibility code: a record without `client` stored none (takedown placeholders, and cleanup drops it), and a raw
record stores no `mode`. Tombstones of the former 30-day rule stay as storage until their alarm, 2026-11-27 at the
latest; they answer 410 and serve nothing.

## Known limitations

Accepted trade-offs of the current design:

- A distributed guesser can pause a protected transfer for 15 minutes again and again (50 wrong tries from any
  networks); the sender can lift it in the management view. The address holding a one-time link's download session
  (an IPv4 address or IPv6 /64) is spared that pause on `/d/`, the page, the unlock form and the info route (`holds()`
  in `src/transfer.ts`). Its own network's pause still refuses it: its own typos, or 5 wrong tries from another /64 of
  its /56 or from behind its NAT. Pauses last as long as a session may idle (15 minutes), so the session's idle time
  runs from the end of its holder's own network's pause, within the session's 24-hour cap (`hold()`,
  `sessionDeadline()`). The price: repeated pauses of the holder's network can keep an abandoned one-time download's
  file stored up to that cap, and a neighbour on the same /56 or NAT can still make the holder wait.
- The running-upload count per network uses the daily network hash: uploads admitted before UTC midnight stop counting
  after it, so a network can have up to twice the cap running around midnight.
- Rotating `NETWORK_HASH_KEY` restarts every per-network count and cap.
- An attempt whose 6-hour lease ended keeps streaming into its slot if the client still sends; that slot is handed out
  again only when every other slot of the part is taken, so a very late write could replace a newer confirmed part
  only for a part that used all its slots.
- A quarantine made outside a report case is listed nowhere but in `npm run admin -- show`.
- A network that is already rate-limited still gets the full download page with its 429. An in-app browser whose
  User-Agent names a listed preview bot and that sends no `Sec-Fetch-Mode` only ever gets the download page.
- Browser resume needs WebCrypto: over plain HTTP on a host other than localhost, uploads start over.
- A run resumed with a resume token can't print the management link, and `--manage` says so.
- A one-time GET whose Worker is cancelled between the claim and its response leaves that session open until its
  24-hour cap.
- An object that an R2 completion leaves after a racing cleanup is removed by the check an hour later, at the latest
  by the 8-day lifecycle rule.
- Only Chromium streams encrypted downloads; other browsers decrypt in memory, up to 256 MB (`MEMORY_LIMIT` in
  `dist/download.js`), until the browser matrix of [E2EE.md §9.4](E2EE.md#94-limits) is measured.
- The installer and `fyl update` check a binary against `SHA256SUMS` from the same origin; the GitHub release is the
  second, independent copy of those sums. Nothing is signed out of band yet.
- Pages the Worker serves with their own policy (`sitePage()`) drop `ETag` and `Last-Modified`, so `/`, `/privacy`,
  `/download` and the report form go out in full on every load, and `run_worker_first` makes every static file one
  Worker request ([costs](COSTS.md)).
- Every HTTP Basic request of a protected download runs the 100,000 PBKDF2 iterations again, once per range request.
