export const PART_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
// One-time download sessions: one network may resume/split the download until it goes idle.
const DOWNLOAD_IDLE_MS = 15 * 60 * 1000;
const DOWNLOAD_SESSION_MAX_MS = 24 * 60 * 60 * 1000;
// Closed transfers answer 410 instead of 404 this long, then their storage is dropped; no link lives longer.
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Download passwords: PBKDF2 iterations (the most Workers allow), wrong tries before a link pauses, and the pause.
export const PASSWORD_ITERATIONS = 100000;
export const PASSWORD_TRIES = 5;
export const PASSWORD_PAUSE_MS = 15 * 60 * 1000;
// An admitted part attempt holds its R2 slot and its reserved bytes until the Worker reports R2's result, or this long.
export const ATTEMPT_LEASE_MS = 6 * 60 * 60 * 1000;
// Wrong tries from all networks together within PASSWORD_PAUSE_MS that pause the whole transfer for as long, so many
// networks guessing at once are slowed down too (each of them also pauses after PASSWORD_TRIES of its own).
export const PASSWORD_TRANSFER_TRIES = 50;
/**
 * Chat link previews show the picture of an image up to this size, named as one of these types (and proven one by its
 * first bytes when it is fetched; never SVG, which can carry script): see the Worker's preview().
 */
export const PREVIEW_BYTES = 8 * 1024 * 1024;
const PREVIEW_TYPES = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif']]);
/** The image type a file name says, of those previews show, or null. */
export const previewType = (name: string) => PREVIEW_TYPES.get(/\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toLowerCase() || '') ?? null;
// Download page labels for the "size · type" line; any other extension reads "XYZ file".
const TYPES = new Map(Object.entries({
  'ZIP archive': 'zip', '7-Zip archive': '7z', 'RAR archive': 'rar', 'TAR archive': 'tar', 'gzip archive': 'gz tgz', 'bzip2 archive': 'bz2',
  'XZ archive': 'xz', 'Zstandard archive': 'zst', 'PDF document': 'pdf', 'Word document': 'doc docx docm', 'text document': 'odt rtf pages',
  'Excel spreadsheet': 'xls xlsx xlsm', 'spreadsheet': 'ods numbers csv', 'PowerPoint presentation': 'ppt pptx pptm', 'presentation': 'odp key',
  'text file': 'txt md log', 'e-book': 'epub mobi', 'JPEG image': 'jpg jpeg', 'PNG image': 'png',
  'GIF image': 'gif', 'WebP image': 'webp', 'HEIC image': 'heic heif', 'SVG image': 'svg', 'TIFF image': 'tif tiff', 'RAW photo': 'dng cr2 cr3 nef arw raf',
  'Photoshop file': 'psd', 'MP4 video': 'mp4 m4v', 'QuickTime video': 'mov', 'Matroska video': 'mkv', 'WebM video': 'webm', 'AVI video': 'avi',
  'MP3 audio': 'mp3', 'WAV audio': 'wav', 'FLAC audio': 'flac', 'AAC audio': 'm4a aac', 'Ogg audio': 'ogg opus', 'Windows program': 'exe com scr',
  'Windows installer': 'msi msix', 'disk image': 'dmg iso img vhd vhdx', 'macOS installer': 'pkg', 'Android app': 'apk', 'iOS app': 'ipa',
  'Linux package': 'deb rpm', 'Linux program': 'appimage run', 'shell script': 'sh bash zsh command', 'batch script': 'bat cmd', 'PowerShell script': 'ps1',
  'Java archive': 'jar', 'JavaScript file': 'js', 'Python script': 'py', 'JSON file': 'json', 'HTML page': 'html htm', 'font': 'ttf otf woff woff2',
}).flatMap(([label, extensions]) => extensions.split(' ').map(extension => [extension, label] as const)));
/**
 * Extensions that can run code when opened, pages and shortcuts included: the page warns before such a download. The
 * download page keeps the same list for encrypted files, whose names it finds only after decrypting (docs/E2EE.md
 * §15.4); tests/vectors/risky.json binds both.
 */
export const RISKY = new Set(('exe com scr pif msi msix msixbundle appx appxbundle msp msc bat cmd ps1 psm1 vb vbs vbe js jse ws wsc wsf wsh hta chm cpl '
  + 'scf url xll jar jnlp lnk reg dll app dmg pkg mpkg command sh bash zsh run bin appimage deb rpm apk ipa iso img vhd vhdx '
  + 'docm dotm xlsm xltm xlam pptm potm ppam ppsm sldm '
  + 'html htm xhtml shtml svg mht mhtml one library-ms search-ms settingcontent-ms desktop scpt').split(' '));
/**
 * The page's file badge (at most 4 characters), type label and program warning for a file name. The extension is what
 * follows the last dot: 1 to 10 letters and digits, or up to 20 and `-ms` (`.library-ms`), in any case.
 */
export function kind(name: string) {
  const extension = /\.([a-z0-9]{1,10}|[a-z0-9]{1,20}-ms)$/i.exec(name)?.[1].toLowerCase() || '';
  return { ext: extension ? extension.slice(0, 4).toUpperCase() : 'FILE', type: TYPES.get(extension) || (extension ? extension.toUpperCase() + ' file' : 'file'), risky: RISKY.has(extension) };
}
/**
 * End-to-end encrypted transfers (docs/E2EE.md, profile fyl-e2ee-1): the stored file is an age file, `head` its first
 * HEAD_BYTES, and `meta` a second age file of one of META_BYTES sizes. The server never decrypts either; it checks their
 * shape and sizes (§12.1), and the size C of the age file, whose plaintext size P(C) follows from the format (§6).
 */
export const HEAD_BYTES = 184;
export const META_BYTES = [712, 1224, 1736, 2248, 2760];
const CHUNK_BYTES = 65536, SEALED_CHUNK_BYTES = 65552, TAG_BYTES = 16;
/** P(C) of docs/E2EE.md §6: the plaintext size of an age file of `size` bytes, or null if no age file has that size. */
export function plaintextSize(size: number): number | null {
  const sealed = size - HEAD_BYTES;
  if (!Number.isSafeInteger(size) || sealed < TAG_BYTES) return null;
  const chunks = Math.max(1, Math.ceil(sealed / SEALED_CHUNK_BYTES)), plain = sealed - TAG_BYTES * chunks;
  return chunks >= 2 && plain <= CHUNK_BYTES * (chunks - 1) ? null : plain;
}
/** Transfer modes this server knows; a raw record stores no `mode`. */
const MODES = ['raw', 'e2ee'];
export const modeOf = (record: { mode?: string }) => record.mode ?? 'raw';
export const knownMode = (record: { mode?: string }) => MODES.includes(modeOf(record));
type RpcResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code: string };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'request_failed') { super(message); }
}

export async function guarded<T>(operation: () => T | Promise<T>): Promise<RpcResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof ApiError) return { ok: false, status: error.status, error: error.message, code: error.code };
    console.error(JSON.stringify({ event: 'operation_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return { ok: false, status: 503, error: 'Temporarily unavailable. Please retry.', code: 'temporarily_unavailable' };
  }
}

export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new ApiError(result.status, result.error, result.code);
  return result.value;
}

type MetricEvent = 'upload_completed' | 'one_time_session' | 'one_time_interrupted' | 'part_refused' | 'part_limit'
  | 'budget_refused' | 'cleanup_retry' | 'takedown' | 'pause' | 'turnstile_failed'
  | 'password_wrong' | 'password_paused' | 'password_ok' | 'early_wait'
  | 'part_confirmed' | 'part_failed' | 'part_busy' | 'completion_ms' | 'cleanup_age' | 'cleanup_orphan' | 'cleanup_reconciled' | 'budget_drift'
  | 'report_received' | 'quarantine' | 'restore' | 'password_unpaused' | 'download_started' | 'completion_lifetime' | 'stored_gb_days'
  | 'rate_limited' | 'fallback' | 'preview_served' | 'page_view' | 'misconfigured' | 'access_denied' | 'upload_started' | 'cli_fetch';

/**
 * Counts an event in the METRICS Analytics Engine dataset: index and blob1 the event, blob2 an error code,
 * double1 a value (bytes, seconds, GB-days, a state such as the pause or a one-time link as 1 or 0, otherwise 1), and
 * where given double2 a second number (`stored_gb_days`: the downloads). Never pass addresses, IDs, keys, file names
 * or User-Agent strings. A missing binding (tests, local development) or a failed write must not fail the request.
 * Coarse dimensions from blob3 on: `page_view`'s (see pageView() in src/stats.ts), and a transfer's kind of client and
 * options (docs/METRICS.md); Analytics Engine takes at most 20 blobs of together 16 KB per data point.
 */
export function metric(env: Pick<Env, 'METRICS'>, event: MetricEvent, code = '', value = 1, dimensions: string[] = [], second?: number) {
  try { env.METRICS.writeDataPoint({ indexes: [event], blobs: [event, code, ...dimensions], doubles: second === undefined ? [value] : [value, second] }); }
  catch { /* metrics are best effort */ }
}

/** The one Budget object that admits every upload; any other name would be an empty Budget enforcing nothing. */
export const budget = (env: Pick<Env, 'BUDGET'>) => env.BUDGET.getByName('admission-v1');

export const base64url = (bytes: Uint8Array) => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
/** The bytes of canonical b64url (no padding, no other characters, zero trailing bits; docs/E2EE.md notation), or null. */
export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return base64url(bytes) === text ? bytes : null;
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The resume token derived from an upload's management key. It continues, completes or aborts the upload
 * but can't delete the file or change its expiry, so the CLI prints it instead of the key (unless --manage).
 */
export async function resumeToken(key: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fyl-resume:' + key))));
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}

// Worker secrets (wrangler secret put) and the shortest value each takes; a shorter one counts as missing. A short
// NETWORK_HASH_KEY still hashes (it only pseudonymises networks), but readiness reports it as missing. MONITOR_TOKEN
// (optional) opens /api/admin/ready only, for the hourly monitor.
const SECRETS = { NETWORK_HASH_KEY: 32, GRANT_SIGNING_KEY: 32, GRANT_SIGNING_KEY_PREVIOUS: 32, ADMIN_TOKEN: 32, MONITOR_TOKEN: 32 };
type SecretName = keyof typeof SECRETS;
declare global {
  interface Env { GRANT_SIGNING_KEY?: string; GRANT_SIGNING_KEY_PREVIOUS?: string; GRANT_SIGNING_KEY_ROTATED_AT?: string }
  namespace Cloudflare { interface Env { GRANT_SIGNING_KEY?: string; GRANT_SIGNING_KEY_PREVIOUS?: string; GRANT_SIGNING_KEY_ROTATED_AT?: string } }
}

/** A secret's value, or null while it is missing or too short. */
export function configured(env: Partial<Record<SecretName, string>>, name: SecretName): string | null {
  const value = env[name];
  return typeof value === 'string' && value.length >= SECRETS[name] ? value : null;
}

/** Without a secret the request is refused (503 `misconfigured`) instead of falling back to anything; only the name is logged. */
function misconfigured(name: SecretName) {
  console.error(JSON.stringify({ event: 'misconfigured', missing: name }));
  return new ApiError(503, 'This service is not configured completely. Please try again later.', 'misconfigured');
}

/** A secret the request can't go on without (see misconfigured()). */
export function secret(env: Partial<Record<SecretName, string>>, name: SecretName): string {
  const value = configured(env, name);
  if (value === null) throw misconfigured(name);
  return value;
}

/**
 * Hash for values derived from a client address (per-network budgets, one-time download sessions, password
 * tries, reports). Keyed with the NETWORK_HASH_KEY secret, stored hashes can't be reversed by hashing every
 * IPv4 address; without the secret there is no hash and the request is refused.
 */
export async function networkHash(key: string | undefined, value: string): Promise<string> {
  if (!key) throw misconfigured('NETWORK_HASH_KEY');
  return hex(await hmac(key, value));
}

/**
 * Signature for values only the Worker may issue (download grants, password fingerprints), keyed with the
 * GRANT_SIGNING_KEY secret (see secret()); there is no fallback key. Callers prefix `value` with its purpose,
 * so one signature can never pass for another.
 */
export async function sign(key: string, value: string): Promise<string> {
  if (!key) throw new Error('sign() needs a key.');
  return base64url(new Uint8Array(await hmac(key, value)));
}

/**
 * 6 to 200 code points, none of them controls (or lone surrogates, which UTF-8 can't encode), all counted and
 * checked in NFC like passwordHash() hashes them: a decomposed (NFD) spelling of a valid password is valid too,
 * and a character NFC expands (U+0958 becomes two) counts twice. tests/vectors/passwords.json pins the rule.
 */
export function validPassword(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normal = value.normalize('NFC'), length = [...normal].length;
  return length >= 6 && length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(normal);
}

/** PBKDF2-HMAC-SHA-256 (32 bytes, hex) of a download password; NFC, so every client's input of the same text matches. */
export async function passwordHash(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations }, key, 256));
}

/** What a protected transfer stores of its password: a random salt and the PBKDF2 hash, never the password. */
export async function passwordRecord(password: string) {
  const pwSalt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return { pwSalt, pwHash: await passwordHash(password, pwSalt, PASSWORD_ITERATIONS), pwIter: PASSWORD_ITERATIONS };
}

export function secretMatches(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  return left.length === right.length && crypto.subtle.timingSafeEqual(encoder.encode(left), encoder.encode(right));
}

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{43,64}$/.test(value);
}

/**
 * The network a client address belongs to, for rate limits, admission caps and one-time download
 * sessions: the IPv4 address itself, or the /64 prefix of an IPv6 address. A single IPv6 subscriber
 * controls a whole /64 (and privacy extensions rotate addresses inside it), so per-address keys would
 * neither limit nor recognise them. With `bits` 56 it is the subscriber instead: a line is usually delegated
 * a /56, so the budgets, password tries and report limits count its 256 /64s as one network, as one IPv4 address.
 */
export function networkOf(ip: string, bits: 64 | 56 = 64): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const parts = ip.split('::');
  if (parts.length > 2) return ip;
  const [head, tail] = parts;
  const groups = head ? head.split(':') : [];
  const rest = tail === undefined ? [] : tail ? tail.split(':') : [];
  if (tail !== undefined && groups.length + rest.length > 7) return ip;
  const expanded = tail === undefined ? groups : [...groups, ...Array<string>(8 - groups.length - rest.length).fill('0'), ...rest];
  if (expanded.length !== 8 || !expanded.every(group => /^[0-9a-fA-F]{1,4}$/.test(group))) return ip;
  const prefix = expanded.slice(0, 4).map(group => group.toLowerCase().padStart(4, '0'));
  if (bits === 56) prefix[3] = prefix[3].slice(0, 2) + '00';
  return prefix.join(':') + '::/' + bits;
}

/** The single byte range a `Range` header asks for in a file of `size` bytes; 416 for anything else. */
export function rangeOf(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ApiError(416, 'Use a single valid byte range.');
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    throw new ApiError(416, 'This byte range is outside the file.');
  return { offset: start, length: end - start + 1 };
}

export function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value);
}

export function validExpiry(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 300 && Number(value) <= 604800;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body of a request in `type`, refused as soon as it grows past `limit` bytes. */
export async function readBody(request: Request, type: string, limit: number): Promise<Uint8Array> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith(type)) throw new ApiError(415, `Use ${type}.`);
  if (!request.body) throw new ApiError(400, 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, 'Request body is too large.'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJSON(request: Request, limit = 65536): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, 'application/json', limit);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isObject(parsed)) throw new Error('object required');
    return parsed;
  } catch { throw new ApiError(400, 'Use a valid JSON object.'); }
}

export function json(value: unknown, status = 200): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (status === 429 || status === 503) headers['Retry-After'] = '5';
  return Response.json(value, { status, headers });
}

export interface InitMetadata {
  /** Raw: the file's name. E2EE: the generic `fyl-<ID[0:8]>.age`, used only for Content-Disposition (docs/E2EE.md §4.4). */
  name: string;
  /** Raw: the file's size. E2EE: the size C of the stored age file. */
  size: number;
  expiresIn: number;
  once: boolean;
  fingerprint: string;
  /**
   * `e2ee` for an end-to-end encrypted transfer, with its `head` and `meta` (b64url, as the sender gave them); raw
   * transfers have none of the three. A value this server doesn't know (from a later version) is refused (knownMode()).
   */
  mode?: string;
  head?: string;
  meta?: string;
  /** A protected transfer's download password (see passwordRecord); unprotected ones have none of these. */
  pwSalt?: string;
  pwHash?: string;
  pwIter?: number;
  /**
   * The kind of client that started the upload (clientOf() in src/index.ts: `browser`, `cli`, `curl`, `wget`, `other`,
   * or `own` for fyl's own tools), for statistics only; never part of the fingerprint, and cleanup drops it.
   */
  client?: string;
}

type TransferStatus = 'creating' | 'uploading' | 'completing' | 'ready' | 'consumed' | 'deleted' | 'removed' | 'expired' | 'aborted' | 'failed';
export interface TransferRecord extends InitMetadata {
  id: string;
  keyHash: string;
  /** Digest of the resume token; absent only on a takedown placeholder (see Transfer.access). */
  resumeHash?: string;
  objectKey: string;
  uploadId: string;
  createdAt: number;
  expiresAt: number;
  uploadDeadline: number;
  status: TransferStatus;
  operation: string;
  operationAt: number;
  completionHash?: string;
  completedAt?: number;
  downloads: number;
  clean: boolean;
  purgeAt?: number;
  session?: DownloadSession;
  /**
   * The end of a pause of the whole transfer (PASSWORD_TRANSFER_TRIES); wrong tries per network are in the Transfer's
   * `tries` table.
   */
  pwPausedUntil?: number;
  /**
   * R2 part numbers per part: part n writes to (n-1)*slots+1 … n*slots, each admitted attempt to its own. Every upload
   * has them; a takedown placeholder, which is never uploaded to, has none.
   */
  slots?: number;
  /** When cleanup became due (for the cleanup_age metric) and its failed tries so far, which set the retry delay. */
  cleanupDue?: number;
  cleanupTries?: number;
  /** After cleanup: when to check for an object or upload a racing R2 completion left, and that upload's id. */
  verifyAt?: number;
  verifyUpload?: string;
  /** Set while the operator reviews a report about the file: nobody can download it, the sender can still delete it. */
  quarantine?: { at: number; note: string };
}
/**
 * `open` counts the session's responses still streaming. `guesser` is the network the holder's password tries count
 * for (its /56, see networkOf()), and `pausedUntil` the end of the latest pause of that network (Transfer.hold()),
 * absent until one held the session.
 */
interface DownloadSession { network: string; startedAt: number; lastAt: number; open: number; guesser: string; pausedUntil?: number }
/**
 * A session closes once no response has streamed for DOWNLOAD_IDLE_MS, and DOWNLOAD_SESSION_MAX_MS after it opened at the
 * latest. A password pause that refused its holder doesn't count as idle time: the holder couldn't come back during it,
 * so the idle time runs from the pause's end when that is later than the last response's.
 */
export const sessionDeadline = (session: DownloadSession) => {
  const cap = session.startedAt + DOWNLOAD_SESSION_MAX_MS;
  return session.open > 0 ? cap : Math.min(Math.max(session.lastAt, session.pausedUntil || 0) + DOWNLOAD_IDLE_MS, cap);
};

/** A download password's state: `error` is null when the try was right, or before anyone tried. */
export interface Lock { error: 'wrong' | 'paused' | null; triesLeft: number; pausedUntil: number | null }
/** What the download page may show of a transfer: a protected file's name only once its password `unlocked` it. */
export interface PageView extends Lock {
  status: 'ready' | 'uploading'; name: string | null; size: number; once: boolean; protected: boolean; unlocked: boolean;
  expiresAt: number | null; received: number | null; updatedAt: number | null;
  /** `raw` or `e2ee`; an encrypted transfer's `head` and `meta` only where a raw file's name would show (unprotected, or unlocked). */
  mode: string; head: string | null; meta: string | null;
}

/** What the operator sees of a transfer (the name included); `exists` is false for an id nothing was stored for. */
export interface OperatorView {
  id: string; exists: boolean; status: TransferStatus | null; name: string | null; size: number | null; createdAt: number | null; mode: string | null;
  expiresAt: number | null; once: boolean | null; protected: boolean | null; quarantine: { at: number; note: string } | null; clean: boolean | null;
}
/** States in which a transfer's link works or will once its upload completes (an upload past its window counts as aborted). */
const LIVE_STATES: (TransferStatus | null)[] = ['creating', 'uploading', 'completing', 'ready'];
/** How a report about a transfer ends once the transfer is gone: taken down, or closed any other way (`expired`). */
export const closedOutcome = (view: OperatorView) => view.status === 'removed' ? 'removed'
  : view.exists && !view.clean && LIVE_STATES.includes(view.status) ? null : 'expired';

/** The download link: a protected transfer's has no name segment, so the link never gives the name away. */
export const linkOf = (base: string, id: string, name: string | null) => `${base}/d/${id}` + (name === null ? '' : '/' + encodeURIComponent(name));

/**
 * A transfer's canonical link: an unprotected raw file's names it, a protected or encrypted one's is `/d/ID` (an
 * encrypted transfer's sender appends the key itself, docs/E2EE.md §2.2).
 */
export const canonicalLink = (base: string, record: TransferRecord) => linkOf(base, record.id, record.pwHash || modeOf(record) !== 'raw' ? null : record.name);

/**
 * The transfer as the API shows it. Only the `owner` (management key or upload capability) or a request with the right
 * password sees a protected raw file's name; an encrypted transfer's name is in its `meta`, never here.
 */
export function publicRecord(record: TransferRecord, base: string, owner: boolean) {
  const secret = Boolean(record.pwHash), raw = modeOf(record) === 'raw';
  return {
    id: record.id, name: !raw || (secret && !owner) ? null : record.name, size: record.size, createdAt: record.completedAt || record.createdAt,
    expiresAt: record.expiresAt, minutes: record.expiresIn / 60, once: record.once,
    downloads: record.downloads, state: record.status, protected: secret, mode: modeOf(record),
    url: canonicalLink(base, record),
  };
}

/** An encrypted transfer's `head` and `meta` while its record keeps them (cleanup drops both), or null. */
export const sealedOf = (record: TransferRecord) => modeOf(record) === 'e2ee' && record.head && record.meta ? { head: record.head, meta: record.meta } : null;
