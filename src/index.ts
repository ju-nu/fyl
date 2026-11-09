import {
  ApiError, PART_BYTES, budget, digest, networkHash, sign, randomToken, validId, validKey, validExpiry, validPassword, passwordRecord,
  networkOf, secretMatches, linkOf, isObject, readBody, readJSON, json, unwrap, metric, type InitMetadata, type Lock, type PageView,
  secret, configured, closedOutcome, previewType, PREVIEW_BYTES, plaintextSize, fromBase64url, digestBytes, HEAD_BYTES, META_BYTES, kind,
} from './shared';
import { CATEGORIES, DECISIONS, reports, validCase } from './reports';
import { accessOf, adminHostOf, reportHostOf } from './access';
import { fake, pageView, stats, type PageKind, type Visitor } from './stats';
import { billing } from './billing';
import { LOCALES, OG_LOCALES, localeOf, messagesOf, negotiate } from './i18n';
export { Transfer } from './transfer';
export { Budget } from './budget';
export { Reports } from './reports';

function session(input: Record<string, unknown>) {
  if (!validId(input.uploadId) || !validKey(input.key)) throw new ApiError(400, 'Invalid upload session.');
  return { id: input.uploadId, key: input.key };
}

function ownerKey(request: Request) {
  const value = request.headers.get('Authorization');
  if (!value) return undefined;
  const match = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(value);
  if (!match) throw new ApiError(403, 'Invalid private key.', 'denied');
  return match[1];
}

/** Whether new end-to-end encrypted uploads are taken (docs/E2EE.md §17): only the E2EE_ENABLED var, an emergency switch. */
const e2eeEnabled = (env: Env) => String(env.E2EE_ENABLED ?? '') === 'true';

/** A Content-MD5 header (RFC 1864: canonical base64 of 16 bytes, with its padding) as 32 lowercase hex digits, or null. */
function contentMd5(value: string | null) {
  if (!value || !/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(value)) return null;
  return [...atob(value)].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** The first 168 bytes of every age file of the profile: one X25519 stanza, its body and the header MAC (docs/E2EE.md §4.2 step 4). */
const AGE_HEADER = /^age-encryption\.org\/v1\n-> X25519 [A-Za-z0-9+/]{43}\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n$/;
/** Byte ranges of an age file's ephemeral share, stanza body and payload nonce, which the metadata never shares with the content. */
const RANDOM_FIELDS = [[32, 75], [76, 119], [168, 184]];

/**
 * An encrypted upload's `head` and `meta` (b64url) as init takes them (docs/E2EE.md §12.1 steps 5 and 6): `head` the 184
 * bytes the stored file must start with, `meta` an age file of one of the metadata sizes, both shaped like an age header
 * of the profile, and the metadata's random values none of the content's. The server neither decrypts them nor checks
 * the base64 inside; the clients do.
 */
function sealedBlobs(value: unknown) {
  const invalid = () => new ApiError(400, 'Send e2ee.head and e2ee.meta of an encrypted file.');
  if (!isObject(value) || typeof value.head !== 'string' || typeof value.meta !== 'string') throw invalid();
  const head = fromBase64url(value.head), meta = fromBase64url(value.meta);
  const shaped = (bytes: Uint8Array) => AGE_HEADER.test(String.fromCharCode(...bytes.subarray(0, 168)));
  if (!head || head.length !== HEAD_BYTES || !meta || !META_BYTES.includes(meta.length) || !shaped(head) || !shaped(meta)) throw invalid();
  if (RANDOM_FIELDS.some(([start, end]) => head.subarray(start, end).every((byte, index) => byte === meta[start + index])))
    throw new ApiError(400, 'The metadata reuses the random values of the file. Encrypt it again.');
  return { head: value.head, meta: value.meta, bytes: { head, meta } };
}

/**
 * Text a person typed (report forms, operator notes): trimmed, at most `max` code points, no controls (but line
 * breaks and tabs where `lines`; a pasted CRLF counts as one) or lone surrogates; null otherwise.
 */
function typed(value: unknown, max: number, lines = false) {
  if (typeof value !== 'string') return null;
  const text = (lines ? value.replaceAll('\r\n', '\n') : value).trim();
  return [...text].length <= max && !(lines ? /[^\P{Cc}\n\t]|\p{Cs}/u : /[\p{Cc}\p{Cs}]/u).test(text) ? text : null;
}

function noteOf(value: unknown) {
  const note = value == null ? '' : typed(value, 1000, true);
  if (note === null) throw new ApiError(400, 'A note is text of up to 1000 characters.');
  return note;
}

/** The reason an operator gives for a quarantine, restore, removal or rejection: every such decision records why. */
function reasonOf(value: unknown) {
  const note = noteOf(value);
  if ([...note].length < 3) throw new ApiError(400, 'Give the reason for this decision in a note of at least 3 characters.', 'note_required');
  return note;
}

/**
 * The operator's view of a transfer with its open reports: their number and the first case ids in the queue's order
 * (priority, then oldest). Those of a transfer that is gone are closed first, but a case filed once the file was gone
 * already (`fileAvailable` false) stays open for the operator unless the file was taken down (see Reports). Without an
 * answer from Reports both are null: the view, and the takedown that reads it first, must not depend on the reports.
 */
async function inspect(env: Env, id: string) {
  const view = unwrap(await env.TRANSFERS.getByName(id).operatorView(id));
  const open = await reports(env).forTransfer(id, closedOutcome(view)).then(result => unwrap(result)).catch(() => { metric(env, 'fallback', 'reports_view'); return null; });
  return { ...view, openReports: open?.count ?? null, openCases: open?.cases ?? null };
}

/** When GRANT_SIGNING_KEY_PREVIOUS stopped being the current key (GRANT_SIGNING_KEY_ROTATED_AT, ms or an ISO date), or null. */
function rotatedAt(env: Env) {
  const value = env.GRANT_SIGNING_KEY_ROTATED_AT?.trim() || '', time = /^\d{1,16}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Readiness for the operator and the hourly monitor: the secrets are set (each at least 32 characters), no previous
 * grant key outlived its rotation, R2, the Budget and the Reports objects answer (a missing health/ready object is
 * fine, an exception is not). `ready` is about health only: 200 when every check passes, 503 otherwise. `attention`
 * says something waits for the operator, `reasons` what: `open_reports`, `overdue_cleanups`, `storage_60` (the stored
 * bytes MAX_STORED_BYTES checks reached 60 % of it) and `daily_60` (today's payload and reserved bytes reached 60 % of
 * MAX_DAILY_UPLOAD_BYTES), with both fill levels in whole percent, the stored bytes and their limit (the dashboard's
 * "Storage in use", so it needs no other call to the Budget), the age in seconds of the oldest open report and the
 * most urgent priority among them (see PRIORITY). `turnstile` says whether the report form checks Turnstile: `on`,
 * `off`, or `incomplete` (only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET set, so it doesn't). `e2ee` says whether
 * new encrypted uploads are taken (`on`, or `off` while the E2EE_ENABLED switch is off), `paused` whether the operator
 * paused uploads (`null` when the Budget didn't answer); none of the three is a health check. `version` is the live
 * deploy's tag (`v2.4.0`, as `npm run deploy` names it) and when it was uploaded, from the version metadata binding
 * (null without it).
 * Counts and percentages only, never ids, names or keys. With `sample` (the owner's read on the local dashboard, see
 * admin()) the stored bytes are made up and marked `capacity.sample`, so "Storage in use" shows filled like the sample
 * statistics beside it; the checks and reasons still come from the real Budget.
 */
async function readiness(env: Env, sample = false) {
  const secrets = Object.fromEntries((['NETWORK_HASH_KEY', 'GRANT_SIGNING_KEY', 'ADMIN_TOKEN'] as const).map(name => [name, configured(env, name) !== null]));
  // A previous grant key passes nothing after its hour (see granted()), but left in place it is one secret too many.
  const rotated = rotatedAt(env), rotation = configured(env, 'GRANT_SIGNING_KEY_PREVIOUS') === null || (rotated !== null && Date.now() <= rotated + GRANT_MS + 60000);
  const [r2, status, open] = await Promise.all([
    env.FILES.head('health/ready').then(() => true, () => false),
    budget(env).status().then((value): object => value, () => null),
    reports(env).summary().then(result => unwrap(result)).catch(() => null),
  ]);
  // The Budget counts uploads still holding storage after they must have closed (the upload window plus the longest lifetime).
  const overdueCleanups = status && 'overdueCleanups' in status && typeof status.overdueCleanups === 'number' ? status.overdueCleanups : null;
  const checks = { secrets, rotation, r2, budget: status !== null, reports: open !== null };
  const ready = Object.values(secrets).every(Boolean) && rotation && r2 && checks.budget && checks.reports;
  // A budget's bytes and limit, its fill level in whole percent, and whether it reached 60 % (compared exactly, not on
  // the rounded percent).
  const fill = (name: 'stored' | 'today') => {
    const part = status ? (status as Record<string, unknown>)[name] : null;
    if (!isObject(part) || typeof part.bytes !== 'number' || typeof part.maxBytes !== 'number' || !(part.maxBytes > 0)) return null;
    return { bytes: part.bytes, maxBytes: part.maxBytes, percent: Math.floor(part.bytes * 100 / part.maxBytes), high: part.bytes * 100 >= part.maxBytes * 60 };
  };
  const stored = fill('stored'), today = fill('today');
  const reasons = ([['open_reports', Boolean(open?.open)], ['overdue_cleanups', Boolean(overdueCleanups)], ['storage_60', Boolean(stored?.high)],
    ['daily_60', Boolean(today?.high)]] as const).filter(([, present]) => present).map(([reason]) => reason);
  const oldestOpenReportAge = open?.oldest ? Math.max(0, Math.floor((Date.now() - open.oldest) / 1000)) : null;
  const capacity = { storedPercent: stored?.percent ?? null, dailyPercent: today?.percent ?? null, storedBytes: stored?.bytes ?? null, maxStoredBytes: stored?.maxBytes ?? null };
  if (sample && stored) {
    // 412 GB of the real limit (8 % of 5 TB; a tenth of a limit under 4 TB), so the tile, its "n %" and the info button
    // can be checked without uploading anything first.
    const bytes = Math.min(412 * 1024 ** 3, Math.floor(stored.maxBytes / 10));
    Object.assign(capacity, { storedBytes: bytes, storedPercent: Math.floor(bytes * 100 / stored.maxBytes), sample: true });
  }
  // Whether the operator's kill switch holds new uploads (null when the Budget didn't answer); not a health check.
  const paused = status && 'paused' in status && typeof status.paused === 'boolean' ? status.paused : null;
  return json({ ready, attention: reasons.length > 0, reasons, checks, turnstile: turnstile(env).state, e2ee: e2eeEnabled(env) ? 'on' : 'off', paused, backlog: { overdueCleanups },
    capacity, openReports: open?.open ?? null, oldestOpenReportAge, highestOpenPriority: open?.priority ?? null, version: versionOf(env) }, ready ? 200 : 503);
}

/** The live version's tag and upload time (CF_VERSION_METADATA), each null where the binding doesn't say. */
function versionOf(env: Env) {
  const meta = (env as Partial<Env>).CF_VERSION_METADATA;
  if (!isObject(meta)) return null;
  const tag = typeof meta.tag === 'string' && /^[\w.+-]{1,40}$/.test(meta.tag) ? meta.tag : null;
  const deployedAt = typeof meta.timestamp === 'string' && Number.isFinite(Date.parse(meta.timestamp)) ? new Date(meta.timestamp).toISOString() : null;
  return { tag, deployedAt };
}

/** Whether the request's bearer token is one of `values` (compared as hashes in constant time). */
async function bearer(request: Request, values: (string | null)[]) {
  const token = await digest(/^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '');
  let accepted = false;
  for (const value of values) if (value && secretMatches(token, await digest(value))) accepted = true;
  return accepted;
}

/** The operator views an owner's Access identity reads on the admin host without ADMIN_TOKEN (GET only, see admin()). */
const OWNER_READS = new Set(['/api/admin/ready', '/api/admin/uploads', '/api/admin/reports']);
/** A case as the owner's dashboard lists it: no details, contact, network hash or transfer id (those need ADMIN_TOKEN). */
const queued = ({ case: id, createdAt, category, priority, status, outcome, fileAvailable }: Record<string, unknown>) =>
  ({ case: id, createdAt, category, priority, status, outcome, fileAvailable });

/**
 * Operator API, enabled by the ADMIN_TOKEN secret: pause or resume uploads, take a file down at once, quarantine
 * and restore it while a report is reviewed, decide reports, reconcile the budgets, and check readiness. Without the
 * secret the routes do not exist, and a secret shorter than 32 characters counts as missing, so a weak token can never
 * enable them. Of these routes the MONITOR_TOKEN secret opens readiness and nothing else (on the admin host it also
 * reads the billing estimate, see adminSite()): the monitor holding it sees counts and dollars only.
 * On the admin host an `owner` (Cloudflare Access identity on ADMIN_EMAILS) also reads OWNER_READS without a token,
 * the report queue without the reporters' details; every change still needs ADMIN_TOKEN.
 */
async function admin(request: Request, env: Env, path: string, owner = false) {
  const expected = configured(env, 'ADMIN_TOKEN'), monitor = path === '/api/admin/ready' ? configured(env, 'MONITOR_TOKEN') : null;
  if (!expected && !monitor) throw new ApiError(404, 'API endpoint not found.', 'not_found');
  const accepted = await bearer(request, [expected, monitor]);
  const reading = !accepted && owner && request.method === 'GET' && OWNER_READS.has(path);
  if (!accepted && !reading) throw new ApiError(401, 'Operator token required.', 'denied');
  const admission = budget(env), cases = reports(env), keyed = { networkHashKeyed: configured(env, 'NETWORK_HASH_KEY') !== null };
  const only = (method: string) => { if (request.method !== method) throw new ApiError(405, `Use ${method}.`); };
  // Reports failing must not take the upload switch down with them.
  const openReports = () => cases.openCount().then(unwrap).catch(() => { metric(env, 'fallback', 'reports_view'); return null; });
  // The local dashboard's own read (fake(): a *.localhost admin host with DEV_FAKE_STATS) gets a sample "Storage in use";
  // the operator token and MONITOR_TOKEN always get the Budget's real bytes.
  if (path === '/api/admin/ready') { only('GET'); return await readiness(env, reading && fake(env)); }
  if (path === '/api/admin/reconcile') {
    // What the Budget's daily alarm does, now (e.g. after a rollback): ends expired leases, fixes the aggregates from the
    // rows and reconciles overdue cleanups.
    only('POST');
    return json(unwrap(await admission.reconcileNow()));
  }
  if (path === '/api/admin/uploads') {
    if (request.method === 'GET') return json({ ...await admission.status(), ...keyed, openReports: await openReports() });
    if (request.method !== 'POST') throw new ApiError(405, 'Use GET or POST.');
    const data = await readJSON(request, 256);
    if (typeof data.paused !== 'boolean') throw new ApiError(400, 'Send {"paused": true} or {"paused": false}.');
    const status = unwrap(await admission.setPaused(data.paused));
    metric(env, 'pause', '', data.paused ? 1 : 0);
    return json({ ...status, ...keyed, openReports: await openReports() });
  }
  if (path === '/api/admin/takedown') {
    only('POST');
    const data = await readJSON(request, 8192), note = reasonOf(data.note);
    if (!validId(data.id)) throw new ApiError(400, 'Send the transfer id from the download link.');
    // An id with no transfer (never, or no longer) is blocked as well: `existed` tells the operator which.
    const existed = unwrap(await env.TRANSFERS.getByName(data.id).takedown(data.id));
    metric(env, 'takedown');
    // Final already: a Reports failure only leaves the open cases without the reason, which the answer says.
    const annotated = await cases.annotate(data.id, 'remove', note).then(unwrap).then(() => true, () => false);
    if (!annotated) console.error(JSON.stringify({ event: 'reports_unavailable', action: 'remove' }));
    return json({ removed: true, existed, ...annotated ? {} : { reportsUpdated: false } });
  }
  if (path === '/api/admin/quarantine' || path === '/api/admin/restore') {
    only('POST');
    const data = await readJSON(request, 8192), note = reasonOf(data.note), action = path.endsWith('/quarantine') ? 'quarantine' : 'restore';
    if (!validId(data.id)) throw new ApiError(400, 'Send the transfer id from the download link.');
    const stub = env.TRANSFERS.getByName(data.id);
    unwrap(await (action === 'quarantine' ? stub.quarantine(note) : stub.restore()));
    metric(env, action);
    // It took effect: a Reports failure only leaves the open cases without this event, which the answer says.
    const annotated = await cases.annotate(data.id, action, note).then(unwrap).then(() => true, () => false);
    if (!annotated) console.error(JSON.stringify({ event: 'reports_unavailable', action }));
    return json({ ...await inspect(env, data.id), ...annotated ? {} : { reportsUpdated: false } });
  }
  const transfer = /^\/api\/admin\/transfers\/([a-zA-Z0-9_-]{43,64})$/.exec(path);
  if (transfer) { only('GET'); return json(await inspect(env, transfer[1])); }
  if (path === '/api/admin/reports') {
    only('GET');
    const query = new URL(request.url).searchParams, status = query.get('status') || 'open', limit = Number(query.get('limit') || 50);
    if ((status !== 'open' && status !== 'closed' && status !== 'all') || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new ApiError(400, 'Use status=open, closed or all and a limit from 1 to 200.');
    // Pages: `next` is the `after` of the following one (the last case of this page). `transfer` lists one transfer's cases.
    const after = query.get('after') ?? undefined, transfer = query.get('transfer') ?? undefined;
    if ((after !== undefined && !validCase(after)) || (transfer !== undefined && !validId(transfer)))
      throw new ApiError(400, 'Use after=<case> from `next` and transfer=<transfer id>.');
    const list = unwrap(await cases.list(status, limit, { after, transfer }));
    return json({ reports: reading ? list.map(queued) : list, next: list.length === limit ? list[list.length - 1].case : null });
  }
  const report = /^\/api\/admin\/reports\/([^/]+)$/.exec(path)?.[1];
  if (report) {
    if (!validCase(report)) throw new ApiError(404, 'Report not found.', 'not_found');
    if (request.method === 'GET') return json(unwrap(await cases.get(report)));
    only('POST');
    const data = await readJSON(request, 8192);
    if (typeof data.action !== 'string' || !DECISIONS.includes(data.action))
      throw new ApiError(400, 'Send an action: quarantine, restore, remove, reject or note.');
    return json(unwrap(await cases.decide(report, data.action, data.action === 'note' ? noteOf(data.note) : reasonOf(data.note))));
  }
  throw new ApiError(404, 'API endpoint not found.', 'not_found');
}

/**
 * The transfer a download link opens, as a browser resolves it, or undefined. Links that a browser would resolve to
 * another path (dot segments, backslashes) are refused rather than read one way here and another way there.
 */
function linkedTransfer(link: string, base: string) {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  const path = link.split(/[?#]/)[0];
  if (/[\p{Cc}\\]/u.test(link) || path.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) return undefined;
  if (url.origin !== new URL(base).origin || url.username || url.password || url.hash || !/^(?:|\?dl=1|\?grant=\d{1,16}\.[a-zA-Z0-9_-]{43})$/.test(url.search)) return undefined;
  return /^\/d\/([a-zA-Z0-9_-]{43,64})(?:\/[^/]*)?$/.exec(url.pathname)?.[1];
}

/**
 * Key material of an encrypted link (docs/E2EE.md §15.4): 43 key characters after `#` (or `%23`), as in a fyl link with
 * its key, or an age identity string. Reports refuse it in every field they take, the link, details, name and email:
 * 2.4.0 has no channel for keys.
 */
const KEY_MATERIAL = /(?:#|%23)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|AGE-SECRET-KEY-1/i;
const keyMaterial = () => new ApiError(400, "Don't paste the key here.", 'key_material');

/**
 * A report as POST /api/reports takes it (see Reports). The link only names the transfer: it is never fetched, and
 * never stored (a grant in it is a credential). Contact details may be left out only for CSAM (DSA Art. 16(2)(c)),
 * and the reporter confirms good faith (Art. 16(2)(d)).
 */
function reportOf(data: Record<string, unknown>, base: string) {
  const link = typeof data.link === 'string' ? data.link.trim() : '';
  if (KEY_MATERIAL.test(link)) throw keyMaterial();
  const transferId = validId(link) ? link : linkedTransfer(link, base);
  if (!transferId) throw new ApiError(400, `Enter the download link (${base}/d/…) or its ID.`, 'invalid_link');
  const category = data.category;
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) throw new ApiError(400, 'Choose what the report is about.', 'invalid_category');
  const details = typed(data.details, 4000, true);
  if (details !== null && KEY_MATERIAL.test(details)) throw keyMaterial();
  if (details === null || [...details].length < 20) throw new ApiError(400, 'Describe the problem in 20 to 4000 characters.', 'invalid_details');
  // The contact fields are free text too, kept in the case as long as the details: a key pasted there is refused the same way.
  if ([data.name, data.email].some(value => typeof value === 'string' && KEY_MATERIAL.test(value))) throw keyMaterial();
  const optional = category === 'csam', name = data.name == null ? '' : typed(data.name, 200), email = data.email == null ? '' : typed(data.email, 254);
  if (name === null || (!name && !optional)) throw new ApiError(400, 'Enter your name (up to 200 characters).', 'invalid_name');
  if (email === null || (email ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) : !optional)) throw new ApiError(400, 'Enter a valid email address.', 'invalid_email');
  if (data.goodFaith !== true) throw new ApiError(400, 'Confirm that the report is accurate and made in good faith.', 'good_faith_required');
  return { transferId, category, details, name: name || null, email: email || null };
}

/**
 * Cloudflare Turnstile guards the report form, and nothing else (uploads, downloads, the CLI and every other route
 * never ask for it). It is on once the TURNSTILE_SITE_KEY var (public: /config.js hands it to the report page) and
 * the TURNSTILE_SECRET secret are both set; with either missing the form works without it, as before.
 */
function turnstile(env: Env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY ?? '').trim(), secret = String(env.TURNSTILE_SECRET ?? '').trim();
  return { siteKey, secret, on: Boolean(siteKey && secret), state: siteKey && secret ? 'on' : siteKey || secret ? 'incomplete' : 'off' };
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Turnstile tokens live 5 minutes; siteverify refuses older ones itself, this checks the challenge time it answers too. */
const TURNSTILE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Checks a report's Turnstile token with siteverify (the secret, the token and the client's address): it must pass,
 * have been solved on the form's host (REPORT_HOST, else PUBLIC_BASE_URL's host) for the action `report`, and be at
 * most 5 minutes old. Any other answer is 403 `turnstile_failed`; no readable answer is 503, so the form fails closed
 * and the reporter can retry. A token is good for one check, so the page gets a new one after every answer.
 * Cloudflare's test secret keys (metadata.result_with_testing_key) answer for example.com without an action: they pass
 * or fail every token whatever it is, so for them only `success` counts. Tokens are never logged or stored; the metric
 * counts the reason only.
 */
async function human(env: Env, secret: string, token: unknown, address: string, base: string) {
  const refused = (reason: string) => {
    metric(env, 'turnstile_failed', reason);
    return new ApiError(403, 'Please confirm you are human and send again.', 'turnstile_failed');
  };
  const unavailable = () => {
    metric(env, 'turnstile_failed', 'unavailable');
    return new ApiError(503, 'Temporarily unavailable. Please retry.', 'temporarily_unavailable');
  };
  if (typeof token !== 'string' || !token || token.length > 2048) throw refused('missing');
  const form = new URLSearchParams({ secret, response: token });
  if (address !== 'local') form.set('remoteip', address);
  let answer: unknown;
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
    answer = response.ok ? await response.json() : null;
  } catch { answer = null; }
  if (!isObject(answer)) throw unavailable();
  const codes = Array.isArray(answer['error-codes']) ? answer['error-codes'] : [];
  if (codes.includes('internal-error')) throw unavailable();
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    console.error(JSON.stringify({ event: 'misconfigured', missing: 'TURNSTILE_SECRET' }));
    throw new ApiError(503, 'This service is not configured completely. Please try again later.', 'misconfigured');
  }
  if (answer.success !== true) throw refused(codes.includes('timeout-or-duplicate') ? 'expired' : 'invalid');
  if (!(isObject(answer.metadata) && answer.metadata.result_with_testing_key === true)) {
    // The form lives on the report host when there is one (report.fyl.at), else on the public host.
    if (answer.hostname !== (reportHostOf(env) || new URL(base).hostname)) throw refused('hostname');
    if (answer.action !== 'report') throw refused('action');
  }
  const solved = typeof answer.challenge_ts === 'string' ? Date.parse(answer.challenge_ts) : Number.NaN;
  if (Number.isFinite(solved) && Date.now() - solved > TURNSTILE_MAX_AGE_MS) throw refused('expired');
}

function originCheck(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new ApiError(403, 'Cross-origin upload and management requests are not accepted.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new ApiError(403, 'Cross-site upload and management requests are not accepted.');
}

/**
 * The download page's unlock form. The site sends Referrer-Policy: no-referrer, and with it browsers send
 * `Origin: null` on form posts; the page itself switches to same-origin, but a null Origin is also accepted when
 * the browser vouches for the request with Sec-Fetch-Site: same-origin. Anything cross-site is refused.
 */
function formCheck(request: Request) {
  const origin = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') throw new ApiError(403, 'Cross-site requests are not accepted.');
  if (origin === 'null' ? site !== 'same-origin' : origin && origin !== new URL(request.url).origin)
    throw new ApiError(403, 'Cross-origin requests are not accepted.');
}

type Limit = 'INIT_RATE' | 'PART_RATE' | 'DOWNLOAD_RATE' | 'ADMIN_RATE' | 'STATUS_RATE' | 'REPORT_RATE';
/** Refuses a request over its rate limit, counted by limit (`part`, `download`, …), never by network. */
async function rate(env: Env, limit: Limit, key: string) {
  if ((await env[limit].limit({ key })).success) return;
  metric(env, 'rate_limited', limit.replace('_RATE', '').toLowerCase());
  throw new ApiError(429, 'Too many requests. Please try again shortly.', 'rate_limited');
}

/**
 * fyl's own tools (the smoke test, the monitor, the operator scripts) and the operator's ad-hoc checks, which add
 * `fyl-ops` to their User-Agent (curl -A fyl-ops, a Playwright context's userAgent + ' fyl-ops'); the smoke test's
 * CLI adds `fyl-smoke` (FYL_UA_SUFFIX). For statistics only, never for access: their
 * page views are not counted, their uploads and downloads count as `own`.
 */
const OWN_TOOLS = /^fyl-(?:monitor|admin)\b|\bfyl-(?:smoke|ops)\b/i;
/** The kind of client an upload comes from or a download goes to, for statistics only (the User-Agent itself is never kept): it can be anything. */
function clientOf(request: Request) {
  const agent = request.headers.get('User-Agent') || '';
  return OWN_TOOLS.test(agent) ? 'own' : /^fyl-cli\//i.test(agent) ? 'cli' : /^curl\//i.test(agent) ? 'curl' : /^wget\//i.test(agent) ? 'wget' : /^Mozilla\//.test(agent) ? 'browser' : 'other';
}

/**
 * The kind of client a page view counts (statistics only, like clientOf()): link-preview bots (PREVIEW_BOTS, never a
 * browser navigation) and crawlers are `bot`. "Cubot" is a phone brand, not a bot. A browser's User-Agent without
 * an Accept-Language is a `script`: every major browser sends one with a navigation, a script borrowing the name
 * usually doesn't.
 */
const CRAWLERS = /(?<!cu)bot(?:\b|[-_])|crawl|spider|slurp|archiver|headless|lighthouse|scrapy|feedfetcher|mediapartners|inspectiontool|googleother|bingpreview/i;
function visitorOf(request: Request): Visitor {
  const agent = request.headers.get('User-Agent') || '';
  if (OWN_TOOLS.test(agent)) return 'own';
  if (CRAWLERS.test(agent) || (request.headers.get('Sec-Fetch-Mode') !== 'navigate' && PREVIEW_BOTS.test(agent))) return 'bot';
  const client = clientOf(request);
  return client === 'browser' && !(request.headers.get('Accept-Language') || '').trim() ? 'script' : client;
}

/**
 * File responses: a download, never a page. A browser that renders one anyway (a sniffed type, a PDF viewer) runs
 * nothing of it, and no other site can embed one or read it with a no-cors fetch (Cross-Origin-Resource-Policy; see hotlinked()).
 */
function downloadHeaders(name: string, size: number) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 160) || 'download';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return new Headers({
    'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}

/**
 * Hotlink protection for /d/. Another site's page (Sec-Fetch-Site cross-site, or same-site from a sibling domain) may
 * navigate to a link (Sec-Fetch-Dest document), and then gets the download page even for the file's own address (see
 * download()), but may never load one as a resource: an image, video, audio, track, frame, embed, object, script,
 * style, font or fetch (`empty`). Only browsers send these headers: curl, wget and the CLI send none and are not
 * affected, nor are a typed address or bookmark (`none`) and fyl.at's own pages (`same-origin`).
 */
const foreign = (request: Request) => ['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site') || '');
const hotlinked = (request: Request) => foreign(request) && request.headers.get('Sec-Fetch-Dest') !== 'document';

const GRANT_MS = 60 * 60 * 1000;
/**
 * A download grant for a protected file whose password the page took: `<expiry ms>.<signature>`, valid for GRANT_MS
 * and signed with GRANT_SIGNING_KEY. To rotate the key, move the old one to GRANT_SIGNING_KEY_PREVIOUS and set
 * GRANT_SIGNING_KEY_ROTATED_AT to the time: the previous key then passes only grants that expire within GRANT_MS of
 * it (the ones it signed before), so even a leaked previous key mints nothing usable an hour later; readiness fails
 * until it is removed. Without the time the previous key passes nothing. Without GRANT_SIGNING_KEY no grant is issued or passes.
 */
async function grant(env: Env, id: string) {
  const expiry = String(Date.now() + GRANT_MS);
  return `${expiry}.${await sign(secret(env, 'GRANT_SIGNING_KEY'), `fyl-grant:${id}:${expiry}`)}`;
}
async function granted(env: Env, id: string, value: string | null) {
  const match = /^(\d{1,16})\.([a-zA-Z0-9_-]{43})$/.exec(value || ''), expiry = Number(match?.[1]), current = configured(env, 'GRANT_SIGNING_KEY');
  // A minute of leeway: another machine than the one that issued the grant may check it.
  if (!match || !current || expiry <= Date.now() || expiry > Date.now() + GRANT_MS + 60000) return false;
  const rotated = rotatedAt(env), previous = rotated !== null && expiry <= rotated + GRANT_MS + 60000 ? configured(env, 'GRANT_SIGNING_KEY_PREVIOUS') : null;
  for (const key of [current, previous])
    if (key && secretMatches(match[2], await sign(key, `fyl-grant:${id}:${match[1]}`))) return true;
  return false;
}

/** The password of HTTP Basic credentials (the user name is ignored), or null without readable ones. */
function basicPassword(request: Request) {
  const match = /^Basic ([a-zA-Z0-9+/]+={0,2})$/i.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  try {
    const credentials = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)));
    return credentials.includes(':') ? credentials.slice(credentials.indexOf(':') + 1) : null;
  } catch { return null; }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const secondsUntil = (time: number | null) => Math.max(1, Math.ceil(((time || 0) - Date.now()) / 1000));

/** A wrong or paused password on the info route (docs/E2EE.md §12.2): JSON with the tries left or the pause's end, never a Basic challenge. */
function passwordRefusal(lock: Lock) {
  if (lock.error !== 'paused') return json({ error: `Wrong password. ${plural(lock.triesLeft, 'try', 'tries')} left.`, code: 'password_wrong', triesLeft: lock.triesLeft }, 401);
  const seconds = secondsUntil(lock.pausedUntil);
  const response = json({ error: `Too many wrong tries. Try again in ${plural(Math.ceil(seconds / 60), 'minute', 'minutes')}.`, code: 'password_paused', pausedUntil: lock.pausedUntil }, 429);
  response.headers.set('Retry-After', String(seconds));
  return response;
}

const textHeaders = () => new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });

/**
 * A protected file asked for without a grant or the right password (`lock` null: none given): a Basic Auth
 * challenge, so curl -u and wget ask for it, or 429 while the link pauses after too many wrong tries. An encrypted
 * file's hint names `fyl download`, which asks for the password and the key (docs/E2EE.md §12.2).
 */
function locked(head: boolean, lock: Lock | null, link: string, mode: string) {
  const headers = textHeaders();
  let status = 401, text: string;
  if (lock?.error === 'paused') {
    const seconds = secondsUntil(lock.pausedUntil);
    status = 429; headers.set('Retry-After', String(seconds));
    text = `Too many wrong tries. Try again in ${plural(Math.ceil(seconds / 60), 'minute', 'minutes')}.`;
  } else {
    headers.set('WWW-Authenticate', 'Basic realm="fyl.at", charset="UTF-8"');
    text = lock ? `Wrong password. ${plural(lock.triesLeft, 'try', 'tries')} left.`
      : mode === 'e2ee' ? `This file is encrypted and needs a password. Run: fyl download '${link}'` : `This file needs a password. Run: curl -fOJ -u fyl '${link}'`;
  }
  return new Response(head ? null : text + '\n', { status, headers });
}

/**
 * An encrypted file asked for without ?dl=1, a grant or Basic (docs/E2EE.md §12.2): 409 `encrypted` with a plain-text
 * hint for the fyl tool, which decrypts it. Nothing is counted or opened, so a link unfurler or a plain curl uses up nothing.
 */
const encrypted = (head: boolean, link: string) =>
  new Response(head ? null : `This file is end-to-end encrypted. Run: fyl download '${link}'\n`, { status: 409, headers: textHeaders() });

/**
 * The transfer ID of a /d/ path: the segment after /d/, up to a `%23` (any case), so a link whose `#` became `%23`
 * (docs/E2EE.md §2.4) still opens its transfer. What follows is never read, as for a raw link's name.
 */
const linkId = (path: string) => (path.split('/')[2] || '').split(/%23/i)[0];

async function download(request: Request, env: Env, ctx: ExecutionContext, id: string, ip: string, subscriber: string, base: string) {
  // Every /d/ request counts, malformed ids too: a browser gets the download page for their 404.
  await rate(env, 'DOWNLOAD_RATE', ip);
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new ApiError(405, 'Use GET, HEAD or POST.');
  // Before anything is counted or a one-time session opens.
  if (hotlinked(request)) throw new ApiError(403, "fyl.at files can't be embedded on other sites. Open the link instead.", 'hotlink');
  if (request.method === 'POST') formCheck(request);
  if (!validId(id)) throw new ApiError(404, 'File not found.', 'not_found');
  const query = new URL(request.url).searchParams;
  // A browser that opens a preview address (some chat apps link the picture) gets the page like any link.
  if (query.has('preview') && !(navigation(request) && !previewBot(request))) return await preview(request, env, id);
  // A one-time session belongs to the network (/64); password tries count per subscriber (/56), so the /64s of one
  // line can't pause the whole transfer for everyone else.
  const stub = env.TRANSFERS.getByName(id), network = await networkHash(env.NETWORK_HASH_KEY, ip + ':' + id);
  const guesser = subscriber === ip ? network : await networkHash(env.NETWORK_HASH_KEY, subscriber + ':' + id);
  if (request.method === 'POST') {
    // Unlocking issues a grant: without its key, refuse before a try is counted.
    secret(env, 'GRANT_SIGNING_KEY');
    // The page's password form. 1 KiB would not do: URL-encoded, 200 characters of 4 UTF-8 bytes take 2.4 KiB.
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(request, 'application/x-www-form-urlencoded', 4096)));
    return await shownPage(request, env, unwrap(await stub.unlock(form.get('password') || '', network, guesser)), id, base);
  }
  if (pageRequest(request)) return await shownPage(request, env, unwrap(await stub.page(network, guesser)), id, base);
  const head = request.method === 'HEAD';
  // Another site's link straight to the file (?dl=1, a grant) opens the page, which then downloads from fyl.at: a file
  // address posted elsewhere can't skip it. HEAD gets the page's headers.
  if (foreign(request) && (query.has('dl') || query.has('grant'))) {
    const page = await shownPage(request, env, unwrap(await stub.page(network, guesser)), id, base);
    return head ? new Response(null, { status: page.status, headers: page.headers }) : page;
  }
  const rangeHeader = head ? null : request.headers.get('Range');
  const password = basicPassword(request), allowed = await granted(env, id, query.get('grant'));
  // An encrypted file (docs/E2EE.md §12.2): a browser opening any of its addresses gets the page, which decrypts; any
  // other client gets the file only when it asks for it with ?dl=1, a grant or Basic.
  const ask = { navigate: browsing(request), explicit: query.has('dl') || allowed || password !== null };
  // The Durable Object checks the range against the file before it counts a download or opens a session.
  const info = unwrap(await stub.claim(head, network, rangeHeader, password, allowed, guesser, ask));
  if (info.kind === 'encrypted') return encrypted(head, linkOf(base, id, null));
  // A browser navigating to ?dl=1 or an expired grant gets the page instead of a 503 or a Basic Auth challenge:
  // WWW-Authenticate would open the browser's own password dialog.
  if (info.kind === 'page' || (info.kind !== 'file' && navigation(request))) return await shownPage(request, env, unwrap(await stub.page(network, guesser)), id, base);
  if (info.kind === 'waiting') {
    // Still uploading: curl --retry waits and tries again (and so do most download tools).
    metric(env, 'early_wait');
    const percent = Math.floor(info.received / info.size * 100);
    const response = json({ error: `Still uploading, ${percent} % done. curl --retry waits until it’s ready.`, code: 'uploading', received: info.received, size: info.size }, 503);
    response.headers.set('Retry-After', '10');
    return response;
  }
  if (info.kind === 'locked') return locked(head, info.lock, linkOf(base, id, null), info.mode);
  const headers = downloadHeaders(info.name, info.size), { range } = info;
  const gone = () => new ApiError(410, 'This file is no longer available.', 'unavailable');
  if (head) {
    const object = await env.FILES.head(info.objectKey);
    if (!object) throw gone();
    headers.set('ETag', object.httpEtag);
    return new Response(null, { headers });
  }
  // A one-time GET holds its session open until its response ends, delivered or not (see Transfer.claim).
  const ended = () => stub.ended().then(result => { unwrap(result); });
  const cleanup = () => stub.finishConsumed().then(result => { unwrap(result); });
  let object: R2ObjectBody | null;
  try { object = await env.FILES.get(info.objectKey, range ? { range } : undefined); }
  catch (error) { if (info.once) ctx.waitUntil(ended()); throw error; }
  if (!object) {
    if (info.once) ctx.waitUntil(cleanup());
    throw gone();
  }
  headers.set('ETag', object.httpEtag);
  if (range) {
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`);
  }
  // A download starts at byte 0; a range further in resumes or splits one. The value says if it is a one-time link.
  if (!range || range.offset === 0) metric(env, 'download_started', clientOf(request), info.once ? 1 : 0);
  if (!info.once) return new Response(object.body, { status: range ? 206 : 200, headers });
  // A one-time response is piped so its end is seen (natively: large files cost no per-chunk CPU). Delivering
  // the whole file (a plain GET or `bytes=0-`) closes the link once the last byte is handed over; any other
  // end, an interrupted whole download (counted) too, lets the session idle from then on, open for a resume.
  // An encrypted file's never closes on delivery: decryption, a write or a save can still fail, so its network may
  // retry until the session idles out or the client says it is done (docs/E2EE.md §11).
  const whole = !range || (range.offset === 0 && range.length === info.size), closes = whole && info.mode === 'raw';
  // Of fixed length: through a plain IdentityTransformStream the response goes out chunked, without the Content-Length
  // that download clients check against the size (docs/E2EE.md §9.2, §10 step 7; tests/test_local_worker.py).
  const { readable, writable } = new FixedLengthStream(range ? range.length : info.size);
  ctx.waitUntil(object.body.pipeTo(writable).then(closes ? cleanup : ended, () => {
    if (whole) metric(env, 'one_time_interrupted');
    return ended();
  }));
  return new Response(readable, { status: range ? 206 : 200, headers });
}

/** The image type the first bytes of a file prove, of those previews show (see PREVIEW_TYPES), or null. */
function sniffed(bytes: Uint8Array) {
  const ascii = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  // AVIF: an ISO BMFF `ftyp` box with avif (a picture) or avis (a sequence) as its major or a compatible brand; HEIC is not.
  if (ascii(4, 'ftyp')) {
    // A real ftyp box is a few dozen bytes; a bigger claimed size would scan the whole file (and HEAD reads only 64).
    const size = bytes[0] * 2 ** 24 + bytes[1] * 2 ** 16 + bytes[2] * 2 ** 8 + bytes[3];
    if (size < 16 || size > 64) return null;
    const end = Math.min(bytes.length, size);
    for (let offset = 8; offset + 4 <= end; offset += 4) if (offset !== 12 && (ascii(offset, 'avif') || ascii(offset, 'avis'))) return 'image/avif';
  }
  return null;
}

/**
 * The picture a chat app shows for a link (og:image, see previewTags()), at /d/<id>/<name>?preview=1. Only link-preview
 * bots (PREVIEW_BOTS, GET or HEAD, never a browser navigation) get it, and only for a file Transfer.previewable() allows
 * whose first bytes prove it a PNG, JPEG, GIF, WebP or AVIF image (a renamed archive, or SVG, never passes), served
 * inline as that type. It counts no download and opens no one-time session, and DOWNLOAD_RATE applies as to every /d/
 * request. Everybody else, and every file that doesn't qualify, gets 404: this is no second way to a file. Caches may
 * keep it 5 minutes at most, never past the expiry; the chat app's own copy can outlive the link (privacy page).
 */
async function preview(request: Request, env: Env, id: string) {
  const none = () => json({ error: 'There is no preview for this link.', code: 'not_found' }, 404);
  if (!['GET', 'HEAD'].includes(request.method) || request.headers.get('Sec-Fetch-Mode') === 'navigate' || !PREVIEW_BOTS.test(request.headers.get('User-Agent') || '')) return none();
  const file = unwrap(await env.TRANSFERS.getByName(id).previewable());
  if (!file) return none();
  const head = request.method === 'HEAD';
  // At most PREVIEW_BYTES: the whole picture is read once, to check its first bytes and to send it.
  const object = await env.FILES.get(file.objectKey, head ? { range: { offset: 0, length: Math.min(64, file.size) } } : undefined);
  if (!object) return none();
  const bytes = new Uint8Array(await object.arrayBuffer()), type = sniffed(bytes), seconds = Math.min(300, Math.floor((file.expiresAt - Date.now()) / 1000));
  if (!type || seconds < 1 || (!head && bytes.length !== file.size)) return none();
  if (!head) metric(env, 'preview_served', type.slice(6), file.size);
  return new Response(head ? null : bytes, { headers: {
    'Content-Type': type, 'Content-Length': String(file.size), 'Content-Disposition': 'inline', 'Cache-Control': `public, max-age=${seconds}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cross-Origin-Resource-Policy': 'same-origin', Vary: 'User-Agent', ETag: object.httpEtag,
  } });
}

interface PageData {
  state: 'ready' | 'protected' | 'unlocked' | 'uploading' | 'gone'; id: string | null; name: string | null; size: number | null;
  type: string | null; ext: string | null; expiresAt: number | null; once: boolean; protected: boolean; risky: boolean;
  url: string | null; downloadUrl: string | null; received: number | null; updatedAt: number | null; reason: string | null;
  error: 'wrong' | 'paused' | null; triesLeft: number | null; pausedUntil: number | null;
  /** The Worker's time when it rendered the page: the page counts down against it, not the device's clock. */
  now: number;
  /**
   * `raw` or `e2ee` (null on a gone page). An encrypted transfer's `head` and `meta` (b64url) where a raw file's name would
   * show, else null; its name, type and badge the page finds after decrypting (docs/E2EE.md §12.2).
   */
  mode: string | null; head: string | null; meta: string | null;
}

/**
 * Open Graph and Twitter tags for chat link previews, in the language of the page (`text`, the messages of the generated
 * page it is written into). A shown transfer gets its name, "size · type · expires in …" ("still uploading" while it is)
 * and its canonical link; an image that previews may show (see preview(): ready, not one-time, at most PREVIEW_BYTES,
 * named as an image type) also gets its picture. A protected link (unlocked too), an encrypted one and a gone one
 * (quarantined too) keep generic text: no name, no picture.
 */
function previewTags(data: PageData, text: ReturnType<typeof messagesOf>) {
  const tags: [string, string][] = [['og:site_name', 'fyl.at'], ['og:type', 'website'], ['og:locale', OG_LOCALES[text.lang] || 'en_GB']];
  const sealed = data.mode === 'e2ee', name = (data.state === 'ready' || data.state === 'uploading') && !data.protected && !sealed ? data.name : null;
  if (data.state === 'gone') tags.push(['og:title', 'fyl.at — Fyl for now.'], ['og:description', text.t('download.description')]);
  else if (sealed) tags.push(['og:title', text.t('download.ogEncryptedTitle')], ['og:description', text.t('download.ogEncryptedDescription')]);
  else if (name === null) tags.push(['og:title', text.t('download.ogProtectedTitle')], ['og:description', text.t('download.ogProtectedDescription')]);
  else {
    const when = data.state === 'uploading' || data.expiresAt === null ? text.t('download.ogUploading') : text.t('download.ogExpiresIn', { time: text.span(data.expiresAt - data.now) });
    tags.push(['og:title', name], ['og:description', `${text.size(data.size || 0)} · ${text.type(data.type || 'file')} · ${when}`]);
  }
  if (data.state !== 'gone' && data.url) tags.push(['og:url', data.url]);
  const image = name !== null && data.state === 'ready' && !data.once && data.url && (data.size || 0) <= PREVIEW_BYTES ? previewType(name) : null;
  if (image && name !== null) tags.push(['og:image', `${data.url}?preview=1`], ['og:image:type', image], ['og:image:alt', name], ['twitter:card', 'summary_large_image']);
  else tags.push(['twitter:card', 'summary']);
  const attribute = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  return tags.map(([tag, content]) => `<meta ${tag.startsWith('og:') ? 'property' : 'name'}="${tag}" content="${attribute(content)}">`).join('');
}

/**
 * Script and worker paths of the download page beyond its own <script> files: the E2EE modules and the vendored
 * libraries they import; the E2EE workers, with the same modules (browsers check a module worker's imports against the
 * page's worker-src too), and the download service worker (docs/E2EE.md §9.2).
 */
const PAGE_MODULES = ['/e2ee/', '/vendor/'], PAGE_WORKERS = ['/e2ee/', '/vendor/', '/_dl/sw.js'];
/**
 * The site's own pages (and the download page's bare template), which hold keys or share the browser's storage with
 * the page that does, served through the Worker (`run_worker_first` in wrangler.jsonc) only to get the same kind of
 * policy: with the upload page's workers (the MD5 worker, the E2EE worker) and their modules, and on the report form
 * Cloudflare Turnstile, the one script from elsewhere, with its frame (docs/E2EE.md §15.6). Each exists once per locale
 * (/<lang>/…, generated into dist/<lang>/ by scripts/build_i18n.mjs, i18n/README.md); the value is the kind of page a
 * GET counts (page_view), none for the bare template.
 */
const SITE_PAGES = new Map<string, PageKind | null>([['/', 'home'], ['/privacy', 'privacy'], ['/report', 'report'], ['/download', null]]);
const SITE_WORKERS = ['/md5-worker.js', '/e2ee/', '/vendor/'];
/**
 * The pages' addresses before they had a locale, and their path inside one: each answers 301 to its English page,
 * which is the binding version. `/report` goes to the report host instead, where it has one (see the fetch handler).
 */
const OLD_PAGES = new Map([['/index.html', '/'], ['/privacy', '/privacy'], ['/privacy.html', '/privacy'], ['/report', '/report'], ['/report.html', '/report'],
  ['/download', '/download'], ['/download.html', '/download']]);
/**
 * Every page names llms.txt in Link headers as well as in its <head>: an agent's fetch tool usually keeps the headers
 * and drops the head when it extracts the text. Absolute, so they hold on the report host too.
 */
function agentLinks(headers: Headers, env: Env) {
  const llms = `<${(env.PUBLIC_BASE_URL || 'https://fyl.at').replace(/\/$/, '')}/llms.txt>`;
  headers.append('Link', `${llms}; rel="describedby"; type="text/markdown"`);
  headers.append('Link', `${llms}; rel="alternate"; type="text/markdown"`);
}

/**
 * `/` for an agent: a request that doesn't ask for HTML (curl and most agents' fetch tools accept any type), or ranks
 * text/markdown or text/plain above it, gets llms.txt itself instead of the language switch. Browsers ask for
 * text/html first; crawlers and link-preview bots always get the switch, so search and previews see the pages.
 */
function wantsManual(request: Request) {
  const agent = request.headers.get('User-Agent') || '';
  if (CRAWLERS.test(agent) || PREVIEW_BOTS.test(agent)) return false;
  const quality = (type: string) => {
    let best = 0;
    for (const part of (request.headers.get('Accept') || '').split(',')) {
      const [range, ...params] = part.trim().toLowerCase().split(';');
      if (range.trim() !== type) continue;
      const q = params.map(param => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/.exec(param)?.[1]).find(Boolean);
      best = Math.max(best, q === undefined ? 1 : Number(q));
    }
    return best;
  };
  const html = Math.max(quality('text/html'), quality('application/xhtml+xml'));
  return html === 0 || Math.max(quality('text/markdown'), quality('text/plain')) > html;
}
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/**
 * A page's Content-Security-Policy, set here rather than in dist/_headers (docs/E2EE.md §9.5, §15.6): the site's
 * policy, but scripts and workers come only from fyl's own script paths, named one by one (a path ending in `/` names a
 * folder), never 'self', which would admit the scripts Cloudflare injects under /cdn-cgi/. `outside`: origins a page
 * may load scripts and frames from as well (Turnstile on the report form).
 */
function pagePolicy(origin: string, scripts: string[], workers = PAGE_WORKERS, outside: string[] = []) {
  const sources = (paths: string[]) => [...new Set(paths)].map(path => origin + path).join(' ');
  const extra = outside.map(source => ' ' + source).join('');
  return `default-src 'self'; script-src ${sources([...scripts, ...PAGE_MODULES])}${extra}; worker-src ${sources(workers)}; `
    + (outside.length ? `frame-src ${outside.join(' ')}; ` : '') + "style-src 'self'; "
    + "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";
}
/** The same-origin paths of a page's <script src> files (relative ones resolved against `address`). */
function scriptPaths(template: string, address: string) {
  const origin = new URL(address).origin;
  return [...template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => new URL(match[1], address))
    .filter(url => url.origin === origin).map(url => url.pathname);
}
/**
 * A page of SITE_PAGES in a locale (`path`: /<lang>/…) from the static assets, with its policy (pagePolicy) and without
 * validators, so none is reused. Every page names llms.txt in Link headers (agentLinks()).
 */
async function sitePage(request: Request, env: Env, path: string) {
  const page = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!page.ok || !(page.headers.get('Content-Type') || '').startsWith('text/html')) return page;
  const template = await page.text(), headers = new Headers(page.headers), inside = path.slice(3) || '/';
  headers.set('Content-Security-Policy', pagePolicy(new URL(request.url).origin, scriptPaths(template, request.url), SITE_WORKERS,
    inside === '/report' ? [TURNSTILE_ORIGIN] : []));
  agentLinks(headers, env);
  headers.delete('ETag'); headers.delete('Last-Modified');
  return new Response(request.method === 'HEAD' ? null : template, { status: page.status, headers });
}

/**
 * `/` (and the report host's `/`) only picks a language: 302, never 301, to /<lang>/ with the query (utm tags, a
 * report's ?link=), by Accept-Language (negotiate(); the visitor's country only when the header is missing), English when nothing fits. Vary and no-store keep every cache
 * from handing one visitor's choice to the next; hreflang names `/` as the x-default. Nothing is stored, no cookie set.
 */
async function languageSwitch(request: Request, env: Env, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET.');
  if (wantsManual(request)) {
    const manual = await env.ASSETS.fetch(new Request(new URL('/llms.txt', request.url)));
    const headers = new Headers({ 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept, Accept-Language',
      'X-Content-Type-Options': 'nosniff', 'Content-Location': '/llms.txt' });
    agentLinks(headers, env);
    return new Response(request.method === 'HEAD' ? null : manual.body, { status: manual.ok ? 200 : 502, headers });
  }
  const headers = new Headers({ Location: `/${negotiate(request.headers.get('Accept-Language'), request.headers.get('CF-IPCountry'))}/${url.search}`,
    Vary: 'Accept, Accept-Language', 'Cache-Control': 'no-store' });
  agentLinks(headers, env);
  return new Response(null, { status: 302, headers });
}
const moved = (location: string) => new Response(null, { status: 301, headers: { Location: location, 'Cache-Control': 'public, max-age=3600' } });

/**
 * The language of a download page, which keeps its address (/d/<id> is shared as it is): ?lang= from the page's own
 * language menu, else what the browser asks for (Accept-Language). These pages are noindex and answer Vary: Accept-Language.
 */
function pageLanguage(request: Request) {
  const asked = new URL(request.url).searchParams.get('lang') || '';
  return LOCALES.includes(asked) ? asked : negotiate(request.headers.get('Accept-Language'), request.headers.get('CF-IPCountry'));
}

/**
 * Answers a download link opened in a browser with dist/<lang>/download.html (i18n/templates/download.html): <html data-state> and its flags pick what
 * it shows, and the JSON block in <head> carries the details. The page is served from /d/<id>/<name>, so its
 * assets use absolute paths (no <base>: it would send in-page links such as #content to /). Pages never send
 * WWW-Authenticate, so browsers never show their own password dialog. An encrypted transfer's page is
 * <html data-e2ee> and keeps the title "Encrypted file · fyl.at" (docs/E2EE.md §9.5).
 */
async function downloadPage(request: Request, env: Env, data: PageData, status: number, extra: Record<string, string> = {}) {
  const lang = pageLanguage(request), address = new URL(`/${lang}/download`, request.url);
  const page = await env.ASSETS.fetch(new Request(address));
  if (!page.ok) throw new Error('The download page is missing.');
  const template = await page.text(), scripts = scriptPaths(template, address.href), text = messagesOf(template);
  const block = JSON.stringify(data).replaceAll('<', '\\u003c'), sealed = data.mode === 'e2ee';
  const transformed = new HTMLRewriter().on('html', {
    element(html) {
      html.setAttribute('data-state', data.state);
      for (const flag of ['once', 'risky', 'protected'] as const) {
        if (data[flag]) html.setAttribute('data-' + flag, ''); else html.removeAttribute('data-' + flag);
      }
      if (sealed) html.setAttribute('data-e2ee', ''); else html.removeAttribute('data-e2ee');
    },
  }).on('title', {
    element(title) { if (sealed) title.setInnerContent(text.t('download.encryptedTitle')); },
  }).on('a[data-lang]', {
    // The language menu keeps this address: the same page with ?lang= (download.js carries the fragment along).
    element(link) { link.setAttribute('href', `?lang=${link.getAttribute('data-lang')}`); },
  }).on('meta[property^="og:"], meta[name^="twitter:"]', {
    // The page's own preview tags, if it has any: the ones below describe this link, and chat apps read the first.
    element(meta) { meta.remove(); },
  }).on('head', {
    // Appended, so <meta charset> stays within the first bytes of the document.
    element(head) { head.append(`<script type="application/json" id="fyl-state">${block}</script>${previewTags(data, text)}`, { html: true }); },
  }).on('#download', {
    // Without JavaScript the button still leads to the file.
    element(link) { if (data.downloadUrl) link.setAttribute('href', data.downloadUrl); },
  }).transform(new Response(template, page));
  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Content-Security-Policy', pagePolicy(new URL(request.url).origin, scripts));
  headers.set('Vary', 'Accept-Language');
  headers.delete('ETag');
  agentLinks(headers, env);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  pageView(env, request, data.state === 'gone' ? 'gone' : 'download', visitorOf(request), data.state === 'gone' ? data.reason || '' : '');
  return new Response(transformed.body, { status, headers });
}

/** The page for a transfer that can be shown: ready (protected, unlocked or not) or still uploading. */
async function shownPage(request: Request, env: Env, view: PageView, id: string, base: string) {
  const raw = view.mode === 'raw', link = linkOf(base, id, view.protected || !raw ? null : view.name);
  const state = view.status === 'uploading' ? 'uploading' : !view.protected ? 'ready' : view.unlocked ? 'unlocked' : 'protected';
  const error = state === 'protected' ? view.error : null;
  // An encrypted file downloads only from the page's button, which decrypts it: no address of the file goes into the
  // page, so nothing opens it without JavaScript (docs/E2EE.md §9.5).
  const downloadUrl = !raw ? null : state === 'unlocked' ? `${link}?grant=${await grant(env, id)}`
    : state === 'ready' || (state === 'uploading' && !view.protected) ? link + '?dl=1' : null;
  if (state === 'uploading') metric(env, 'early_wait');
  return downloadPage(request, env, {
    state, id, name: view.name, size: view.size, ...(view.name === null ? { ext: null, type: null, risky: false } : kind(view.name)),
    expiresAt: view.expiresAt, once: view.once, protected: view.protected, url: link, downloadUrl, received: view.received,
    updatedAt: view.updatedAt, reason: null, error, triesLeft: state === 'protected' ? view.triesLeft : null,
    pausedUntil: error === 'paused' ? view.pausedUntil : null, now: Date.now(), mode: view.mode, head: view.head, meta: view.meta,
  }, error === 'wrong' ? 401 : error === 'paused' ? 429 : 200, error === 'paused' ? { 'Retry-After': String(secondsUntil(view.pausedUntil)) } : {});
}

/**
 * The page for a link that doesn't work (any more, or while a report is reviewed), with the reason; it keeps the error's
 * status. `unsupported_mode`: a transfer of a mode only a newer fyl.at knows, whose page starts nothing (docs/E2EE.md §12.2).
 */
function gonePage(request: Request, env: Env, id: string, error: ApiError) {
  const reason = ['expired', 'consumed', 'deleted', 'removed', 'quarantined', 'unsupported_mode'].includes(error.code) ? error.code
    : error.code === 'rate_limited' ? 'busy' : 'missing';
  return downloadPage(request, env, {
    state: 'gone', id: validId(id) ? id : null, name: null, size: null, type: null, ext: null, expiresAt: null, once: false,
    protected: false, risky: false, url: null, downloadUrl: null, received: null, updatedAt: null, reason, error: null,
    triesLeft: null, pausedUntil: null, now: Date.now(), mode: null, head: null, meta: null,
  }, error.status);
}

/** A browser opening an address: a GET for HTML without a range, whatever the query says. */
const navigation = (request: Request) => request.method === 'GET' && !request.headers.has('Range')
  && (request.headers.get('Accept') || '').includes('text/html');
/** For an encrypted file also any GET the browser marks as a navigation (docs/E2EE.md §12.2): it gets the page, never ciphertext. */
const browsing = (request: Request) => navigation(request) || (request.method === 'GET' && request.headers.get('Sec-Fetch-Mode') === 'navigate');

/** Browsers opening a link, and link-preview bots whatever they ask for, get the download page and never the file. */
function pageRequest(request: Request) {
  if (previewBot(request)) return true;
  const query = new URL(request.url).searchParams;
  return request.method === 'GET' && !request.headers.has('Range') && !query.has('dl') && !query.has('grant')
    && (request.headers.get('Accept') || '').includes('text/html');
}

// Link-preview fetchers and crawlers, some of which ask for `*/*`. A match only withholds the file (the bot
// gets the page instead) and never grants access, so it is no authentication: any client can send any
// User-Agent. A browser navigation (`Sec-Fetch-Mode: navigate`) is never treated as a bot, so an in-app
// browser whose User-Agent names its app (Snapchat, Viber, …) can still download.
const PREVIEW_BOTS = /facebookexternalhit|Facebot|Twitterbot|Slackbot|Slack-ImgProxy|LinkedInBot|Discordbot|TelegramBot|WhatsApp|SkypeUriPreview|MicrosoftPreview|Microsoft Office|Googlebot|bingbot|Applebot|redditbot|Pinterest|Embedly|Iframely|Mastodon|Synapse \(bot|Viber|Snapchat/i;
const previewBot = (request: Request) => request.method === 'GET' && request.headers.get('Sec-Fetch-Mode') !== 'navigate'
  && PREVIEW_BOTS.test(request.headers.get('User-Agent') || '');

/** The JSON answer to an error; anything but an ApiError is logged (its type only) and answers 503. */
function failed(env: Env, error: unknown, route: 'api' | 'download' | 'admin') {
  if (error instanceof ApiError) {
    if (error.code === 'misconfigured') metric(env, 'misconfigured');
    return json({ error: error.message, code: error.code }, error.status);
  }
  console.error(JSON.stringify({ event: 'request_failed', route, type: error instanceof Error ? error.name : 'unknown' }));
  return json({ error: 'Temporarily unavailable. Please retry.', code: 'temporarily_unavailable' }, 503);
}

/**
 * The CLI files a GET answered 200 counts (`cli_fetch`, statistics only): `install` for the installer, else the
 * binary's platform (`linux-x86_64`, `linux-arm64`, `macos-x86_64`, `macos-arm64`) of any version; null for anything
 * else (latest, version.json, SHA256SUMS).
 */
function cliFile(path: string) {
  if (path === '/cli/install') return 'install';
  return /^\/cli\/\d+\.\d+\.\d+\/fyl-((?:linux|macos)-(?:x86_64|arm64))$/.exec(path)?.[1] ?? null;
}

/** A /cli/ request the asset layer answered with an error: its status, as plain text that no cache keeps. */
function cliMissing(request: Request, response: Response) {
  const headers = new Headers(response.headers);
  headers.delete('Content-Disposition');
  headers.delete('ETag');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : response.status === 404 ? 'Not found.\n' : response.body, { status: response.status, headers });
}

/**
 * A browser navigation (a GET for HTML) to a page address that doesn't exist: a mistyped or old link such as /faq or
 * /en/nonexistent. Never a file (a last segment with an extension other than .html), the API, a download link, the
 * CLI, /.well-known or the folders of scripts, fonts and pictures: those keep their 404.
 */
const STRAY_EXCLUDED = /^\/(?:api|cli|d|\.well-known|_dl|admin|e2ee|vendor|fonts|og|cdn-cgi)(?:\/|$)/;
function strayNavigation(request: Request, path: string) {
  if (!navigation(request) || STRAY_EXCLUDED.test(path)) return false;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.') || last.endsWith('.html');
}
/** Such a navigation goes to the home page (302): of the address's language, else chosen as `/` chooses it. */
function strayPage(request: Request, lang: string | null) {
  const code = lang || negotiate(request.headers.get('Accept-Language'), request.headers.get('CF-IPCountry'));
  return new Response(null, { status: 302, headers: { Location: `/${code}/`, Vary: 'Accept, Accept-Language', 'Cache-Control': 'no-store' } });
}

/**
 * The public site's files the dashboard uses too; on the admin host they pass only after the Access check, like everything:
 * assets.run_worker_first is true, so no file of dist/ reaches that host from the asset layer without the Worker.
 */
const SHARED_FILES = /^\/(?:styles\.css|theme\.js|favicon\.svg|apple-touch-icon\.png|fonts\/[\w.-]+\.woff2)$/;
/** The dashboard's own files (dist/admin/), served on the admin host only; its page is the host's `/`. */
const DASHBOARD_FILES = /^\/admin\/[\w-]+\.(?:css|js|svg)$/;
const NOT_FOUND = () => new Response('Not found.\n', { status: 404, headers: {
  'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });

/** The dashboard's own reads besides the operator views: its statistics and the billing estimate (src/billing.ts). */
const DASHBOARD_READS = new Set(['/api/stats', '/api/billing']);

/**
 * The admin host (ADMIN_HOST, admin.fyl.at): nothing without a valid Cloudflare Access token (accessOf(), 403
 * otherwise). Then `/` is the private dashboard (dist/admin/, never served on the public host), `/api/stats` its
 * statistics, `/api/billing` the estimate of the open Cloudflare bill, and `/api/admin/*` the operator API. An
 * owner's identity reads the dashboard's data without a token and without ADMIN_RATE (no token is guessed there);
 * everything else, every change included, needs the operator token as on the public host. The one exception is the
 * read-only MONITOR_TOKEN: besides readiness it reads `GET /api/billing`, so the hourly monitor can alert on the bill
 * between the account's budget alert and what the caps allow (scripts/monitor.py, docs/COSTS.md), under ADMIN_RATE
 * like readiness. Never the statistics (referrers, campaigns: more than an alert needs), never a change; on the public
 * host /api/billing doesn't exist. Pages and files are never cached.
 */
async function adminSite(request: Request, env: Env, path: string) {
  try {
    const access = await accessOf(request, env);
    if (path === '/' || DASHBOARD_FILES.test(path) || SHARED_FILES.test(path)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET.');
      const file = await env.ASSETS.fetch(path === '/' ? new Request(new URL('/admin/', request.url), request) : request);
      if (file.status === 404) return NOT_FOUND();
      const headers = new Headers(file.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(file.body, { status: file.status, headers });
    }
    if (!DASHBOARD_READS.has(path) && !path.startsWith('/api/admin/')) return NOT_FOUND();
    if (request.method !== 'GET' && request.method !== 'HEAD') originCheck(request);
    const read = access.owner && request.method === 'GET' && (DASHBOARD_READS.has(path) || OWNER_READS.has(path));
    if (!read) await rate(env, 'ADMIN_RATE', networkOf(request.headers.get('CF-Connecting-IP') || 'local'));
    if (path.startsWith('/api/admin/')) return await admin(request, env, path, access.owner);
    if (request.method !== 'GET') throw new ApiError(405, 'Use GET.');
    // Scripts read the statistics and the estimate with the operator token, like every other operator view; the
    // monitor's token reads the estimate alone (GET only: anything else got 405 above).
    const tokens = [configured(env, 'ADMIN_TOKEN'), path === '/api/billing' ? configured(env, 'MONITOR_TOKEN') : null];
    if (!read && !await bearer(request, tokens)) throw new ApiError(401, 'Operator token required.', 'denied');
    return path === '/api/billing' ? await billing(request, env) : await stats(request, env);
  } catch (error) { return failed(env, error, 'admin'); }
}

/** window.FYL_CONFIG for the pages. The report page renders the Turnstile widget only when it gets the site key, i.e.
 * when the server checks it. `e2ee`: whether the upload page offers encryption (new encrypted uploads are taken;
 * docs/E2EE.md §12.2). */
function configScript(env: Env) {
  const guard = turnstile(env), config = { maxFileBytes: Number(env.MAX_FILE_BYTES), e2ee: e2eeEnabled(env), ...guard.on ? { turnstileSiteKey: guard.siteKey } : {} };
  return new Response(`window.FYL_CONFIG=${JSON.stringify(config)};`,
    { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** A report as POST /api/reports (see Reports), on the report host and, for API clients, on the public host. */
async function reportPost(request: Request, env: Env, base: string, address: string, ip: string, subscriber: string, day: number) {
  if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
  await rate(env, 'REPORT_RATE', ip);
  const data = await readJSON(request, 16384), report = reportOf(data, base), guard = turnstile(env);
  // After the fields are checked, so a typo doesn't use up the token.
  if (guard.on) await human(env, guard.secret, data.turnstile, address, base);
  const network = await networkHash(env.NETWORK_HASH_KEY, subscriber + ':' + day);
  // A link nothing is known of (never, or its tombstone is purged) can't be reported. One that closed within the
  // last 7 days can (a used one-time link, say): the operator sees the file is gone. On a file taken down the case
  // is kept, closed as removed: that is decided.
  const view = unwrap(await env.TRANSFERS.getByName(report.transferId).operatorView(report.transferId));
  if (!view.exists) throw new ApiError(404, 'There is no file at this link.', 'not_found');
  const gone = closedOutcome(view);
  const created = unwrap(await reports(env).create({ ...report, network, fileAvailable: !gone, outcome: gone === 'removed' ? 'removed' : null }));
  metric(env, 'report_received', report.category);
  return json(created, 201);
}

const REPORT_FILES = /^\/(?:report\.js|config\.js|i18n\.js)$/;

/**
 * The report host (REPORT_HOST, report.fyl.at, since 2.4.0): the report form, its files and POST /api/reports, nothing
 * else, so Turnstile's script never runs on fyl.at's origin, where the upload page may remember encryption keys
 * (docs/E2EE.md). `/<lang>/` is the form in a language (with Turnstile in its policy), `/` picks one like fyl.at's `/`
 * (languageSwitch(), keeping ?link=), and the form's old address `/report` moved to `/en/`. Its links to the site point
 * to PUBLIC_BASE_URL, its language menu to the form in the other languages.
 */
async function reportSite(request: Request, env: Env, path: string, base: string, address: string, ip: string, subscriber: string, day: number) {
  try {
    const url = new URL(request.url), lang = localeOf(path);
    if (path === '/') return await languageSwitch(request, env, url);
    if (path === '/report' || path === '/report.html') return moved('/en/' + url.search);
    if (lang && path === '/' + lang) return moved(`/${lang}/${url.search}`);
    if (lang && path === `/${lang}/`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET.');
      const page = await sitePage(request, env, `/${lang}/report`);
      if (!page.ok) return page;
      pageView(env, request, 'report', visitorOf(request));
      const site = new HTMLRewriter().on('a[href^="/"]', {
        element(link) {
          const href = link.getAttribute('href') || '', form = /^\/([a-z]{2})\/report$/.exec(href);
          if (href.startsWith('//')) return;
          link.setAttribute('href', form && localeOf(href) ? `/${form[1]}/` : base + href);
        },
      });
      return site.transform(page);
    }
    if (path === '/config.js') return configScript(env);
    // RFC 9116 is per origin: the same security.txt as fyl.at's, which names this host's address as a Canonical too.
    if (path === '/.well-known/security.txt') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET.');
      return await env.ASSETS.fetch(request);
    }
    if (path === '/api/reports') {
      originCheck(request);
      return await reportPost(request, env, base, address, ip, subscriber, day);
    }
    if (SHARED_FILES.test(path) || REPORT_FILES.test(path)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET.');
      return await env.ASSETS.fetch(request);
    }
    return NOT_FOUND();
  } catch (error) { return failed(env, error, 'api'); }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const adminHost = adminHostOf(env);
    if (adminHost && url.hostname.replace(/\.$/, '').toLowerCase() === adminHost) return await adminSite(request, env, path);
    const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, '');
    const address = request.headers.get('CF-Connecting-IP') || 'local';
    // Rate limits key on the network; budgets, password tries and report limits on the subscriber (see networkOf()).
    const ip = networkOf(address), subscriber = networkOf(address, 56), day = Math.floor(Date.now() / 86400000);
    const reportHost = reportHostOf(env);
    if (reportHost && url.hostname.replace(/\.$/, '').toLowerCase() === reportHost) return await reportSite(request, env, path, base, address, ip, subscriber, day);
    try {
      if (path === '/config.js') return configScript(env);
      // The report form moved to its own origin; old links keep their ?link=, and the report host's / picks the language.
      if (reportHost && (path === '/report' || path === '/report.html')) return Response.redirect(`https://${reportHost}/${url.search}`, 302);
      // Only / redirects by language (languageSwitch()); a page of a locale never does, old addresses move to English.
      if (path === '/') return await languageSwitch(request, env, url);
      if (OLD_PAGES.has(path)) return moved(`/en${OLD_PAGES.get(path)}${url.search}`);
      if (path === '/api/health') {
        // HEAD answers like GET without the body: uptime monitors and load balancers often check with HEAD.
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Use GET or HEAD.');
        const health = json({ service: 'fyl.at', status: 'ok', maxFileBytes: Number(env.MAX_FILE_BYTES), partSize: PART_BYTES, e2ee: e2eeEnabled(env) });
        return request.method === 'HEAD' ? new Response(null, { status: health.status, headers: health.headers }) : health;
      }
      if (path.startsWith('/d/')) return await download(request, env, ctx, linkId(path), ip, subscriber, base);
      // The dashboard's files exist on the admin host only.
      if (path === '/admin' || path.startsWith('/admin/')) return NOT_FOUND();
      // The download service worker answers /_dl/<token> itself, inside the browser; a request that reaches the Worker
      // never gets anything (docs/E2EE.md §9.2). Its script /_dl/sw.js is a static file.
      if (path.startsWith('/_dl/') && path !== '/_dl/sw.js') throw new ApiError(404, 'Not found.', 'not_found');
      // The site's pages in a locale: /<lang>/, /<lang>/privacy, /<lang>/report (on the report host where there is one) and
      // the bare /<lang>/download, with their Content-Security-Policy from sitePage(). /<lang> and the .html names move.
      const lang = localeOf(path), inside = lang ? path.slice(3) || '/' : '';
      if (lang && path === '/' + lang) return moved(`/${lang}/${url.search}`);
      if (lang && (inside === '/index.html' || inside === '/privacy.html' || inside === '/report.html' || inside === '/download.html'))
        return moved(`/${lang}${inside === '/index.html' ? '/' : inside.slice(0, -5)}${url.search}`);
      if (lang && reportHost && inside === '/report') return Response.redirect(`https://${reportHost}/${lang}/${url.search}`, 302);
      if (lang && SITE_PAGES.has(inside) && (request.method === 'GET' || request.method === 'HEAD')) {
        const kind = SITE_PAGES.get(inside), response = await sitePage(request, env, path);
        if (kind && (response.status === 200 || response.status === 304)) pageView(env, request, kind, visitorOf(request));
        return response;
      }
      // Every other file of dist/, through the asset layer with its _headers and .html handling.
      if (!path.startsWith('/api/')) {
        const response = await env.ASSETS.fetch(request);
        // A CLI file that isn't there (a version not published yet, say) must not keep the _headers rules of the
        // published ones: no year-long immutable caching, no attachment, no binary type.
        if (path.startsWith('/cli/') && response.status >= 400) return cliMissing(request, response);
        if (response.status === 404 && strayNavigation(request, path)) return strayPage(request, lang);
        const fetched = cliFile(path);
        if (fetched && request.method === 'GET' && response.status === 200 && clientOf(request) !== 'own') metric(env, 'cli_fetch', fetched);
        return response;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') originCheck(request);
      // The operator API lives on the admin host only; without one (local development) the public host serves it.
      if (path.startsWith('/api/admin/')) {
        if (adminHostOf(env)) return NOT_FOUND();
        await rate(env, 'ADMIN_RATE', ip); return await admin(request, env, path);
      }

      if (path === '/api/upload/init') {
        if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
        await rate(env, 'INIT_RATE', ip);
        const data = await readJSON(request, 8192);
        // An encrypted upload (docs/E2EE.md §12.1) sends `mode: "e2ee"`, the size C of its age file and its head and
        // meta, never a name; anything else is a raw upload, exactly as before.
        const mode = data.mode ?? 'raw';
        if ((mode !== 'raw' && mode !== 'e2ee') || (mode === 'raw' && data.e2ee !== undefined)) throw new ApiError(400, 'Use mode "raw" or "e2ee".');
        let sealed: ReturnType<typeof sealedBlobs> | null = null;
        if (mode === 'e2ee') {
          if (!e2eeEnabled(env)) throw new ApiError(403, "This server doesn't accept encrypted uploads at the moment.", 'e2ee_disabled');
          if (data.filename !== undefined) throw new ApiError(400, 'An encrypted upload sends no file name: it is in its encrypted metadata.');
          if (!Number.isSafeInteger(data.size)) throw new ApiError(400, 'Send the size of the encrypted file.');
          if (Number(data.size) > Number(env.MAX_FILE_BYTES))
            throw new ApiError(413, `The encrypted file must be no larger than ${Number(env.MAX_FILE_BYTES) / 1073741824} GB.`);
          if (Number(data.size) < 201 || plaintextSize(Number(data.size)) === null) throw new ApiError(400, 'No encrypted file has this size.');
          sealed = sealedBlobs(data.e2ee);
        } else {
          // Names are shown as they are, minus bidi controls: those are invisible and could disguise the extension
          // (`invoice_<RLO>fdp.exe` shown as invoice_exe.pdf), and apps put them in ordinary names (WhatsApp wraps a
          // phone number in U+202A … U+202C), so they are dropped rather than refused. Path separators, controls (C0
          // and C1), lone surrogates (which no URL or header can encode) and line separators are refused.
          if (typeof data.filename === 'string') data.filename = data.filename.replace(/[\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, '');
          if (typeof data.filename !== 'string' || !data.filename || new TextEncoder().encode(data.filename).length > 1024
              || /[\p{Cc}\p{Cs}\u{2028}\u{2029}/\\]/u.test(data.filename)
              || /^\.+$/.test(data.filename)) throw new ApiError(400, 'Choose a valid file name.');
          if (!Number.isSafeInteger(data.size) || Number(data.size) < 1 || Number(data.size) > Number(env.MAX_FILE_BYTES))
            throw new ApiError(413, `The file must be non-empty and no larger than ${Number(env.MAX_FILE_BYTES) / 1073741824} GB.`);
        }
        const expiresIn = data.expiresIn === undefined ? 86400 : data.expiresIn;
        if (!validExpiry(expiresIn) || (data.oneTime !== undefined && typeof data.oneTime !== 'boolean'))
          throw new ApiError(400, 'Choose an expiry between 5 minutes and 7 days.');
        if (data.partSize !== undefined && data.partSize !== PART_BYTES) throw new ApiError(400, 'Use 50 MiB parts.');
        if (data.clientKey !== undefined && !validKey(data.clientKey)) throw new ApiError(400, 'Invalid client key.');
        // null counts as no password, like a missing one.
        if (data.password != null && !validPassword(data.password))
          throw new ApiError(400, 'Password must be 6 to 200 characters, without control characters.');
        const password = typeof data.password === 'string' ? data.password : undefined;
        const key = typeof data.clientKey === 'string' ? data.clientKey : randomToken();
        const idempotency = request.headers.get('Idempotency-Key');
        if (idempotency && !/^[a-zA-Z0-9_-]{16,128}$/.test(idempotency)) throw new ApiError(400, 'Invalid idempotency key.');
        const id = data.clientKey && idempotency ? await digest(key + ':' + idempotency) : randomToken();
        // An encrypted transfer keeps a generic name, only for Content-Disposition (docs/E2EE.md §4.4).
        const metadata: InitMetadata = { name: sealed ? `fyl-${id.slice(0, 8)}.age` : String(data.filename), size: Number(data.size), expiresIn,
          once: data.oneTime === true, fingerprint: '', ...(sealed ? { mode: 'e2ee', head: sealed.head, meta: sealed.meta } : {}),
          ...(password ? await passwordRecord(password) : {}), client: clientOf(request) };
        // A replay with another password is another upload. The fingerprint is stored, so it gets a keyed
        // signature of the password: a plain digest could be guessed far faster than the PBKDF2 hash. An encrypted
        // upload's names its mode and hashes its head and meta instead of a name, so a replay with others is another one.
        const signature = password ? { password: await sign(secret(env, 'GRANT_SIGNING_KEY'), 'fyl-password:' + password.normalize('NFC')) } : {};
        metadata.fingerprint = await digest(JSON.stringify(sealed
          ? { mode: 'e2ee', size: metadata.size, expiresIn, once: metadata.once, head: await digestBytes(sealed.bytes.head), meta: await digestBytes(sealed.bytes.meta), ...signature }
          : { name: metadata.name, size: metadata.size, expiresIn, once: metadata.once, ...signature }));
        // Today's hash for the daily limits; a stable one for the network's stored bytes, which last as long as its uploads.
        const ipHash = await networkHash(env.NETWORK_HASH_KEY, subscriber + ':' + day);
        const liveHash = await networkHash(env.NETWORK_HASH_KEY, 'fyl-live:' + subscriber);
        return json(unwrap(await env.TRANSFERS.getByName(id).init(id, key, metadata, ipHash, base, liveHash)), 201);
      }

      if (path === '/api/upload/part') {
        if (request.method !== 'PUT') throw new ApiError(405, 'Use PUT.');
        await rate(env, 'PART_RATE', ip);
        // The key comes from the Authorization header only: one in the URL (as CLI 2.0 sent it) authorises nothing.
        const { id, key } = session({ uploadId: url.searchParams.get('uploadId'), key: ownerKey(request) });
        const number = Number(url.searchParams.get('partNumber'));
        const bytes = Number(request.headers.get('Content-Length'));
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PART_BYTES || !request.body)
          throw new ApiError(413, 'Use a non-empty, length-delimited part no larger than 50 MiB.');
        const stub = env.TRANSFERS.getByName(id), body = request.body;
        // The network sending a part pays for its bytes, so a resumed upload counts where it is sent from.
        const network = await networkHash(env.NETWORK_HASH_KEY, subscriber + ':' + day);
        // An encrypted part's Content-MD5 must equal its pin (docs/E2EE.md §8.3); a raw part's is not read.
        const md5 = contentMd5(request.headers.get('Content-MD5'));
        // From the admission to the report of R2's result, one piece of work that waitUntil keeps running when the
        // client disconnects (which cancels the request): otherwise the attempt would hold its slot and reserved
        // bytes until its lease ends.
        const settled = (async () => {
          const target = unwrap(await stub.reservePart(key, number, bytes, network, md5));
          // The body streams to R2 natively; touching it chunk by chunk in JavaScript costs seconds of CPU
          // per part. R2's ETag for a part is the MD5 of the bytes it stored, which the CLI verifies. Each attempt
          // writes its own R2 part number (`slot`); responses keep the logical part number.
          let part: R2UploadedPart;
          try { part = await env.FILES.resumeMultipartUpload(target.objectKey, target.uploadId).uploadPart(target.slot, body); }
          catch (error) {
            // Frees the attempt's slot and reserved bytes at once; without this report its lease ends them. A write
            // that broke because the sender went away (Cancel upload, a closed tab: request.signal) is no fault of R2.
            try { unwrap(await stub.failPart(key, number, target.ticket, request.signal?.aborted === true)); } catch { metric(env, 'fallback', 'part_fail'); /* the lease ends it */ }
            throw error;
          }
          return unwrap(await stub.finishPart(key, number, target.ticket, part.etag));
        })();
        ctx.waitUntil(settled.catch(() => undefined));
        try { return json(await settled); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'part_busy') throw error;
          // Every slot of the part holds an attempt still running: one of them settles soon.
          const response = json({ error: error.message, code: error.code }, 503);
          response.headers.set('Retry-After', '10');
          return response;
        }
      }

      if (path === '/api/upload/pin') {
        // An encrypted part's MD5, pinned before its body is sent (docs/E2EE.md §8.3), with the part's credentials and limit.
        if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
        await rate(env, 'PART_RATE', ip);
        const data = await readJSON(request, 1024), { id, key } = session({ uploadId: data.uploadId, key: ownerKey(request) });
        if (!Number.isSafeInteger(data.partNumber) || typeof data.md5 !== 'string' || !/^[0-9a-f]{32}$/.test(data.md5))
          throw new ApiError(400, 'Send the part number and its MD5 as 32 lowercase hex digits.');
        return json(unwrap(await env.TRANSFERS.getByName(id).pin(key, Number(data.partNumber), data.md5)));
      }

      if (path === '/api/upload/status') {
        if (request.method !== 'GET') throw new ApiError(405, 'Use GET.');
        await rate(env, 'PART_RATE', ip);
        const { id, key } = session({ uploadId: url.searchParams.get('uploadId'), key: ownerKey(request) });
        return json(unwrap(await env.TRANSFERS.getByName(id).uploadStatus(key, base)));
      }

      if (path === '/api/upload/complete' || path === '/api/upload/abort') {
        if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
        await rate(env, 'PART_RATE', ip);
        const data = await readJSON(request, path.endsWith('/complete') ? 2 * 1024 * 1024 : 8192), { id, key } = session(data);
        const stub = env.TRANSFERS.getByName(id);
        if (path.endsWith('/abort')) { unwrap(await stub.remove(key, true)); return json({ aborted: true }); }
        if (!Array.isArray(data.parts) || data.parts.length < 1 || data.parts.length > Math.ceil(Number(env.MAX_FILE_BYTES) / PART_BYTES))
          throw new ApiError(400, 'Provide the uploaded file parts.');
        const parts: R2UploadedPart[] = data.parts.map(part => {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ETags must not contain control characters
          if (!isObject(part) || !Number.isSafeInteger(part.partNumber) || typeof part.etag !== 'string' || !part.etag.length || part.etag.length > 1024 || /[\u0000-\u001f\u007f]/.test(part.etag))
            throw new ApiError(400, 'Invalid part number or ETag.');
          return { partNumber: Number(part.partNumber), etag: part.etag };
        });
        return json(unwrap(await stub.complete(key, parts, base)));
      }

      if (path === '/api/reports') return await reportPost(request, env, base, address, ip, subscriber, day);

      const doneRoute = /^\/api\/transfers\/([a-zA-Z0-9_-]{43,64})\/done$/.exec(path);
      if (doneRoute) {
        // A client verified the last chunk of a one-time encrypted download: its session closes at once (docs/E2EE.md §11).
        // Always 204, so the answer says nothing about the transfer; only the session's own network closes it.
        if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
        await rate(env, 'DOWNLOAD_RATE', ip);
        unwrap(await env.TRANSFERS.getByName(doneRoute[1]).done(await networkHash(env.NETWORK_HASH_KEY, ip + ':' + doneRoute[1])));
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }

      const transferRoute = /^\/api\/transfers\/([a-zA-Z0-9_-]{43,64})$/.exec(path);
      if (transferRoute) {
        // Download pages poll the public info: they have a limit of their own, so waiting pages can't use up the downloads'.
        await rate(env, request.method === 'GET' && !request.headers.has('Authorization') ? 'STATUS_RATE' : 'DOWNLOAD_RATE', ip);
        const stub = env.TRANSFERS.getByName(transferRoute[1]);
        // A protected transfer's name (raw) or head and meta (encrypted) also go to a GET with its password as Basic
        // (docs/E2EE.md §11, §12.2), counted per subscriber as on /d/. Refusals are JSON, never a Basic challenge. The
        // network (/64) holding a one-time session goes on through a pause of the whole transfer here too, as on /d/.
        if (request.method === 'GET' && /^Basic /i.test(request.headers.get('Authorization') || '')) {
          const network = await networkHash(env.NETWORK_HASH_KEY, ip + ':' + transferRoute[1]);
          const guesser = subscriber === ip ? network : await networkHash(env.NETWORK_HASH_KEY, subscriber + ':' + transferRoute[1]);
          const result = unwrap(await stub.info(base, undefined, basicPassword(request), guesser, network));
          if ('refused' in result && result.refused) return passwordRefusal(result.refused);
          return json({ ...result, serverTime: Date.now() });
        }
        const key = ownerKey(request);
        if (request.method === 'GET') return json({ ...unwrap(await stub.info(base, key)), serverTime: Date.now() });
        if (request.method !== 'DELETE' && request.method !== 'PATCH') throw new ApiError(405, 'Use GET, PATCH or DELETE.');
        if (!key) throw new ApiError(403, 'The private management key is required.', 'denied');
        if (request.method === 'DELETE') { unwrap(await stub.remove(key, false)); return json({ deleted: true }); }
        const data = await readJSON(request, 1024);
        // The sender lifts the password pauses: {"clearPause": true}, on its own.
        // Both answer the owner's view as GET does, with the server's time to count down against.
        if (data.clearPause !== undefined) {
          if (data.clearPause !== true || Object.keys(data).length !== 1) throw new ApiError(400, 'Send {"clearPause": true} on its own.');
          return json({ ...unwrap(await stub.clearPause(key, base)), serverTime: Date.now() });
        }
        if (!validExpiry(data.expiresIn)) throw new ApiError(400, 'Choose a lifetime between 5 minutes and 7 days.');
        return json({ ...unwrap(await stub.changeExpiry(key, data.expiresIn, base)), serverTime: Date.now() });
      }
      throw new ApiError(404, 'API endpoint not found.', 'not_found');
    } catch (error) {
      if (error instanceof ApiError) {
        // A link that doesn't work shows browsers (and the page's password form) the reason.
        if (path.startsWith('/d/') && ([404, 410, 429].includes(error.status) || error.code === 'quarantined' || error.code === 'unsupported_mode')
            && (pageRequest(request) || navigation(request) || request.method === 'POST')) {
          try { return await gonePage(request, env, linkId(path), error); }
          catch { /* fall back to the JSON error */ }
        }
      }
      return failed(env, error, path.startsWith('/api/') ? 'api' : 'download');
    }
  },
} satisfies ExportedHandler<Env>;
