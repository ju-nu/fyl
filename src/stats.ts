import { ApiError, isObject, json, metric } from './shared';
import { adminHostOf, reportHostOf } from './access';

/** What a page view counts as: the public pages and the download page's two faces (never an id or a name). */
export type PageKind = 'home' | 'report' | 'privacy' | 'download' | 'gone';
/**
 * The kind of client, from the User-Agent (see visitorOf() in src/index.ts); the string itself is never kept. `script`
 * is a browser's User-Agent without an Accept-Language. `own` is fyl's own tools and the operator's checks: never
 * written as a page view.
 */
export type Visitor = 'browser' | 'cli' | 'curl' | 'wget' | 'bot' | 'script' | 'other' | 'own';

/** Characters a campaign tag keeps (code points), and a referrer host. */
const UTM_MAX = 40, HOST_MAX = 100;
const lower = (value: string) => value.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** Hosts of a private network or of no public site: a name without a dot, or one of these suffixes. */
const PRIVATE = ['localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'home.arpa', 'fritz.box', 'test', 'invalid', 'example'];
/** The kinds of fyl.at's own page a visit came from (referrerOf()), as the dashboard reads them. */
const OWN_REFERRERS = ['fyl:download', 'fyl:report', 'fyl:site'] as const;
/**
 * The site that linked here: `direct` without a Referer (fyl.at's pages send none: Referrer-Policy no-referrer, except
 * the download page and the report form, which send it to their own origin), for fyl.at's own hosts the kind of page
 * (`fyl:download` for a download page, `fyl:report` for the report form's host, `fyl:site` for any other; stored up to
 * 2026-11 as `internal`), `ip` for an address instead of a name, also one written into a name (`10-0-0-5.nip.io`),
 * `private` for a machine on a private network (`nas.local`, a name without a dot), `other` for anything that is no
 * web or app address; else the host in lower case without `www.`. Only the host or the class: never a path, an id or
 * a query, and never an address or a private machine's name.
 */
function referrerOf(request: Request, own: Set<string>, reportHost: string) {
  const value = request.headers.get('Referer');
  if (!value) return 'direct';
  let url: URL;
  try { url = new URL(value); } catch { return 'other'; }
  if (!['http:', 'https:', 'android-app:'].includes(url.protocol) || !url.hostname) return 'other';
  const host = lower(url.hostname);
  if (own.has(host)) {
    // Without a report host (local development) the form is the public host's /<lang>/report (or the old /report).
    if (reportHost ? host === reportHost : /^\/(?:[a-z]{2}\/)?report(?:\.html)?$/.test(url.pathname)) return 'fyl:report';
    return url.pathname.startsWith('/d/') ? 'fyl:download' : 'fyl:site';
  }
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || /(?:^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(?:[.-]|$)/.test(host)) return 'ip';
  if (!host.includes('.') || PRIVATE.some(suffix => host === suffix || host.endsWith('.' + suffix))) return 'private';
  return host.slice(0, HOST_MAX);
}

/**
 * A utm_source or utm_campaign tag: without controls, NFKC, trimmed, lower case, spaces as `-`; '' without one. A tag
 * is kept only as a short plain name (letters, digits, `.`, `_`, `-`, at most UTM_MAX); anything else, and anything
 * that looks like an id (6 digits or 16 hex characters in a row), is stored as `other`, so an e-mail address or a
 * subscriber id in a link never reaches the data.
 */
function utmOf(url: URL, name: string) {
  const tag = (url.searchParams.get(name) || '').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag) return '';
  return new RegExp(`^[a-z0-9][a-z0-9._-]{0,${UTM_MAX - 1}}$`).test(tag) && !/\d{6,}|[0-9a-f]{16,}/.test(tag) ? tag : 'other';
}

/** The visitor's country as Cloudflare names it (two letters, XX unknown, T1 Tor), or ''. */
function countryOf(request: Request) {
  const value = (request.headers.get('CF-IPCountry') || String(request.cf?.country ?? '')).trim().toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(value) ? value : '';
}

/** A browser's device class, coarse: Sec-CH-UA-Mobile when it says mobile, else the User-Agent's usual markers. */
function deviceOf(request: Request) {
  const agent = request.headers.get('User-Agent') || '';
  if (request.headers.get('Sec-CH-UA-Mobile') === '?1') return 'mobile';
  if (/iPad|Tablet|Kindle|Silk\/|PlayBook/i.test(agent) || (/Android/i.test(agent) && !/Mobile/i.test(agent))) return 'tablet';
  return /Mobi|iPhone|iPod|Windows Phone|BlackBerry|BB10|Opera Mini|IEMobile/i.test(agent) ? 'mobile' : 'desktop';
}

/**
 * The first language the browser asks for, its primary subtag of two or three letters (`de` of `de-AT,de;q=0.9`,
 * `fil` of `fil-PH`), `und` (undetermined) when the header names none (`*`), '' without the header.
 */
function languageOf(request: Request) {
  const header = (request.headers.get('Accept-Language') || '').trim();
  if (!header) return '';
  const primary = /^([a-z]{2,3})(?:[-_][a-z0-9-]*)?$/i.exec(header.split(',')[0].split(';')[0].trim())?.[1];
  return primary ? primary.toLowerCase() : 'und';
}

/** Why a closed link's page says it closed (gonePage() in src/index.ts), for page views of kind `gone`. */
const GONE_REASONS = ['expired', 'consumed', 'deleted', 'removed', 'quarantined', 'unsupported_mode', 'busy', 'missing'];
/**
 * Counts a page shown to a GET (not HEAD, not the unlock form's POST): `page_view` with the page kind as its code and,
 * from blob3 on, the referrer host, utm_source, utm_campaign, country, device class (browsers only, '' for other
 * clients), client kind, primary language (browsers only, as the privacy page says) and for a closed link why it
 * closed ('' for every other page). No address, id, name, cookie or User-Agent: nothing identifies a visitor.
 * fyl's own tools (`own`) are not counted at all.
 */
export function pageView(env: Env, request: Request, kind: PageKind, client: Visitor, reason = '') {
  if (request.method !== 'GET' || client === 'own') return;
  const url = new URL(request.url);
  let base = '';
  try { base = new URL(env.PUBLIC_BASE_URL).hostname; } catch { /* the request's own host still counts */ }
  const report = lower(reportHostOf(env)), own = new Set([url.hostname, base, adminHostOf(env), report].filter(Boolean).map(lower));
  metric(env, 'page_view', kind, 1, [referrerOf(request, own, report), utmOf(url, 'utm_source'), utmOf(url, 'utm_campaign'), countryOf(request),
    client === 'browser' ? deviceOf(request) : '', client, client === 'browser' ? languageOf(request) : '',
    kind === 'gone' && GONE_REASONS.includes(reason) ? reason : '']);
}

/** The ranges the dashboard offers, in days; a day is shown by the hour, longer ranges by the day. */
const RANGES: Readonly<Record<string, number>> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
/** The Analytics Engine dataset the METRICS binding writes (wrangler.jsonc). */
export const DATASET = 'fyl_events';
const CACHE_S = 60, SQL_TIMEOUT_MS = 10000, TOP = 20;
/**
 * The version of shape()'s answer, part of the cache key: bump it whenever the answer changes, so a dashboard just
 * deployed never reads a body of the old shape from a location's cache (kept CACHE_S seconds).
 */
export const SHAPE_VERSION = 12;
/** The location's cache key of a range's statistics (tests clear it). */
export const statsCacheKey = (origin: string, account: string, range: string) => new Request(new URL(`/__stats/v${SHAPE_VERSION}/${account}/${range}`, origin));
const LIMITS = { series: 20000, events: 2000, referrers: 2000, campaigns: 2000, audience: 10000, sizes: 100, median: 10, lifetimes: 200, uploads: 500, transfers: 2000, closed: 500 };
/** Downloads per closed transfer, as buckets [name, lowest, highest]. */
const DOWNLOADS: [string, number, number][] = [['0', 0, 0], ['1', 1, 1], ['2–5', 2, 5], ['6–20', 6, 20], ['>20', 21, Number.POSITIVE_INFINITY]];
/** Upload size buckets, smallest first, as the sizes query names them (binary units, like the site). */
const SIZES = ['<1 MB', '1–100 MB', '100 MB–1 GB', '≥1 GB'];
/**
 * When each charted kind began to be counted, as the first rows in fyl_events show it: uploads with the dataset
 * (2026-10-28), downloads and how transfers ended (stored_gb_days, completion_lifetime) with the release of 2026-10-30,
 * browser page views that night. A range that starts earlier shows those buckets as not counted yet. Fixed, not read
 * from the data: a quiet night without uploads looks the same as one before they were counted.
 */
export const COUNTED_SINCE = { pageViews: Date.parse('2026-10-30T23:00:00Z'), uploads: Date.parse('2026-10-28T16:00:00Z'),
  downloads: Date.parse('2026-10-30T16:00:00Z'), transfers: Date.parse('2026-10-30T16:00:00Z') };
type Since = typeof COUNTED_SINCE;

type Row = Record<string, unknown>;
type Rows = Record<keyof typeof LIMITS, Row[]>;
interface Count { name: string; n: number }
/** The names a ranked list left out beyond TOP, per list. */
type Cut = Record<string, { names: number; n: number }>;
/**
 * A bucket: browser page views (and the home page's), automated ones, uploads completed (and the browsers'), their
 * bytes, uploads the browsers started, downloads started; fyl's own never.
 */
interface Point { t: string; pageViews: number; homeViews: number; automatedViews: number; uploads: number; uploadBytes: number; webStarted: number; webUploads: number; downloads: number }

/**
 * Who counts as a visitor, everywhere on the dashboard (tile, chart, pages, referrers, campaigns, countries, devices,
 * languages): a page view by a browser that named a language. curl, wget, the fyl CLI, bots, scripts and other tools
 * are automated traffic, shown apart; fyl's own tools are never written at all (`own`). Filtering at query time also
 * applies to stored history, where a browser without an Accept-Language was still written as `browser`.
 */
const isVisitor = (row: Row) => row.client === 'browser' && text(row.language) !== '';
/** A page view's kind of client as the dashboard shows it: a browser without a language is a script, also in history. */
/** A referrer that is one of fyl.at's own pages: a kind of it, or `internal` as stored before the kinds. */
const ownReferrer = (name: string) => name === 'internal' || (OWN_REFERRERS as readonly string[]).includes(name);
const kindOf = (row: Row) => row.client === 'browser' && !text(row.language) ? 'script' : text(row.client) || 'other';

/**
 * The queries behind the dashboard; counts are SUM(_sample_interval), since Analytics Engine samples at volume. The
 * series, referrers and campaigns carry the client and the language (blob8 and blob9, '' for other events) so shape()
 * can keep visitors apart; the series takes an upload's kind of client from blob3 (`own`: fyl's own, left out) and an
 * upload start's from its code. Campaigns are a query of their own, so visitors' free-text tags never push referrers
 * past the LIMIT.
 */
export function statsQueries(days: number, now: number): Record<keyof typeof LIMITS, string> {
  const since = `timestamp >= toDateTime(${windowOf(days, now).start / 1000})`, counted = 'SUM(_sample_interval) AS n, SUM(_sample_interval * double1) AS total';
  return {
    series: `SELECT toStartOfInterval(timestamp, INTERVAL '1' ${days === 1 ? 'HOUR' : `DAY, '${TIME_ZONE}'`}) AS t, blob1 AS event, blob2 AS code, `
      + `if(blob1 = 'upload_completed', blob3, blob8) AS client, blob9 AS language, ${counted} FROM ${DATASET} WHERE ${since} `
      + `AND blob1 IN ('page_view', 'upload_completed', 'upload_started', 'download_started') GROUP BY t, event, code, client, language ORDER BY t LIMIT ${LIMITS.series}`,
    events: `SELECT blob1 AS event, blob2 AS code, ${counted}, MAX(double1) AS peak FROM ${DATASET} WHERE ${since} GROUP BY event, code ORDER BY n DESC LIMIT ${LIMITS.events}`,
    referrers: `SELECT blob3 AS referrer, blob8 AS client, blob9 AS language, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} AND blob1 = 'page_view' `
      + `GROUP BY referrer, client, language ORDER BY n DESC LIMIT ${LIMITS.referrers}`,
    campaigns: `SELECT blob4 AS source, blob5 AS campaign, blob8 AS client, blob9 AS language, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} `
      + `AND blob1 = 'page_view' AND (blob4 != '' OR blob5 != '') GROUP BY source, campaign, client, language ORDER BY n DESC LIMIT ${LIMITS.campaigns}`,
    // Uploads by size bucket (nested if(): the SQL API has no multiIf) and their weighted median: an average hides that
    // a few huge files carry most of the bytes.
    sizes: `SELECT if(double1 < 1048576, '${SIZES[0]}', if(double1 < 104857600, '${SIZES[1]}', if(double1 < 1073741824, '${SIZES[2]}', '${SIZES[3]}'))) AS bucket, `
      + `SUM(_sample_interval) AS n, SUM(_sample_interval * double1) AS bytes FROM ${DATASET} WHERE ${since} AND blob1 = 'upload_completed' AND blob3 != 'own' `
      + `GROUP BY bucket LIMIT ${LIMITS.sizes}`,
    median: `SELECT quantileExactWeighted(0.5)(double1, _sample_interval) AS median FROM ${DATASET} WHERE ${since} AND blob1 = 'upload_completed' AND blob3 != 'own' `
      + `LIMIT ${LIMITS.median}`,
    // The lifetimes senders chose, in seconds (a handful of choices).
    lifetimes: `SELECT double1 AS lifetime, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} AND blob1 = 'completion_lifetime' AND blob3 != 'own' `
      + `GROUP BY lifetime ORDER BY lifetime LIMIT ${LIMITS.lifetimes}`,
    // Completed uploads by mode, kind of client and options ('' in blob3 to blob5: written before they were recorded).
    uploads: `SELECT blob2 AS mode, blob3 AS client, blob4 AS password, blob5 AS once, ${counted} FROM ${DATASET} WHERE ${since} `
      + `AND blob1 = 'upload_completed' GROUP BY mode, client, password, once LIMIT ${LIMITS.uploads}`,
    // Transfers closed by cleanup: how they ended, the kind of client, how often they were downloaded (double2, written
    // since the kind of client is), with their GB-days.
    transfers: `SELECT blob2 AS outcome, blob3 AS client, double2 AS downloads, ${counted} FROM ${DATASET} WHERE ${since} AND blob1 = 'stored_gb_days' `
      + `GROUP BY outcome, client, downloads LIMIT ${LIMITS.transfers}`,
    // Closed-link pages by why the link closed (blob10, '' before it was recorded), with the client and language.
    closed: `SELECT blob10 AS reason, blob8 AS client, blob9 AS language, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} AND blob1 = 'page_view' `
      + `AND blob2 = 'gone' GROUP BY reason, client, language ORDER BY n DESC LIMIT ${LIMITS.closed}`,
    audience: `SELECT blob6 AS country, blob7 AS device, blob8 AS client, blob9 AS language, SUM(_sample_interval) AS n FROM ${DATASET} `
      + `WHERE ${since} AND blob1 = 'page_view' GROUP BY country, device, client, language ORDER BY n DESC LIMIT ${LIMITS.audience}`,
  };
}

/**
 * The dashboard's days are Vienna days (the owner's); hours are UTC hours, which are Vienna's hours too (its offsets are
 * whole hours), so only their labels change. Days are 23 to 25 hours long around a DST change.
 */
const TIME_ZONE = 'Europe/Vienna';
const zoned = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** The Vienna calendar date of an instant, 'YYYY-MM-DD'. */
const localDate = (time: number) => zoned.format(time).slice(0, 10);
/** The instant Vienna's day `date` begins (midnight is never inside a DST change, which happens at 02:00 or 03:00). */
export function midnight(date: string) {
  const guess = Date.parse(date + 'T00:00:00Z'), offset = (time: number) => Date.parse(zoned.format(time).replace(' ', 'T') + 'Z') - time;
  return guess - offset(guess - offset(guess));
}
const addDays = (date: string, days: number) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/**
 * A range's buckets: 24 whole hours or `days` whole Vienna days, oldest first, the last one the current (partial)
 * bucket, each with its key and the instant it starts. Every query starts at the first bucket's start, so the totals
 * equal the bars and only the last bar is partial. `keyOf` gives the bucket key of an instant.
 */
export function windowOf(days: number, now: number) {
  const hourly = days === 1;
  const keyOf = hourly ? (time: number) => new Date(time).toISOString().slice(0, 13) : localDate;
  const buckets = hourly
    ? Array.from({ length: 24 }, (_, index) => { const time = (Math.floor(now / 3600000) - 23 + index) * 3600000; return { key: keyOf(time), time }; })
    : Array.from({ length: days }, (_, index) => { const key = addDays(localDate(now), index - days + 1); return { key, time: midnight(key) }; });
  return { hourly, buckets, keyOf, start: buckets[0].time, partial: buckets[buckets.length - 1].key };
}
/**
 * The bucket key of a series row's `t`: an hour as given (UTC); a day from toStartOfInterval(…, TIME_ZONE), which
 * names Vienna's midnight as its local time ('2026-10-31 00:00:00'); an instant in UTC that is not (were the SQL API
 * to answer that way) is turned into its Vienna date. Vienna's midnight is never 00:00 UTC, so the two can't mix up.
 */
function bucketOf(t: string, hourly: boolean) {
  const stamp = t.replace(' ', 'T');
  if (hourly || /T00:00:00/.test(stamp)) return stamp.slice(0, hourly ? 13 : 10);
  const time = Date.parse(stamp.slice(0, 19) + 'Z');
  return Number.isFinite(time) ? localDate(time) : '';
}

const num = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : 0; };
/** A fractional total (GB-days, an average) to two decimals, where num() would round 0.33 to 0. */
const dec = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0; };
const text = (value: unknown) => typeof value === 'string' ? value : '';
/**
 * The largest counts first (then by name), at most TOP, without empty names where `named`. What falls beyond TOP goes
 * into `cut` under `list` (how many names, their summed count), so the dashboard's "N more" row stays right.
 */
function ranked(counts: Map<string, number>, named = false, cut?: Cut, list?: string): Count[] {
  const all = [...counts].filter(([name, n]) => n > 0 && (!named || name)).map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return cut && list ? top(all, cut, list) : all.slice(0, TOP);
}
/** The first TOP of a sorted list, with the rest counted in `cut` like ranked(). */
function top<T extends { n: number }>(all: T[], cut: Cut, list: string) {
  if (all.length > TOP) cut[list] = { names: all.length - TOP, n: all.slice(TOP).reduce((total, entry) => total + entry.n, 0) };
  return all.slice(0, TOP);
}
function tally(rows: Row[], field: string) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(text(row[field]), (counts.get(text(row[field])) || 0) + num(row.n));
  return counts;
}

/** The dashboard's JSON from the query rows: aggregates only, every bucket of the range present (zero when empty). */
export function shape(range: string, rows: Rows, now: number, since: Since = COUNTED_SINCE) {
  const { hourly, buckets: keys, keyOf, start, partial } = windowOf(RANGES[range], now);
  const buckets = new Map<string, Point>();
  for (const { key } of keys)
    buckets.set(key, { t: key, pageViews: 0, homeViews: 0, automatedViews: 0, uploads: 0, uploadBytes: 0, webStarted: 0, webUploads: 0, downloads: 0 });
  // Page views by page and client, from the series rows in the range (so the tile, the chart and Pages agree).
  const pages = new Map<string, number>(), automated: Record<string, number> = {};
  // The buckets with an upload that names its kind of client (or a start), and those with one that doesn't.
  const labelled = new Set<string>(), unlabelled = new Set<string>();
  for (const row of rows.series) {
    const point = buckets.get(bucketOf(text(row.t), hourly));
    if (!point) continue;
    if (row.event === 'page_view' && isVisitor(row)) {
      point.pageViews += num(row.n); pages.set(text(row.code), (pages.get(text(row.code)) || 0) + num(row.n));
      if (row.code === 'home') point.homeViews += num(row.n);
    } else if (row.event === 'page_view') { point.automatedViews += num(row.n); automated[kindOf(row)] = (automated[kindOf(row)] || 0) + num(row.n); }
    else if (row.event === 'upload_completed') {
      (text(row.client) ? labelled : unlabelled).add(point.t);
      if (row.client === 'own') continue;
      point.uploads += num(row.n); point.uploadBytes += num(row.total);
      if (row.client === 'browser') point.webUploads += num(row.n);
    } else if (row.event === 'upload_started') { labelled.add(point.t); if (row.code === 'browser') point.webStarted += num(row.n); }
    else if (row.event === 'download_started' && row.code !== 'own') point.downloads += num(row.n);
  }
  // Uploads are counted by kind of client since the release after 2.4.0: from then on every completed upload names it
  // in blob3 (fyl's own `own`, one begun before `unknown`) and every admitted one writes upload_started. So only an
  // upload without one (written before, or under a rollback to 2.4.0) shows a bucket wasn't counted by client; a quiet
  // stretch, or one of CLI uploads only, never does. Counting began in the first bucket from the last such one on that
  // has a labelled upload or a start (the next bucket when none followed yet); the funnel and the lists by client say
  // since when. Null when the range holds no upload without a kind, or counting began in its first bucket.
  const points = [...buckets.values()], last = points.map(point => unlabelled.has(point.t)).lastIndexOf(true);
  let begun = last < 0 ? 0 : points.findIndex((point, index) => index >= last && labelled.has(point.t));
  if (begun < 0) begun = Math.min(last + 1, points.length - 1);
  const clientsSince = begun > 0 ? points[begun].t : null;
  const events = rows.events.map(row => ({ event: text(row.event), code: text(row.code), n: num(row.n), total: num(row.total), exact: dec(row.total), peak: dec(row.peak) }));
  // Per kind, the bucket counting began in when the range starts before it (those buckets are not counted yet, not
  // zero), else null.
  const firstSeen = Object.fromEntries(Object.entries(since).map(([kind, time]) => [kind, time > start ? keyOf(time) : null])) as Record<keyof Since, string | null>;
  const of = (event: string) => events.filter(row => row.event === event);
  const sum = (event: string, field: 'n' | 'total' = 'n') => of(event).reduce((total, row) => total + row[field], 0);
  // A part write that broke because its sender went away (code `disconnected`) is no fault: kept apart from the failures.
  const disconnected = (field: 'n' | 'total' = 'n') => of('part_failed').filter(row => row.code === 'disconnected').reduce((total, row) => total + row[field], 0);
  const failed = (field: 'n' | 'total' = 'n') => sum('part_failed', field) - disconnected(field);
  const peak = (event: string) => of(event).length ? Math.max(...of(event).map(row => row.peak)) : null;
  const cut: Cut = {};
  const codes = (event: string, list?: string) => ranked(new Map(of(event).map(row => [row.code, row.n])), false, cut, list);
  // fyl's own checks download too (code `own`): counted apart, never in the Downloads tile or its list.
  const own = of('download_started').filter(row => row.code === 'own').reduce((total, row) => ({ n: total.n + row.n, total: total.total + row.total }), { n: 0, total: 0 });
  const campaigns = new Map<string, { source: string; campaign: string; n: number }>(), visitors = (list: Row[]) => list.filter(isVisitor);
  const sites = tally(visitors(rows.referrers), 'referrer');
  // Completed uploads: fyl's own (the smoke test's CLI) apart. The kind of client and the options are known for rows
  // written since they are recorded (blob3 not ''); the kind itself not for an upload started before (`unknown`).
  const uploads = rows.uploads.map(row => ({ mode: text(row.mode), client: text(row.client), password: text(row.password), once: text(row.once), n: num(row.n), total: num(row.total) }));
  const theirs = uploads.filter(row => row.client !== 'own'), add = (list: { n: number }[]) => list.reduce((total, row) => total + row.n, 0);
  const optioned = theirs.filter(row => row.client), channeled = optioned.filter(row => row.client !== 'unknown');
  // Transfers closed by cleanup, fyl's own apart.
  const closed = rows.transfers.map(row => ({ outcome: text(row.outcome), client: text(row.client), downloads: num(row.downloads), n: num(row.n), gbDays: Number(row.total) || 0 }))
    .filter(row => row.client !== 'own' && row.n > 0);
  // How often they were downloaded, known for the rows written since the kind of client is (blob3 not ''), fewest first.
  const downloaded = closed.filter(row => row.client).sort((a, b) => a.downloads - b.downloads), half = add(downloaded) / 2;
  let running = 0, median: number | null = null;
  for (const row of downloaded) {
    running += row.n;
    if (running >= half) { median = row.downloads; break; }
  }
  for (const row of visitors(rows.campaigns)) {
    const source = text(row.source), campaign = text(row.campaign);
    if (!source && !campaign) continue;
    const entry = campaigns.get(source + '\n' + campaign) || { source, campaign, n: 0 };
    entry.n += num(row.n);
    campaigns.set(source + '\n' + campaign, entry);
  }
  return {
    range, bucket: hourly ? 'hour' : 'day', generatedAt: now, sample: false, timeZone: TIME_ZONE, partial,
    firstSeen: { ...firstSeen, clients: clientsSince },
    // The queries that hit their LIMIT, so the dashboard can say what may be low. Not rows_before_limit_at_least: for a
    // grouped or aggregate query Analytics Engine reports the rows read there, so the sizes and the median always looked cut.
    truncated: (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter(name => rows[name].length >= LIMITS[name]),
    totals: { pageViews: [...pages.values()].reduce((total, n) => total + n, 0), automatedViews: automated, uploads: add(theirs), uploadBytes: theirs.reduce((total, row) => total + row.total, 0),
      uploadsEncrypted: add(theirs.filter(row => row.mode === 'e2ee')), ownUploads: add(uploads.filter(row => row.client === 'own')),
      // The bases of Uploads by client and Upload options: the uploads whose kind of client, or options, were recorded.
      uploadsWithClient: add(channeled), uploadsWithOptions: add(optioned),
      medianUploadBytes: add(theirs) ? num(rows.median[0]?.median) : null,
      // Downloads per transfer: closed transfers (its base), those with a download count (the rest closed before it was
      // recorded and can't be dated: stored_gb_days is written at cleanup), the count's median and the most.
      transfersClosed: add(closed), transfersWithDownloads: add(downloaded), medianDownloads: median, maxDownloads: downloaded.length ? downloaded[downloaded.length - 1].downloads : null,
      downloads: sum('download_started') - own.n, oneTimeDownloads: sum('download_started', 'total') - own.total, ownDownloads: own.n,
      oneTimeSessions: sum('one_time_session') },
    series: points,
    pages: ranked(pages, false, cut, 'pages'),
    // Other sites; visits from fyl.at's own pages are counted apart, by kind (`unsplit`: stored as `internal` before).
    referrers: ranked(new Map([...sites].filter(([name]) => !ownReferrer(name))), true, cut, 'referrers'),
    ownReferrers: { download: sites.get('fyl:download') || 0, report: sites.get('fyl:report') || 0, site: sites.get('fyl:site') || 0, unsplit: sites.get('internal') || 0 },
    campaigns: top([...campaigns.values()].sort((a, b) => b.n - a.n || a.source.localeCompare(b.source) || a.campaign.localeCompare(b.campaign)), cut, 'campaigns'),
    countries: ranked(tally(visitors(rows.audience), 'country'), true, cut, 'countries'),
    devices: ranked(tally(visitors(rows.audience), 'device'), true, cut, 'devices'),
    // Every client, automated ones included: the one place automated traffic is broken down.
    clients: ranked(tally(rows.audience.map(row => ({ ...row, client: kindOf(row) })), 'client'), true, cut, 'clients'),
    languages: ranked(tally(visitors(rows.audience), 'language'), true, cut, 'languages'),
    uploadSizes: SIZES.map(name => rows.sizes.filter(row => row.bucket === name)
      .reduce<{ name: string; n: number; bytes: number }>((entry, row) => ({ name, n: entry.n + num(row.n), bytes: entry.bytes + num(row.bytes) }), { name, n: 0, bytes: 0 }))
      .filter(entry => entry.n > 0),
    downloadsByClient: ranked(new Map(of('download_started').filter(row => row.code !== 'own').map(row => [row.code, row.n])), false, cut, 'downloadsByClient'),
    uploadsByClient: ranked(tally(channeled, 'client'), true, cut, 'uploadsByClient'),
    // Uploads admitted by kind of client (upload_started; none of fyl's own), for the funnel.
    uploadsStarted: ranked(new Map(of('upload_started').filter(row => row.code !== 'own').map(row => [row.code, row.n])), true),
    // Options can combine: each counts on its own, `none` is an upload without any.
    uploadOptions: ranked(new Map([['password', add(optioned.filter(row => row.password))], ['once', add(optioned.filter(row => row.once))],
      ['e2ee', add(optioned.filter(row => row.mode === 'e2ee'))], ['none', add(optioned.filter(row => !row.password && !row.once && row.mode !== 'e2ee'))]]), true),
    passwords: { ok: sum('password_ok'), wrong: sum('password_wrong'), paused: sum('password_paused') },
    reportsByCategory: codes('report_received'),
    moderation: { quarantine: sum('quarantine'), restore: sum('restore'), takedown: sum('takedown') },
    budgetRefused: codes('budget_refused'), rateLimited: codes('rate_limited'), turnstileFailed: codes('turnstile_failed'),
    cleanupRetry: codes('cleanup_retry'), accessDenied: codes('access_denied'),
    previewServed: { n: sum('preview_served'), bytes: sum('preview_served', 'total') },
    // The CLI's installer and binaries by platform, fetched with a GET answered 200 (none of fyl's own).
    cliFetches: codes('cli_fetch', 'cliFetches'),
    misconfigured: sum('misconfigured'),
    // How transfers closed in the range ended, with the GB-days R2 held them (stored_gb_days at cleanup).
    outcomes: ranked(tally(closed, 'outcome'), true).map(entry => ({ ...entry,
      gbDays: dec(closed.filter(row => row.outcome === entry.name).reduce((total, row) => total + row.gbDays, 0)) })),
    downloadsPerTransfer: DOWNLOADS.map(([name, low, high]) => ({ name, n: add(downloaded.filter(row => row.downloads >= low && row.downloads <= high)) })).filter(entry => entry.n > 0),
    // Visitors' views of closed links by why the link closed; '' (before the reason was recorded) is left to the dashboard.
    closedReasons: ranked(tally(visitors(rows.closed), 'reason'), true, cut, 'closedReasons'),
    lifetimes: rows.lifetimes.map(row => ({ seconds: num(row.lifetime), n: num(row.n) })).filter(entry => entry.n > 0 && entry.seconds > 0),
    performance: {
      completionAvgMs: sum('completion_ms') ? Math.round(sum('completion_ms', 'total') / sum('completion_ms')) : null,
      completionMaxMs: peak('completion_ms'), cleanupLagMaxS: peak('cleanup_age'),
      partFailedPct: sum('part_confirmed') + failed() ? dec(failed() * 100 / (sum('part_confirmed') + failed())) : null,
    },
    // Counters that should stay at or near zero; the dashboard shows the ones that aren't.
    health: { partFailed: { n: failed(), bytes: failed('total') }, partDisconnected: { n: disconnected(), bytes: disconnected('total') }, partRefused: codes('part_refused'), partLimit: sum('part_limit'),
      partBusy: sum('part_busy'), fallback: codes('fallback'), budgetDrift: codes('budget_drift'), cleanupOrphan: sum('cleanup_orphan'),
      oneTimeInterrupted: sum('one_time_interrupted'), earlyWait: sum('early_wait') },
    // Every event and code of the range as counted, for the closed "All counters" table.
    counters: events.map(({ event, code, n, exact }) => ({ event, code, n, total: exact })).sort((a, b) => a.event.localeCompare(b.event) || b.n - a.n || a.code.localeCompare(b.code)),
    cut,
  };
}

/** One SQL query against the Analytics Engine SQL API with the read-only CF_ANALYTICS_TOKEN: its rows, or an error. */
async function query(account: string, token: string, sql: string): Promise<Row[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: sql, signal: AbortSignal.timeout(SQL_TIMEOUT_MS),
  });
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!isObject(body) || !Array.isArray(body.data)) throw new Error(`Analytics Engine answered ${response.status}`, { cause: response.status });
  return body.data.filter(isObject);
}

/** The sample's uploads by kind of client. */
const UPLOAD_CLIENTS = [['browser', 0.6], ['cli', 0.28], ['curl', 0.06], ['other', 0.02], ['unknown', 0.04]] as const;
/** When the sample's kinds began to be counted: page views 18 days ago (30 and 90 days show the band), the rest always. */
export const sampleSince = (now: number): Since => ({ pageViews: now - 18 * 86400000, uploads: 0, downloads: 0, transfers: 0 });

/** A small deterministic generator, so the sample dashboard looks the same on every reload. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Rows as the queries would answer them, made up: for local development (DEV_FAKE_STATS), marked `sample`. */
function sampleRows(range: string, now: number): Rows {
  const days = RANGES[range], { hourly, buckets } = windowOf(days, now), random = seeded(days * 7919);
  const pick = <T>(list: [T, number][]) => {
    let roll = random() * list.reduce((total, [, weight]) => total + weight, 0);
    for (const [value, weight] of list) { roll -= weight; if (roll <= 0) return value; }
    return list[0][0];
  };
  // As the SQL API names the buckets: a UTC hour, or a Vienna day at its local midnight.
  const series: Row[] = [], stamp = (key: string) => hourly ? key.replace('T', ' ') + ':00:00' : key + ' 00:00:00';
  // Shaped like production: fewer than half the page views are browsers', the home page leads, and page views were
  // counted only from sampleSince() on (the other events from the start), so 30 and 90 days show the band.
  // A quarter of the browser names come without a language: scripts.
  const clients: [string, number][] = [['browser', 40], ['curl', 25], ['other', 20], ['bot', 10], ['script', 10], ['cli', 5]], share = clients.reduce((total, [, weight]) => total + weight, 0);
  const pagesFrom = sampleSince(now).pageViews;
  for (const { key, time } of buckets) {
    const scale = hourly ? 0.12 : 1, wave = 1 + 0.35 * Math.sin(time / 86400000 / 1.3);
    if (time + (hourly ? 3600000 : 86400000) > pagesFrom) for (const [kind, base] of [['home', 260], ['download', 60], ['report', 25], ['gone', 12], ['privacy', 8]] as const)
      for (const [client, weight] of clients)
        series.push({ t: stamp(key), event: 'page_view', code: kind, client, language: client === 'browser' ? 'de' : '', n: Math.round(base * weight / share * scale * wave * (0.7 + random() * 0.6)), total: 0 });
    // Uploads by kind of client: the web leads, then the CLI; a few were started before the kind was recorded
    // (`unknown`). Some web uploads are abandoned before they complete, almost no CLI ones.
    const uploads = Math.round(55 * scale * wave * (0.6 + random() * 0.8)), average = (180 + random() * 900) * 1048576;
    for (const [client, part] of UPLOAD_CLIENTS) {
      const n = Math.round(uploads * part);
      series.push({ t: stamp(key), event: 'upload_completed', code: '', client, n, total: Math.round(n * average) });
      if (client !== 'unknown') series.push({ t: stamp(key), event: 'upload_started', code: client, client: '', n: Math.round(n * (client === 'browser' ? 1.09 : 1.02)), total: 0 });
    }
    // fyl's own checks download too (`own`, left out of the Downloads tile and chart).
    for (const [client, base] of [['browser', 80], ['curl', 25], ['cli', 14], ['wget', 3], ['own', 4]] as const)
      series.push({ t: stamp(key), event: 'download_started', code: client, client: '', n: Math.round(base * scale * wave * (0.6 + random() * 0.8)), total: Math.round(base * scale * 0.1) });
  }
  const totals = new Map<string, { n: number; total: number }>();
  for (const row of series) {
    const name = `${row.event}\n${row.code}`, entry = totals.get(name) || { n: 0, total: 0 };
    entry.n += num(row.n); entry.total += num(row.total); totals.set(name, entry);
  }
  const extra: [string, string, number, number][] = [['one_time_session', '', 40, 0], ['password_ok', '', 120, 0], ['password_wrong', '', 31, 0], ['password_paused', '', 3, 0],
    ['report_received', 'malware', 4, 0], ['report_received', 'copyright', 2, 0], ['report_received', 'phishing', 1, 0], ['quarantine', '', 2, 0], ['takedown', '', 1, 0],
    ['budget_refused', 'network_bytes', 5, 0], ['rate_limited', 'part', 12, 0], ['rate_limited', 'download', 4, 0], ['preview_served', 'png', 22, 22 * 900000],
    ['cleanup_retry', 'r2_delete', 1, 0], ['turnstile_failed', 'expired', 3, 0], ['turnstile_failed', 'missing', 6, 0],
    ['completion_ms', '', 380, 380 * 220], ['part_confirmed', '', 3900, 3900 * 16 * 1048576], ['part_failed', '', 3, 3 * 16 * 1048576], ['cleanup_age', '', 380, 380 * 45],
    ['fallback', 'part_release', 1, 1], ['early_wait', '', 9, 9], ['one_time_interrupted', '', 2, 2],
    ['cli_fetch', 'install', 18, 18], ['cli_fetch', 'linux-x86_64', 9, 9], ['cli_fetch', 'macos-arm64', 7, 7], ['cli_fetch', 'linux-arm64', 2, 2], ['cli_fetch', 'macos-x86_64', 1, 1]];
  const peaks: Record<string, number> = { completion_ms: 442, cleanup_age: 310, part_failed: 16 * 1048576, part_confirmed: 16 * 1048576 };
  const events: Row[] = [...[...totals].map(([name, value]) => { const [event, code] = name.split('\n'); return { event, code, ...value }; }),
    // Rounded, so a quiet day has none of the rarer ones (the status strip's last 24 hours stay calm).
    ...extra.map(([event, code, n, total]) => ({ event, code, n: Math.round(n * days / 7), total: total * Math.round(n * days / 7) / n, peak: peaks[event] ?? 1 })).filter(row => row.n > 0)];
  // The events the per-transfer rows below add up to, as the events query would count them too.
  const counted = (event: string, list: Row[], code: (row: Row) => string, total: (row: Row) => number = () => 0) => {
    const sums = new Map<string, { n: number; total: number }>();
    for (const row of list) { const entry = sums.get(code(row)) || { n: 0, total: 0 }; entry.n += num(row.n); entry.total += total(row); sums.set(code(row), entry); }
    for (const [name, value] of sums) events.push({ event, code: name, ...value, peak: 1 });
  };
  // The dimensions of each client's page views, drawn one view at a time (at most DRAWS per client, then scaled), so
  // the lists add up to the series' totals.
  const referrers: Row[] = [], campaigns: Row[] = [], audience: Row[] = [], groups = new Map<string, Row>(), DRAWS = 2000;
  // Recipients going from a download page to the home page are most of the visits from fyl.at itself.
  const sites: [string, number][] = [['direct', 60], ['google.com', 12], ['fyl:download', 6], ['github.com', 6], ['news.ycombinator.com', 5], ['reddit.com', 4], ['t.co', 3],
    ['duckduckgo.com', 2], ['private', 2], ['fyl:report', 1], ['fyl:site', 1], ['com.slack', 1], ['bing.com', 1]];
  // More than 20 countries, so the list's cap and its "N more" row show.
  const countries: [string, number][] = [['DE', 34], ['AT', 30], ['US', 12], ['CH', 8], ['NL', 5], ['GB', 5], ['FR', 3], ['XX', 3], ['IT', 2.5], ['ES', 2.2], ['PL', 2], ['SE', 1.8],
    ['CA', 1.6], ['CZ', 1.4], ['DK', 1.2], ['BE', 1.1], ['JP', 1], ['BR', 0.9], ['IN', 0.8], ['IE', 0.7], ['FI', 0.6], ['NO', 0.5], ['HU', 0.4], ['PT', 0.3]];
  const tags: [[string, string], number][] = [[['', ''], 90], [['newsletter', 'launch'], 6], [['mastodon', 'launch'], 3], [['github', 'readme'], 1]];
  const add = (list: Row[], row: Row, weight: number) => {
    const name = String(['r', 'c', 'a'][[referrers, campaigns, audience].indexOf(list)]) + JSON.stringify(row), entry = groups.get(name);
    if (entry) entry.n = Number(entry.n) + weight; else { const created = { ...row, n: weight }; groups.set(name, created); list.push(created); }
  };
  for (const [client] of clients) {
    const views = series.filter(row => row.event === 'page_view' && row.client === client).reduce((total, row) => total + num(row.n), 0);
    const draws = Math.min(views, DRAWS), weight = draws ? views / draws : 0;
    for (let index = 0; index < draws; index++) {
      const [source, campaign] = pick(tags), browser = client === 'browser';
      const language = browser ? pick<string>([['de', 55], ['en', 37], ['nl', 4.5], ['fr', 3], ['und', 0.5]]) : '';
      add(referrers, { referrer: pick(sites), client, language }, weight);
      if (source || campaign) add(campaigns, { source, campaign, client, language }, weight);
      add(audience, { country: pick(countries), device: browser ? pick<string>([['desktop', 58], ['mobile', 36], ['tablet', 6]]) : '', client, language }, weight);
    }
  }
  for (const row of [...referrers, ...campaigns, ...audience]) row.n = Math.round(Number(row.n));
  // Rounding each group may leave a browser view or two over or under the series: the largest row takes the difference.
  const browsers = series.filter(row => row.event === 'page_view' && row.client === 'browser').reduce((total, row) => total + num(row.n), 0);
  const largest = audience.filter(row => row.client === 'browser').sort((a, b) => num(b.n) - num(a.n))[0];
  if (largest) largest.n = num(largest.n) + browsers - audience.filter(row => row.client === 'browser').reduce((total, row) => total + num(row.n), 0);
  // Most uploads are small, a few huge ones carry most of the bytes.
  const uploaded = series.filter(row => row.event === 'upload_completed'), uploads = uploaded.reduce((total, row) => total + num(row.n), 0);
  const sizes = ([[SIZES[0], 0.58, 0.3], [SIZES[1], 0.3, 22], [SIZES[2], 0.09, 380], [SIZES[3], 0.03, 2600]] as const)
    .map(([bucket, part, megabytes]) => ({ bucket, n: Math.round(uploads * part), bytes: Math.round(uploads * part * megabytes * 1048576) }));
  const lifetimes = ([[300, 0.18], [3600, 0.22], [86400, 0.31], [259200, 0.12], [604800, 0.17]] as const).map(([lifetime, part]) => ({ lifetime, n: Math.round(uploads * part) }));
  // The same uploads by options (they combine; the last combination of a client takes what rounding left), and fyl's
  // own smoke runs (`own`, a few a day), which stay out of every figure.
  const uploadRows: Row[] = [];
  for (const [client] of UPLOAD_CLIENTS) {
    const mine = uploaded.filter(row => row.client === client), n = mine.reduce((total, row) => total + num(row.n), 0), bytes = mine.reduce((total, row) => total + num(row.total), 0);
    const combinations = [['', '', '', 0.6], ['', '', 'once', 0.16], ['', 'password', '', 0.1], ['', 'password', 'once', 0.03], ['e2ee', '', '', 0.08], ['e2ee', 'password', 'once', 0.03]] as const;
    let left = n;
    combinations.forEach(([mode, password, once, part], index) => {
      const count = index === combinations.length - 1 ? left : Math.min(left, Math.round(n * part));
      left -= count;
      if (count) uploadRows.push({ mode, client, password, once, n: count, total: n ? Math.round(bytes * count / n) : 0 });
    });
  }
  for (const [mode, password, once] of [['', '', ''], ['', '', 'once'], ['', 'password', ''], ['e2ee', '', '']] as const)
    uploadRows.push({ mode, client: 'own', password, once, n: Math.ceil(days * 1.5), total: Math.ceil(days * 1.5) * 2048 });
  // Closed transfers by how they ended and how often they were downloaded (a one-time link once at most), with the
  // GB-days R2 held them; some closed before the downloads were counted (no client: no count).
  const transfers: Row[] = [];
  const endings: [string, number, number, [number, number][]][] = [['expired', 160, 410.5, [[0, 0.22], [1, 0.36], [2, 0.18], [4, 0.12], [9, 0.08], [41, 0.04]]],
    ['deleted', 120, 61.25, [[0, 0.38], [1, 0.42], [3, 0.2]]], ['consumed', 70, 9.8, [[1, 1]]], ['aborted', 30, 0.33, [[0, 1]]]];
  for (const [outcome, base, gbDays, spread] of endings) {
    const all = Math.ceil(base * days / 7);
    for (const [client, part] of [['browser', 0.58], ['cli', 0.27], ['curl', 0.05], ['unknown', 0.04], ['', 0.06]] as const)
      for (const [downloads, share] of spread) {
        const n = Math.round(all * part * share);
        if (n) transfers.push({ outcome, client, downloads: client ? downloads : 0, n, total: gbDays * days / 7 * part * share });
      }
  }
  transfers.push({ outcome: 'deleted', client: 'own', downloads: 2, n: Math.ceil(days * 4.5), total: 0.001 * days });
  // Visitors' closed-link pages by why the link closed (a few from before the reason was recorded), and some bots'.
  const gone = series.filter(row => row.event === 'page_view' && row.code === 'gone' && row.client === 'browser').reduce((total, row) => total + num(row.n), 0);
  const closed: Row[] = ([['expired', 0.55], ['consumed', 0.18], ['deleted', 0.12], ['missing', 0.07], ['', 0.05], ['removed', 0.02], ['busy', 0.01]] as const)
    .map(([reason, part]) => ({ reason, client: 'browser', language: 'de', n: Math.round(gone * part) }));
  closed.push({ reason: 'expired', client: 'bot', language: '', n: Math.ceil(days / 2) });
  counted('stored_gb_days', transfers, row => text(row.outcome), row => Number(row.total));
  return { series, events, referrers, campaigns, audience, sizes, median: [{ median: 734003 }], lifetimes, uploads: uploadRows, transfers, closed };
}

/** Sample data (statistics, src/billing.ts too) stays local: only on a *.localhost admin host (scripts/dev.mjs) with DEV_FAKE_STATS "1". */
export const fake = (env: Env) => env.DEV_FAKE_STATS === '1' && /(?:^|\.)localhost$/.test(adminHostOf(env));

/**
 * GET /api/stats?range=1d|7d|30d|90d on the admin host: the dashboard's aggregates, read with server-side SQL from
 * Analytics Engine and kept CACHE_S seconds in this Cloudflare location's cache, so a busy dashboard costs one round
 * of queries a minute. Without CF_ANALYTICS_TOKEN 503 `stats_unconfigured`; an SQL API failure 502 `stats_unavailable`
 * (logged with its status only, not cached). The caller checks who may read it.
 */
export async function stats(request: Request, env: Env) {
  const range = new URL(request.url).searchParams.get('range') || '7d';
  if (!Object.hasOwn(RANGES, range)) throw new ApiError(400, 'Use range=1d, 7d, 30d or 90d.');
  if (fake(env)) return json({ ...shape(range, sampleRows(range, Date.now()), Date.now(), sampleSince(Date.now())), sample: true });
  const token = String(env.CF_ANALYTICS_TOKEN ?? '').trim(), account = String(env.ANALYTICS_ACCOUNT_ID ?? '').trim();
  if (!token || !/^[0-9a-f]{32}$/.test(account))
    throw new ApiError(503, 'Statistics need the CF_ANALYTICS_TOKEN secret (a read-only API token with Account Analytics Read).', 'stats_unconfigured');
  const cache = caches.default, key = statsCacheKey(request.url, account, range);
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return json(await hit.json());
  let rows: Rows;
  const now = Date.now();
  try {
    const sql = statsQueries(RANGES[range], now), names = Object.keys(sql) as (keyof typeof LIMITS)[];
    const answers = await Promise.all(names.map(name => query(account, token, sql[name])));
    rows = Object.fromEntries(names.map((name, index) => [name, answers[index]])) as Rows;
  } catch (error) {
    console.error(JSON.stringify({ event: 'stats_failed', status: error instanceof Error && typeof error.cause === 'number' ? error.cause : null }));
    throw new ApiError(502, 'The statistics could not be read from Analytics Engine. Try again in a minute.', 'stats_unavailable');
  }
  const body = shape(range, rows, now);
  await cache.put(key, Response.json(body, { headers: { 'Cache-Control': `max-age=${CACHE_S}` } })).catch(() => undefined);
  return json(body);
}
