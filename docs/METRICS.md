# fyl.at metrics

What the Worker counts, and how to read it. The dashboard on the admin host charts these events
([admin host and statistics](OPERATIONS.md#admin-host-and-statistics)); the privacy page says what a page view records.
Add every new event to the table below, and update the privacy page with any change to what `page_view` records.

The Worker counts operational events in the Workers Analytics Engine dataset `fyl_events` (binding `METRICS`, `metric()` in `src/shared.ts`). Each data point has the event as its index and `blob1`, a code or an empty string as `blob2`, and a number as `double1` (1 unless noted); `page_view` adds coarse dimensions in `blob3`–`blob10`, a transfer's `upload_completed`, `completion_lifetime` and `stored_gb_days` the kind of client that started it in `blob3` (and its options, its downloads in `double2`, as noted). Nothing else: no addresses, network hashes, transfer ids, keys, file names or User-Agents. New dimensions only ever go after the existing ones, so stored rows keep their meaning (a row written before a dimension reads it as `''` or 0). A missing binding or a failed write never fails a request. Analytics Engine keeps each data point with its time for three months, also after the file it concerns is gone; only the operator reads them (the admin host's dashboard behind Access, [admin host and statistics](OPERATIONS.md#admin-host-and-statistics), or the read-only `CF_ANALYTICS_TOKEN`).

| Event | Written when | `blob2` / `double1` |
| --- | --- | --- |
| `upload_started` | an upload was admitted (once per upload; a replay of its init counts nothing) | the kind of client that started it (`clientOf()`: `browser`, `cli`, `curl`, `wget`, `other`, or `own` for fyl's own tools) |
| `upload_completed` | an upload becomes ready | — for a raw upload, `e2ee` for an end-to-end encrypted one / file size in bytes (the stored size); `blob3` the kind of client that started it (`unknown` for an upload started before it was kept), `blob4` `password` or '', `blob5` `once` or '' (all three '' in rows written before 2026-11) |
| `completion_lifetime` | the same moment | — / the chosen lifetime in seconds; `blob3` the kind of client |
| `completion_ms` | R2 completed the multipart upload | — / milliseconds R2's completion took |
| `part_confirmed` | a part attempt became the part's confirmed one | — / part bytes |
| `part_failed` | the Worker's R2 write of an attempt failed; `disconnected` when the sender went away mid-part (Cancel upload, a closed tab: `request.signal`), which is no fault and stays out of the status strip | — or `disconnected` / part bytes |
| `part_busy` | every slot of a part holds an attempt still running (503 `part_busy`) | |
| `part_refused` | the Budget refused or failed to charge a part attempt (before R2), or the transfer refused an encrypted part or completion | its code: `uploads_paused`, `storage_capacity`, `daily_budget`, `network_bytes`, `network_storage`, `request_failed` (reservation closed, or more than the declared size) or `temporarily_unavailable`; for encrypted uploads `part_changed` (a pin or `Content-MD5` other than the part's pin, before R2), `part_corrupt` (R2 stored another MD5 than the pin) or `head_mismatch` (the completed file doesn't start with the init head) |
| `part_limit` | an attempt is refused at the 20-attempt cap (409) | |
| `budget_refused` | the Budget refuses an admission or a part | `uploads_paused`, `storage_capacity`, `daily_budget`, `network_budget`, `network_uploads`, `network_bytes` or `network_storage` |
| `budget_drift` | reconciliation found an aggregate off and fixed it | the aggregate (`used`, `copies`, `reserved`, `active`, `daily_uploads`, `daily_reserved`, `network_uploads`, `network_active`, `network_reserved`, `network_stored`, `network_stored_uploads`) / the difference |
| `cleanup_retry` | a cleanup step failed and is retried (1, 5, 15 minutes, then hourly) | the step: `r2_abort`, `r2_delete`, `budget_release`, `r2_verify` or `storage` |
| `cleanup_age` | a cleanup succeeded | — / seconds since the transfer became due for cleanup |
| `cleanup_orphan` | the check an hour after cleanup found and deleted an object a racing completion left | |
| `cleanup_reconciled` | the cleanup reconciler handled a reservation overdue past every lifetime (Budget alarm or `admin reconcile`) | `rearmed` (the transfer ran its alarm), `released` (no record left, or a clean one: the Budget released it), `failed` / |
| `stored_gb_days` | a cleanup succeeded | how the transfer ended (`expired`, `consumed`, `deleted`, `removed`, `aborted`) / GB-days R2 held it (2^30 bytes × days); `blob3` the kind of client (a row without it predates the download count), `double2` how often it was downloaded (each download request that started, a resumed download counting again; a one-time link 1 at most) |
| `download_started` | a download response starts at byte 0 (no range, or one from 0) | client kind from the User-Agent: `cli`, `curl`, `wget`, `browser`, `other`, or `own` for fyl's own tools and checks marked `fyl-smoke` or `fyl-ops` (outside the Downloads tile) / 1 for a one-time link, else 0 |
| `cli_fetch` | a GET of `/cli/install` or a versioned CLI binary answered 200 (never for fyl's own tools) | `install`, or the platform: `linux-x86_64`, `linux-arm64`, `macos-x86_64`, `macos-arm64` |
| `one_time_session` | a one-time link opens its download session | |
| `one_time_interrupted` | a one-time download of the whole file breaks off; the session stays open for a resume | |
| `early_wait` | a link was opened before its upload completed (a waiting page or a 503 `uploading`; each `curl --retry` try counts) | |
| `password_wrong` | a wrong download password (Basic Auth or the form); tries refused during a pause are not counted | |
| `password_paused` | 5 wrong tries pause a network, or 50 within 15 minutes the transfer | — for a network, `transfer` for the whole transfer |
| `password_ok` | a right password; counted per request, so each range request of a Basic Auth download counts | |
| `password_unpaused` | the sender lifted password pauses | `transfer` if the transfer-wide pause was running, else — / networks paused |
| `rate_limited` | a native rate limit refused a request | the limit: `init`, `part`, `download`, `status`, `report` or `admin` |
| `preview_served` | an image preview went to a link-preview bot (GET) | the image type: `png`, `jpeg`, `gif`, `webp` or `avif` / bytes |
| `report_received` | a report was filed | its category |
| `quarantine`, `restore` | an operator quarantined or restored a transfer (directly or by a decision) | |
| `takedown` | an operator takedown succeeded (directly or by a `remove` decision) | |
| `pause` | an operator pause or resume succeeded | — / 1 paused, 0 resumed |
| `fallback` | a best-effort step failed and a slower path takes over | `reports_view` (open reports unknown in an operator view), `part_fail` (an R2 failure was not reported; the lease ends it), `part_release` (an attempt's release failed; the lease ends it), `budget_uploaded` (a completed upload stays counted as running until midnight), `orphan_delete` (the check an hour later repeats it) |
| `page_view` | a GET was answered with `/` or `/privacy` (200 or 304), the report form on `report.fyl.at`, a download page or a closed-link page; never for fyl's own tools (`OWN_TOOLS`) | the page: `home`, `report`, `privacy`, `download` or `gone`; then `blob3` the referrer host (lower case, without `www.`; `direct` without a Referer; for fyl.at's own hosts only the kind of page, `fyl:download` for a download page (its recipients), `fyl:report` for the report form's host, `fyl:site` for any other, `internal` in rows written before 2026-11; `ip` for an address, also one written into a name such as `10-0-0-5.nip.io`, `private` for a name without a dot or under a private suffix such as `.local`, `.lan`, `.corp`, `fritz.box`, `other` for no web address; at most 100 characters), `blob4` `utm_source` and `blob5` `utm_campaign` (NFKC, lower case, spaces as `-`; kept only as a plain name of letters, digits, `.`, `_`, `-`, at most 40 characters, without 6 digits or 16 hex characters in a row, else `other`; '' without), `blob6` the country (`CF-IPCountry`, two letters, `XX` unknown, `T1` Tor), `blob7` the device for browsers (`mobile`, `tablet`, `desktop`; '' for other clients), `blob8` the client (`browser`, `cli`, `curl`, `wget`, `bot` for link-preview bots and crawlers, `script` for a browser's User-Agent without an `Accept-Language` since 2026-11, `other`), `blob9` a browser's first `Accept-Language` (its primary subtag of two or three letters, `und` when it names none; '' for every other client, and for a browser in rows written before 2026-11 that sent none), `blob10` for a closed-link page why it closed (`expired`, `consumed`, `deleted`, `removed`, `quarantined`, `unsupported_mode`, `busy`, `missing`; '' for every other page and before 2026-11) |
| `misconfigured` | a request answered 503 `misconfigured` (a missing Worker secret, a `TURNSTILE_SECRET` Cloudflare rejects), or the admin host lacks `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` | |
| `access_denied` | the Worker refused a request to the admin host for its Access token | the reason: `missing`, `malformed`, `algorithm`, `certs` (keys unavailable), `kid`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid`, `subject` |
| `turnstile_failed` | the report form's Turnstile check refused a report (403 `turnstile_failed`), or siteverify gave no usable answer (503) | `missing` (no token, not a string or over 2048 characters), `invalid` (siteverify said no), `expired` (`timeout-or-duplicate`, or solved more than 5 minutes ago), `hostname`, `action` (solved for another host or action) or `unavailable` (siteverify unreachable, unreadable or an internal error) |

A part refused by the Budget counts twice, as `budget_refused` and `part_refused`; the encrypted-part codes come from the transfer alone. Analytics Engine samples at high volume, so count with `SUM(_sample_interval)` rather than `COUNT()`. The SQL API needs a token with Account Analytics Read:

```bash
curl -s https://api.cloudflare.com/client/v4/accounts/<account-id>/analytics_engine/sql \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SELECT blob1 AS event, blob2 AS code, SUM(_sample_interval) AS n, SUM(_sample_interval * double1) AS total FROM fyl_events WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY event, code ORDER BY n DESC"
```

`total` is bytes for `upload_completed` and `part_confirmed`, GB-days for `stored_gb_days`; for monthly figures use `INTERVAL '30' DAY` and look at `download_started` by client, `stored_gb_days`, `rate_limited` and `budget_refused` by code before changing limits or prices.
