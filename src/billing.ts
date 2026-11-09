import { ApiError, isObject, json } from './shared';
import { fake } from './stats';

/**
 * The owner's estimate of the open Cloudflare bill: what the current billing cycle has used so far, read from the
 * GraphQL Analytics API for the whole account (the allowances are account-wide, so nothing is filtered to fyl-at), and
 * priced with the table below. An estimate, never the invoice: reading real billing data needs Billing Read, which
 * also opens the billing profile, and that is not worth giving the Worker. docs/COSTS.md holds the same prices with
 * their sources; change both together.
 */

/** When the prices below were last checked against Cloudflare's pricing pages (docs/COSTS.md). */
export const PRICES_AS_OF = '2026-10-31';
/** The Workers Paid minimum charge per account and month, in dollars; it includes every allowance below. */
export const BASE = 5;

export type MeterId = 'workerRequests' | 'workerCpu' | 'r2Storage' | 'r2ClassA' | 'r2ClassB' | 'objectRequests' | 'objectDuration' | 'rowsRead' | 'rowsWritten';
/**
 * One billed quantity: `included` per month, then `price` dollars per `step` of usage above it. Cloudflare rounds the
 * usage above the allowance up to a whole step before pricing it (R2: "1,000,001 operations are billed as 2 million",
 * "1.1 GB-month as 2"; Durable Objects: "500,000 GB-s … rounded up to 1,000,000"); the Workers page names no rounding,
 * and the estimate rounds it the same way. Every allowance is a whole number of steps, so rounding the usage first
 * and then subtracting gives the same result.
 */
export interface Price { id: MeterId; product: 'Workers' | 'R2' | 'Durable Objects'; name: string; unit: string; included: number; step: number; price: number }
export const PRICES: readonly Price[] = [
  { id: 'workerRequests', product: 'Workers', name: 'Requests', unit: 'requests', included: 10e6, step: 1e6, price: 0.30 },
  { id: 'workerCpu', product: 'Workers', name: 'CPU time', unit: 'ms', included: 30e6, step: 1e6, price: 0.02 },
  // R2 Standard: GB-month is the average of each day's peak (payload and metadata) over the period, 1 GB = 10⁹ bytes.
  { id: 'r2Storage', product: 'R2', name: 'Storage', unit: 'GB-month', included: 10, step: 1, price: 0.015 },
  { id: 'r2ClassA', product: 'R2', name: 'Class A operations', unit: 'operations', included: 1e6, step: 1e6, price: 4.50 },
  { id: 'r2ClassB', product: 'R2', name: 'Class B operations', unit: 'operations', included: 10e6, step: 1e6, price: 0.36 },
  // HTTP requests, RPC sessions and alarms; duration is wall-clock time at 128 MB while an object is active.
  { id: 'objectRequests', product: 'Durable Objects', name: 'Requests', unit: 'requests', included: 1e6, step: 1e6, price: 0.15 },
  { id: 'objectDuration', product: 'Durable Objects', name: 'Duration', unit: 'GB-s', included: 400000, step: 1e6, price: 12.50 },
  { id: 'rowsRead', product: 'Durable Objects', name: 'SQLite rows read', unit: 'rows', included: 25e9, step: 1e6, price: 0.001 },
  { id: 'rowsWritten', product: 'Durable Objects', name: 'SQLite rows written', unit: 'rows', included: 50e6, step: 1e6, price: 1.00 },
];

/** R2's operation classes as its pricing page lists them (2026-10-30). Egress is free. */
const CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors',
  'PutBucketLifecycleConfiguration']);
const CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration']);
const FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
/**
 * The class an R2 action type is billed in. Types the list doesn't name (the analytics also show the dashboard's
 * GetBucketSippyConfiguration, GetBucketNotificationConfiguration, …) count as Class B when they only read, and
 * otherwise as Class A, the dearer guess; none counts as free.
 */
export function operationClass(action: string): 'A' | 'B' | 'free' {
  if (FREE.has(action)) return 'free';
  if (CLASS_A.has(action)) return 'A';
  return CLASS_B.has(action) || /^(?:Get|Head)[A-Z]/.test(action) ? 'B' : 'A';
}

const DAY_MS = 86400000;
/** Midnight UTC of `day` in a month (counted from 0, may run over the year), clamped to that month's last day. */
function anchor(year: number, month: number, day: number) {
  return Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
}
/**
 * The billing cycle `now` falls in: it starts at midnight UTC on `day` of a month (29 to 31 become the last day of a
 * shorter month) and ends where the next one starts. `end` is exclusive; `days` is its length (28 to 31).
 */
export function cycleOf(now: number, day: number) {
  const date = new Date(now);
  let start = anchor(date.getUTCFullYear(), date.getUTCMonth(), day);
  if (now < start) start = anchor(date.getUTCFullYear(), date.getUTCMonth() - 1, day);
  const first = new Date(start), end = anchor(first.getUTCFullYear(), first.getUTCMonth() + 1, day);
  return { start, end, days: Math.round((end - start) / DAY_MS) };
}
/** BILLING_CYCLE_DAY as a day of the month (1 to 31), or null. */
export function cycleDay(value: unknown) {
  const text = String(value ?? '').trim(), day = Number(text);
  return /^\d{1,2}$/.test(text) && day >= 1 && day <= 31 ? day : null;
}

/** Usage of the cycle so far, per meter, in the meter's unit. */
export type Usage = Record<MeterId, number>;
/**
 * Dollars to pay for `used` of a meter: nothing within the allowance, then whole steps rounded up. Kept in millionths
 * of a dollar, which every price is a whole number of, so the sums don't drift.
 */
export function micros(price: Price, used: number) {
  const over = Math.max(0, used - price.included), steps = over > 0 ? Math.ceil(over / price.step - 1e-9) : 0;
  return { steps, micros: steps * Math.round(price.price * 1e6) };
}

/**
 * The answer of GET /api/billing: the cycle (first and last day, UTC), each meter as used / included with what it
 * costs above the allowance, the base charge and the total so far. `elapsedDays` counts today as a day.
 */
export function estimate(usage: Usage, cycle: ReturnType<typeof cycleOf>, day: number, now: number) {
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
  const meters = PRICES.map(price => {
    const { steps, micros: cost } = micros(price, usage[price.id]);
    return { id: price.id, product: price.product, name: price.name, unit: price.unit, used: usage[price.id], included: price.included,
      step: price.step, price: price.price, billedSteps: steps, cost: cost / 1e6 };
  });
  const above = PRICES.reduce((sum, price) => sum + micros(price, usage[price.id]).micros, 0);
  const elapsedDays = Math.min(cycle.days, Math.floor((now - cycle.start) / DAY_MS) + 1);
  return {
    generatedAt: now, sample: false, pricesAsOf: PRICES_AS_OF, currency: 'USD',
    cycle: { day, start: iso(cycle.start), end: iso(cycle.end - DAY_MS), days: cycle.days, elapsedDays },
    base: BASE, aboveAllowance: above / 1e6, total: (BASE * 1e6 + above) / 1e6, pace: pace(usage, cycle.days, elapsedDays), meters,
  };
}

/**
 * A rough total for the whole cycle, as the hourly monitor prints it (pace() in scripts/monitor.py; keep both alike):
 * each meter's usage so far scaled by days / elapsed days (today counts as a whole day) and priced again against its
 * allowance, plus the base. Scaling only the dollars already above the allowances would miss a meter that crosses its
 * allowance later in the cycle.
 */
export function pace(usage: Usage, days: number, elapsedDays: number) {
  if (!(elapsedDays > 0)) return BASE;
  const above = PRICES.reduce((sum, price) => sum + micros(price, usage[price.id] * days / elapsedDays).micros, 0);
  return (BASE * 1e6 + above) / 1e6;
}

/**
 * One GraphQL request for the whole account and the cycle so far: Workers requests and CPU time, R2 Standard storage
 * (each bucket's peak per UTC day) and operations by action type, Durable Object requests (every type: RPC sessions,
 * fetches, alarms), duration (already GB-s at 128 MB) and SQLite rows. Each dataset keeps 90 days and answers at most
 * 32 days per query (checked 2026-10-31), so a cycle of up to 31 days fits. SQLite-backed objects report no stored
 * bytes there, so the estimate leaves that meter out (fyl's records are far below the 5 GB-month included).
 */
export const BILLING_QUERY = `query Billing($account: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $account}) {
  workers: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests cpuTimeUs } }
  storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_lt: $end, storageClass: "Standard"}) { max { payloadSize metadataSize } dimensions { date bucketName } }
  operations: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_lt: $end, storageClass: "Standard"}) { sum { requests } dimensions { actionType } }
  objects: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
  periodic: durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { duration rowsRead rowsWritten } }
} } }`;

/**
 * Besides the bill, a request of its own sent alongside it: fyl's own Worker's requests and errors of the last 24 hours
 * by outcome (the dataset `workers` reads, so the same Account Analytics Read; checked 2026-11-01 that it answers per
 * `status`). Never billed, so it is best effort: when it fails the estimate goes on without it, and the monitor's cost
 * alert never depends on it.
 */
export const ERRORS_QUERY = `query WorkerErrors($account: string!, $day: Time!, $end: Time!, $script: string!) { viewer { accounts(filter: {accountTag: $account}) {
  exceptions: workersInvocationsAdaptive(limit: 20, filter: {datetime_geq: $day, datetime_lt: $end, scriptName: $script}) { sum { requests errors } dimensions { status } }
} } }`;

/** The Worker whose errors the estimate reports (wrangler.jsonc `name`). */
export const SCRIPT = 'fyl-at';
const num = (value: unknown) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };
const rows = (value: unknown) => Array.isArray(value) ? value.filter(isObject) : null;
const field = (row: Record<string, unknown> | undefined, group: string, name: string) => num(isObject(row?.[group]) ? (row[group] as Record<string, unknown>)[name] : 0);

/** Each UTC day's R2 Standard peak in bytes (payload and metadata, the buckets' peaks summed), by date. */
function peaksOf(storage: Record<string, unknown>[]) {
  const peaks = new Map<string, number>();
  for (const row of storage) {
    const date = isObject(row.dimensions) && typeof row.dimensions.date === 'string' ? row.dimensions.date : '';
    peaks.set(date, (peaks.get(date) || 0) + field(row, 'max', 'payloadSize') + field(row, 'max', 'metadataSize'));
  }
  return peaks;
}
/** The daily R2 storage peaks of the cycle so far, oldest first, for the dashboard's small chart ([] without them). */
export function storageByDay(account: unknown) {
  const storage = isObject(account) ? rows(account.storage) : null;
  return storage ? [...peaksOf(storage)].filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort(([a], [b]) => a.localeCompare(b)).map(([date, bytes]) => ({ date, bytes })) : [];
}

/**
 * fyl's Worker over the last 24 hours: its requests, the ones that ended in an error (an exception, exceeded limits, an
 * internal error), and the requests by outcome other than `success` (`clientDisconnected` included, which is no error);
 * null when the answer has no such list, so the dashboard shows nothing rather than a guess.
 */
export function workerErrorsOf(account: unknown, since: number) {
  const list = isObject(account) ? rows(account.exceptions) : null;
  if (!list) return null;
  const statuses = new Map<string, number>();
  for (const row of list) {
    const status = isObject(row.dimensions) && typeof row.dimensions.status === 'string' ? row.dimensions.status.slice(0, 40) : 'unknown';
    if (status !== 'success') statuses.set(status, (statuses.get(status) || 0) + field(row, 'sum', 'requests'));
  }
  return { since: new Date(since).toISOString(), requests: list.reduce((total, row) => total + field(row, 'sum', 'requests'), 0),
    errors: list.reduce((total, row) => total + field(row, 'sum', 'errors'), 0),
    statuses: [...statuses].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })) };
}

/**
 * The cycle's usage from the GraphQL answer's account, or null when a dataset is missing. R2 storage is GB-month so
 * far: each UTC day's peak (payload and metadata, the buckets' peaks summed) in 10⁹ bytes, added up and divided by the
 * cycle's days, so on its last day it is the average daily peak R2 bills. Today counts with its peak so far.
 */
export function usageOf(account: unknown, days: number): Usage | null {
  if (!isObject(account)) return null;
  const workers = rows(account.workers), storage = rows(account.storage), operations = rows(account.operations);
  const objects = rows(account.objects), periodic = rows(account.periodic);
  if (!workers || !storage || !operations || !objects || !periodic) return null;
  const peaks = peaksOf(storage);
  const classes = { A: 0, B: 0, free: 0 };
  for (const row of operations) {
    const action = isObject(row.dimensions) && typeof row.dimensions.actionType === 'string' ? row.dimensions.actionType : '';
    classes[operationClass(action)] += field(row, 'sum', 'requests');
  }
  return {
    workerRequests: field(workers[0], 'sum', 'requests'), workerCpu: field(workers[0], 'sum', 'cpuTimeUs') / 1000,
    r2Storage: [...peaks.values()].reduce((sum, bytes) => sum + bytes, 0) / 1e9 / days, r2ClassA: classes.A, r2ClassB: classes.B,
    objectRequests: field(objects[0], 'sum', 'requests'), objectDuration: field(periodic[0], 'sum', 'duration'),
    rowsRead: field(periodic[0], 'sum', 'rowsRead'), rowsWritten: field(periodic[0], 'sum', 'rowsWritten'),
  };
}

/** Usage as a busy cycle might have it, made up from per-day rates: for local development (DEV_FAKE_STATS), marked `sample`. */
export function sampleUsage(elapsedDays: number, days: number): Usage {
  return {
    workerRequests: 61000 * elapsedDays, workerCpu: 260000 * elapsedDays, r2Storage: 380 * elapsedDays / days, r2ClassA: 14200 * elapsedDays,
    r2ClassB: 4100 * elapsedDays, objectRequests: 352000 * elapsedDays, objectDuration: 2900 * elapsedDays, rowsRead: 910000 * elapsedDays,
    rowsWritten: 118000 * elapsedDays,
  };
}

const CACHE_S = 900, GRAPHQL_TIMEOUT_MS = 10000;

/**
 * One GraphQL Analytics request with the read-only token: the first account of its answer, or null with the HTTP
 * status (null without an answer: a timeout, a broken connection) and GraphQL's first error code. GraphQL answers its
 * errors with 200 and an `errors` list (authz, quota, a query it rejects as a whole, …): any of them fails the request.
 */
async function graphql(token: string, query: string, variables: Record<string, string>) {
  let status: number | null = null, code: string | null = null, account: unknown = null;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
      body: JSON.stringify({ query, variables }),
    });
    status = response.status;
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    const errors = isObject(body) && Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
    if (errors.length) code = String(isObject(errors[0].extensions) && typeof errors[0].extensions.code === 'string' ? errors[0].extensions.code : 'error').slice(0, 40);
    else if (isObject(body) && isObject(body.data) && isObject(body.data.viewer) && Array.isArray(body.data.viewer.accounts)) account = body.data.viewer.accounts[0] ?? null;
  } catch { /* a timeout or a broken connection: the caller logs it without a status */ }
  return { status, code, account };
}

/** The location's cache key of a cycle's estimate (tests clear it). */
export const billingCacheKey = (origin: string, account: string, start: string) => new Request(new URL(`/__billing/${account}/${start}`, origin));

/**
 * GET /api/billing on the admin host: the estimate of the current billing cycle so far, kept CACHE_S seconds in this
 * location's cache (Cloudflare's analytics trail by minutes anyway, and the dashboard asks on every load). Without
 * CF_ANALYTICS_TOKEN, or with a BILLING_CYCLE_DAY that is no day of the month, 503 `billing_unconfigured`; when
 * Cloudflare refuses the token, 503 `billing_refused`; any other GraphQL failure 502 `billing_unavailable` (both logged
 * with the HTTP status and GraphQL's error code only, not cached). The Worker's errors (ERRORS_QUERY) are null when
 * their own request fails (logged as `worker_errors_failed`, the same way), never an error. The statistics never wait
 * for it, and it never fails them. The caller checks who may read it.
 */
export async function billing(request: Request, env: Env) {
  const day = cycleDay(env.BILLING_CYCLE_DAY), now = Date.now();
  if (day === null) throw new ApiError(503, 'Set BILLING_CYCLE_DAY to the day of the month the Cloudflare billing cycle starts (1 to 31).', 'billing_unconfigured');
  const cycle = cycleOf(now, day);
  if (fake(env)) {
    const elapsed = Math.floor((now - cycle.start) / DAY_MS) + 1;
    // 380 GB a day on average, growing through the cycle like the sample usage.
    const storage = Array.from({ length: elapsed }, (_, index) => ({ date: new Date(cycle.start + index * DAY_MS).toISOString().slice(0, 10),
      bytes: Math.round((300 + 160 * (index + 1) / elapsed + 25 * Math.sin(index)) * 1e9) }));
    const workerErrors = { since: new Date(now - DAY_MS).toISOString(), requests: 61000, errors: 0, statuses: [{ name: 'clientDisconnected', n: 37 }] };
    return json({ ...estimate(sampleUsage(elapsed, cycle.days), cycle, day, now), storageByDay: storage, workerErrors, sample: true });
  }
  const token = String(env.CF_ANALYTICS_TOKEN ?? '').trim(), account = String(env.ANALYTICS_ACCOUNT_ID ?? '').trim();
  if (!token || !/^[0-9a-f]{32}$/.test(account))
    throw new ApiError(503, 'The billing estimate needs the CF_ANALYTICS_TOKEN secret (a read-only API token with Account Analytics Read).', 'billing_unconfigured');
  const key = billingCacheKey(request.url, account, new Date(cycle.start).toISOString().slice(0, 10)), cache = caches.default;
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return json(await hit.json());
  // The Worker's errors are asked at the same time, apart: whatever happens to them, the estimate goes on without them.
  const [{ status, code, account: answered }, errors] = await Promise.all([graphql(token, BILLING_QUERY, { account, start: new Date(cycle.start).toISOString(),
    end: new Date(now).toISOString() }), graphql(token, ERRORS_QUERY, { account, day: new Date(now - DAY_MS).toISOString(), end: new Date(now).toISOString(), script: SCRIPT })]);
  const usage = usageOf(answered, cycle.days), storage = storageByDay(answered), workerErrors = workerErrorsOf(errors.account, now - DAY_MS);
  if (!workerErrors) console.error(JSON.stringify({ event: 'worker_errors_failed', status: errors.status, code: errors.code }));
  if (!usage) {
    console.error(JSON.stringify({ event: 'billing_failed', status, code }));
    // A refused token lasts until someone replaces it (expired, revoked, or without Account Analytics Read on this
    // account), unlike an outage, so it gets its own answer and the hourly monitor mails it instead of only warning.
    // As checked 2026-10-31: an unknown token is HTTP 401 (a malformed one 400, and the API answers other refusals 403),
    // a valid token without the permission 200 with the GraphQL error code `authz`.
    if (status === 400 || status === 401 || status === 403 || code === 'authz' || code === 'authn')
      throw new ApiError(503, 'Cloudflare refused the CF_ANALYTICS_TOKEN secret for the billing estimate: the token expired, was revoked or '
        + 'lacks Account Analytics Read for this account.', 'billing_refused');
    throw new ApiError(502, "Cloudflare's analytics did not answer the billing estimate. Try again in a few minutes.", 'billing_unavailable');
  }
  const body = { ...estimate(usage, cycle, day, now), storageByDay: storage, workerErrors };
  await cache.put(key, Response.json(body, { headers: { 'Cache-Control': `max-age=${CACHE_S}` } })).catch(() => undefined);
  return json(body);
}
