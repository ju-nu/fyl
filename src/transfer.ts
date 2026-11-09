import { DurableObject } from 'cloudflare:workers';
import {
  ApiError, guarded, unwrap, budget, digest, resumeToken, secretMatches, rangeOf, PART_BYTES, UPLOAD_TTL_MS, TOMBSTONE_TTL_MS,
  PASSWORD_TRIES, PASSWORD_PAUSE_MS, PASSWORD_TRANSFER_TRIES, ATTEMPT_LEASE_MS, sessionDeadline, publicRecord, passwordHash,
  validPassword, metric, closedOutcome, previewType, PREVIEW_BYTES, modeOf, knownMode, sealedOf, canonicalLink, base64url, HEAD_BYTES,
  type InitMetadata, type TransferRecord, type Lock, type PageView, type OperatorView,
} from './shared';

/** Attempts per part that were admitted to R2; refused ones don't count. Resumed 50 GB uploads need room. */
const PART_ATTEMPTS = 20;
/** R2 allows part numbers 1 to 10,000; a part gets up to 9 of them (a 50 GB file has 1,024 parts). */
const R2_PARTS = 10000, MAX_SLOTS = 9;
/** Cleanup retries after a failure: 1, 5, 15 minutes, then hourly. */
const CLEANUP_RETRY_MS = [60000, 300000, 900000, 3600000];
/** An R2 completion can finish after a cleanup it raced: an hour later the object and upload are checked once more. */
const VERIFY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * One row per part with an admitted attempt, so a part operation writes one small row instead of the whole
 * transfer: `ticket` is the latest admitted attempt's (`active` until it settles) and `attempts` counts them;
 * `etag`, `slot` (its R2 part number) and `seq` (its admission number) are the confirmed attempt's, which finished
 * at `finished` (for the progress recipients see). The table exists while the transfer isn't clean; cleanup drops it.
 */
const PARTS_TABLE = 'CREATE TABLE IF NOT EXISTS parts (number INTEGER PRIMARY KEY, size INTEGER NOT NULL, etag TEXT, ticket TEXT NOT NULL, attempts INTEGER NOT NULL, active INTEGER NOT NULL, finished INTEGER, slot INTEGER, seq INTEGER)';
type Part = { number: number; size: number; etag: string | null; ticket: string; attempts: number; active: number; finished: number | null; slot: number | null; seq: number | null };
/**
 * Attempts the Worker hasn't settled yet (reported R2's result), each holding its own R2 part number `slot`, so a
 * late attempt can never overwrite a confirmed part. `seq` is 0 while the Budget decides, then its admission number.
 * One past its lease stays until its slot is handed out again or its late report is refused (see slot()).
 */
const ATTEMPTS_TABLE = 'CREATE TABLE IF NOT EXISTS attempts (ticket TEXT PRIMARY KEY, number INTEGER NOT NULL, slot INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL)';
type Attempt = { ticket: string; number: number; slot: number; seq: number; at: number };
/** A failed cleanup step, named for the cleanup_retry metric. */
class CleanupError extends Error { constructor(public code: string, public reason: string) { super(code); } }
const step = async <T>(code: string, work: Promise<T>) => {
  try { return await work; } catch (error) { throw new CleanupError(code, error instanceof Error ? error.name : 'unknown'); }
};
/**
 * Wrong password tries: per network (the per-transfer hash claim and unlock get) the wrong ones in a row and the end
 * of the pause PASSWORD_TRIES of them start, and the time of every wrong try from any network within the last
 * PASSWORD_PAUSE_MS, for the pause of the whole transfer. Made by the first wrong try; cleanup drops both.
 */
const TRIES_TABLES = ['CREATE TABLE IF NOT EXISTS tries (network TEXT PRIMARY KEY, fails INTEGER NOT NULL, paused_until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS wrong_tries (at INTEGER NOT NULL)'];
/**
 * An encrypted upload's pins (docs/E2EE.md §8.3): the MD5 (32 lowercase hex digits) each part must have, the first value
 * the client pinned before sending the part's body; made by the first pin, dropped with the other tables at cleanup.
 */
const PINS_TABLE = 'CREATE TABLE IF NOT EXISTS pins (number INTEGER PRIMARY KEY, md5 TEXT NOT NULL)';
const partBytes = (size: number, number: number) => Math.min(PART_BYTES, size - (number - 1) * PART_BYTES);
/** The kind of client that started a transfer, for its statistics. */
const clientKind = (record: TransferRecord) => record.client || 'unknown';
/** A refusal that only an encrypted upload gets (part_changed, part_corrupt, head_mismatch), counted as part_refused. */
const refused = (env: Env, status: number, message: string, code: string) => { metric(env, 'part_refused', code); return new ApiError(status, message, code); };
const CHANGED = 'This part differs from the one this upload pinned: the file changed. Start a new upload.';

export class Transfer extends DurableObject<Env> {
  /** Set once the record is known to be stored; its tables are created on the first write, not on reads. */
  private stored = false;

  // Probing a random ID must not materialise storage, so reads tolerate a missing table.
  private read(): TransferRecord | null {
    let row: { payload: string } | undefined;
    try { row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id=1').toArray()[0]; }
    catch (error) { if (/no such table/i.test(String(error))) return null; throw error; }
    if (!row) return null;
    this.stored = true;
    return JSON.parse(row.payload) as TransferRecord;
  }

  private save(record: TransferRecord) {
    if (!this.stored) {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS transfer (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
      if (!record.clean) { this.ctx.storage.sql.exec(PARTS_TABLE); this.ctx.storage.sql.exec(ATTEMPTS_TABLE); }
      this.stored = true;
    }
    this.ctx.storage.sql.exec('INSERT INTO transfer (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', JSON.stringify(record));
  }

  /** Drops the whole object (tables, their pages and the alarm) down to the 4 KiB of an empty one. */
  private async purge() {
    await this.ctx.storage.deleteAll();
    this.stored = false;
  }

  private part(number: number): Part | undefined {
    return this.ctx.storage.sql.exec<Part>('SELECT * FROM parts WHERE number=?', number).toArray()[0];
  }

  /** Confirmed parts in order, with the R2 part number holding each: the resume state and the completion manifest. */
  private finished() {
    return this.ctx.storage.sql.exec<{ partNumber: number; size: number; etag: string; slot: number }>(
      'SELECT number AS partNumber, size, etag, slot FROM parts WHERE etag IS NOT NULL ORDER BY number').toArray();
  }

  /** The pins of an encrypted upload by part number, in order; none before the first pin or once cleanup dropped them. */
  private pins(): { partNumber: number; md5: string }[] {
    try { return this.ctx.storage.sql.exec<{ partNumber: number; md5: string }>('SELECT number AS partNumber, md5 FROM pins ORDER BY number').toArray(); }
    catch (error) { if (/no such table/i.test(String(error))) return []; throw error; }
  }

  private pinOf(number: number): string | undefined {
    try { return this.ctx.storage.sql.exec<{ md5: string }>('SELECT md5 FROM pins WHERE number=?', number).toArray()[0]?.md5; }
    catch (error) { if (/no such table/i.test(String(error))) return undefined; throw error; }
  }

  /** An attempt not yet settled; none once cleanup dropped the table. */
  private unsettled(ticket: string): Attempt | undefined {
    try { return this.ctx.storage.sql.exec<Attempt>('SELECT * FROM attempts WHERE ticket=?', ticket).toArray()[0]; }
    catch (error) { if (/no such table/i.test(String(error))) return undefined; throw error; }
  }

  /** Settles an attempt whose bytes are not (or no longer) part of the upload: frees its slot and its reserved bytes. */
  private async drop(record: TransferRecord, attempt: Attempt) {
    if (record.clean) return; // cleanup dropped the table and released every reservation
    this.ctx.storage.sql.exec('DELETE FROM attempts WHERE ticket=?', attempt.ticket);
    this.ctx.storage.sql.exec('UPDATE parts SET active=0 WHERE number=? AND ticket=?', attempt.number, attempt.ticket);
    unwrap(await budget(this.env).releasePart(record.id, attempt.number, attempt.slot, attempt.ticket));
  }

  /** drop() where a failure must not change the answer: the attempt's lease ends it instead (counted as a fallback). */
  private dropLater(record: TransferRecord, attempt: Attempt) {
    return this.drop(record, attempt).catch(() => metric(this.env, 'fallback', 'part_release'));
  }

  /**
   * The R2 part number for a new attempt at part `number`: the lowest of its slots that holds neither the confirmed
   * attempt nor an unsettled one, or 503 part_busy. An attempt past its lease no longer holds its slot, but its write
   * may still be streaming into it (a request has no time limit), so such a slot is handed out only once every other
   * one is taken: a late write can't replace a newer confirmed part unless the part used all its slots.
   */
  private slot(record: TransferRecord, number: number) {
    // Every upload has its slots (init()); a record without them (a takedown placeholder) is never uploaded to.
    const slots = record.slots as number, sql = this.ctx.storage.sql, lease = Date.now() - ATTEMPT_LEASE_MS;
    // An attempt whose lease ended before the Budget admitted it never got its slot: nothing of it can arrive.
    sql.exec('DELETE FROM attempts WHERE number=? AND seq=0 AND at<=?', number, lease);
    const held = sql.exec<{ slot: number; stale: number }>(
      'SELECT slot, at<=? AS stale FROM attempts WHERE number=? UNION ALL SELECT slot, 0 FROM parts WHERE number=? AND slot IS NOT NULL', lease, number, number).toArray();
    const taken = new Set(held.filter(row => !row.stale).map(row => row.slot)), stale = new Set(held.filter(row => row.stale).map(row => row.slot));
    for (const reuse of [false, true]) {
      for (let slot = (number - 1) * slots + 1; slot <= number * slots; slot++) {
        if (taken.has(slot) || stale.has(slot) !== reuse) continue;
        if (reuse) sql.exec('DELETE FROM attempts WHERE number=? AND slot=?', number, slot);
        return slot;
      }
    }
    metric(this.env, 'part_busy');
    throw new ApiError(503, 'This part is still being uploaded. Please retry shortly.', 'part_busy');
  }

  private required(): TransferRecord {
    const record = this.read();
    if (!record) throw new ApiError(404, 'Transfer not found.', 'not_found');
    return record;
  }

  private async authorized(key: string): Promise<TransferRecord> {
    return (await this.access(key, false)).record;
  }

  /**
   * The record if `key` is its management key or, with `resume` (the upload routes), its resume token;
   * `owner` is true for the key only. A record without resumeHash (a takedown of an id nothing was stored for)
   * takes the key only.
   */
  private async access(key: string, resume: boolean) {
    const hash = await digest(key);
    const record = this.required();
    const owner = secretMatches(record.keyHash, hash);
    if (!owner && !(resume && record.resumeHash && secretMatches(record.resumeHash, hash)))
      throw new ApiError(403, 'This private key is not valid.', 'denied');
    return { record, owner };
  }

  /** Next time the alarm must run for a ready transfer: expiry, or the end of an open download session. */
  private nextDeadline(record: TransferRecord) {
    return record.session ? Math.min(record.expiresAt, sessionDeadline(record.session)) : record.expiresAt;
  }

  /** Closes a ready transfer whose lifetime or download session ran out before its alarm did; true if it did now. */
  private lapse(record: TransferRecord) {
    const now = Date.now();
    if (record.status !== 'ready' || (now < record.expiresAt && !(record.session && now >= sessionDeadline(record.session)))) return false;
    if (now >= record.expiresAt) this.close(record, 'expired', record.expiresAt);
    else this.close(record, 'consumed', sessionDeadline(record.session as NonNullable<TransferRecord['session']>));
    return true;
  }

  /** Closes the transfer for good; `due` is when that became due, for the cleanup_age metric. Cleanup follows. */
  private close(record: TransferRecord, status: TransferRecord['status'], due = Date.now()) {
    record.status = status;
    if (!record.clean) record.cleanupDue ??= due;
    this.save(record);
  }

  /**
   * A link that works now, or 410 with the reason: expired, consumed, deleted or removed, or `aborted` for an upload
   * that never completed (aborted, failed, or past its window before its alarm marked it), so a client can tell it apart.
   */
  private assertAvailable(record: TransferRecord) {
    // The alarm first: a cleanup cut short with the request is still retried.
    if (this.lapse(record)) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60000).then(() => this.cleanup()));
    if (record.status !== 'ready') {
      // An upload still running isn't gone: the sender may change it once it has completed.
      if (this.pending(record)) throw new ApiError(409, 'This upload is still running.', 'upload_running');
      const code = ['expired', 'consumed', 'deleted', 'removed'].includes(record.status) ? record.status : 'aborted';
      throw new ApiError(410, 'This file is no longer available.', code);
    }
  }

  /**
   * A report under review closes every way to the file: downloads, grants, the page and the info. The sender's
   * deletion, abort and upload go on, and so do expiry and cleanup; a closed transfer keeps its own reason.
   */
  private assertClear(record: TransferRecord) {
    if (record.quarantine) throw new ApiError(403, 'This file is unavailable while a report about it is reviewed.', 'quarantined');
  }

  /**
   * A transfer of a mode this server doesn't know (written by a later version): 503 unsupported_mode, so nothing of it is
   * served, opened or counted as if it were raw (docs/E2EE.md §12.2). A rollback to this version keeps such files safe.
   */
  private assertKnown(record: TransferRecord) {
    if (!knownMode(record)) throw new ApiError(503, 'This file needs a newer fyl.at.', 'unsupported_mode');
  }

  /** Still being uploaded (or completed) within its upload window: the link already works, the file is not there yet. */
  private pending(record: TransferRecord) {
    return ['creating', 'uploading', 'completing'].includes(record.status) && Date.now() < record.uploadDeadline;
  }

  /** Bytes in finished parts, and when the last of them finished (or the upload started). */
  private progress(record: TransferRecord) {
    const row = this.ctx.storage.sql.exec<{ bytes: number; at: number | null }>(
      'SELECT COALESCE(SUM(size),0) AS bytes, MAX(finished) AS at FROM parts WHERE etag IS NOT NULL').one();
    return { received: row.bytes, updatedAt: row.at || record.createdAt };
  }

  /** Bytes R2 holds for the transfer: the file, or the finished parts of an upload that never completed (none without their table). */
  private held(record: TransferRecord) {
    if (record.completedAt) return record.size;
    try { return this.progress(record).received; }
    catch (error) { if (/no such table/i.test(String(error))) return 0; throw error; }
  }

  /** A network's wrong tries in a row and the end of its pause, if it tried; reads tolerate the table's absence. */
  private tries(network: string) {
    try { return this.ctx.storage.sql.exec<{ fails: number; paused_until: number }>('SELECT fails, paused_until FROM tries WHERE network=?', network).toArray()[0]; }
    catch (error) { if (/no such table/i.test(String(error))) return undefined; throw error; }
  }

  /**
   * For the sender: the end of the whole transfer's password pause, how many networks are paused now and when the last
   * of their pauses ends (each null if none runs). Every pause is over at the later of the two ends.
   */
  private pauses(record: TransferRecord) {
    const now = Date.now();
    let paused = { networks: 0, until: null as number | null };
    try { paused = this.ctx.storage.sql.exec<{ networks: number; until: number | null }>('SELECT COUNT(*) AS networks, MAX(paused_until) AS until FROM tries WHERE paused_until>?', now).one(); }
    catch (error) { if (!/no such table/i.test(String(error))) throw error; }
    return { until: (record.pwPausedUntil || 0) > now ? record.pwPausedUntil as number : null, networks: paused.networks, networksUntil: paused.until };
  }

  /**
   * The password state for `network` when it didn't try yet: its tries left, or its pause or the whole transfer's,
   * whichever ends later. The `holder` of a one-time session (see holds()) is spared the whole transfer's pause.
   */
  private lock(record: TransferRecord, network = '', holder = false): Lock {
    const row = this.tries(network), until = Math.max(row?.paused_until || 0, holder ? 0 : record.pwPausedUntil || 0);
    const pausedUntil = until > Date.now() ? until : null;
    return { error: pausedUntil ? 'paused' : null, triesLeft: PASSWORD_TRIES - (row?.fails || 0), pausedUntil };
  }

  /**
   * Whether `network` (the per-transfer hash a claim gets) holds the one-time download session: it gave the password
   * (or a grant) when the session opened. Other networks' wrong tries pause the whole transfer for as long as the
   * session may idle (PASSWORD_PAUSE_MS equals DOWNLOAD_IDLE_MS), so a pause that locked the holder out would let its
   * session idle out behind the pause and close the link as consumed, the file deleted, for a recipient who never
   * guessed wrong. The holder's own wrong tries still count and pause its network as before (hold() keeps the session).
   */
  private holds(record: TransferRecord, network: string) {
    return Boolean(record.once && record.session && secretMatches(record.session.network, network));
  }

  /**
   * Holds an open one-time session past a pause of its holder's own network, the one pause that refuses the holder (its
   * own typos, or 5 wrong tries from another address of its /56 or behind its NAT): the session's idle time then runs
   * from the pause's end (sessionDeadline(), within the session's cap). The pause lasts as long as the session may idle,
   * so one that began right after the holder's last response would otherwise close the link as consumed, the file
   * deleted, before the holder could try again. The whole transfer's pause holds nothing: it refuses the holder on no
   * route (holds()), and holding through it would let anyone without the password keep an abandoned session's file
   * stored up to the cap. It only ever lengthens: lifting a pause early leaves it. True if it changed the record.
   */
  private hold(record: TransferRecord) {
    const { session } = record;
    if (!record.once || !session) return false;
    const until = this.tries(session.guesser)?.paused_until || 0;
    if (until <= Math.max(Date.now(), session.pausedUntil || 0)) return false;
    session.pausedUntil = until;
    return true;
  }

  /**
   * Tries the password of a ready, protected transfer from `network`. PASSWORD_TRIES wrong ones in a row pause that
   * network for PASSWORD_PAUSE_MS, and PASSWORD_TRANSFER_TRIES wrong ones from any networks within as long pause
   * the whole transfer, so one network can't lock recipients on others out, and many can't guess unhindered. A
   * pause refuses every try, right or wrong; a network's count starts over after its pause or a right password.
   * With `uploading`, a transfer still being uploaded can be tried too (the info route, docs/E2EE.md §12.2). The
   * `holder` of the one-time session (holds()) is refused only by its own network's pause, never the transfer's.
   * Callers read the record again afterwards: this one may have changed it.
   */
  private async attempt(password: string, network: string, uploading = false, holder = false): Promise<Lock> {
    const before = this.required();
    if (this.lock(before, network, holder).error) return this.lock(before, network, holder);
    const hash = validPassword(password) ? await passwordHash(password, before.pwSalt as string, before.pwIter as number) : '';
    // Other requests ran while it hashed (more tries, a deletion, a quarantine): go on with the record as it is now.
    const record = this.required();
    if (!(uploading && this.pending(record))) this.assertAvailable(record);
    this.assertClear(record);
    const lock = this.lock(record, network, holder);
    if (lock.error) return lock;
    if (hash && secretMatches(hash, record.pwHash as string)) {
      if (this.tries(network)) this.ctx.storage.sql.exec('DELETE FROM tries WHERE network=?', network);
      metric(this.env, 'password_ok');
      return { error: null, triesLeft: PASSWORD_TRIES, pausedUntil: null };
    }
    metric(this.env, 'password_wrong');
    return this.ctx.storage.transactionSync((): Lock => {
      const sql = this.ctx.storage.sql, now = Date.now();
      for (const table of TRIES_TABLES) sql.exec(table);
      // Rows of networks whose pause is over count nothing any more.
      sql.exec('DELETE FROM tries WHERE fails=0 AND paused_until<=?', now);
      const fails = (this.tries(network)?.fails || 0) + 1, paused = fails >= PASSWORD_TRIES;
      sql.exec('INSERT INTO tries (network,fails,paused_until) VALUES (?,?,?) ON CONFLICT(network) DO UPDATE SET fails=excluded.fails, paused_until=excluded.paused_until',
        network, paused ? 0 : fails, paused ? now + PASSWORD_PAUSE_MS : 0);
      if (paused) metric(this.env, 'password_paused');
      sql.exec('DELETE FROM wrong_tries WHERE at<=?', now - PASSWORD_PAUSE_MS);
      sql.exec('INSERT INTO wrong_tries (at) VALUES (?)', now);
      const transfer = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM wrong_tries').one().count >= PASSWORD_TRANSFER_TRIES;
      if (transfer) {
        record.pwPausedUntil = now + PASSWORD_PAUSE_MS;
        sql.exec('DELETE FROM wrong_tries');
        metric(this.env, 'password_paused', 'transfer');
      }
      // A pause of the one-time session holder's network holds the session open past its end (see hold()).
      if (this.hold(record) || transfer) this.save(record);
      const after = this.lock(record, network, holder);
      return after.error ? after : { ...after, error: 'wrong' };
    });
  }

  /**
   * The record if the download page may show it: still uploading, or ready and not a one-time link another
   * network is downloading, and not quarantined. Anything else throws the reason the page shows instead.
   */
  private shown(network: string) {
    const record = this.required();
    if (!this.pending(record)) {
      this.assertAvailable(record);
      if (record.once && record.session && !secretMatches(record.session.network, network))
        throw new ApiError(410, 'This one-time link is already being downloaded.', 'consumed');
    }
    this.assertClear(record);
    this.assertKnown(record);
    return record;
  }

  /**
   * What the download page shows. A protected file's name stays hidden until its password was given (`unlocked`); an
   * encrypted transfer's never shows (it is in `meta`), and its `head` and `meta` follow the rule of a raw file's name.
   */
  private view(record: TransferRecord, network = '', unlocked = false, lock = this.lock(record, network)): PageView {
    const pending = this.pending(record), secret = Boolean(record.pwHash), open = !secret || unlocked, sealed = open ? sealedOf(record) : null;
    return {
      status: pending ? 'uploading' : 'ready', name: open && modeOf(record) === 'raw' ? record.name : null,
      size: record.size, once: record.once, protected: secret, unlocked: secret && unlocked, expiresAt: pending ? null : record.expiresAt,
      ...(pending ? this.progress(record) : { received: null, updatedAt: null }), ...lock,
      mode: modeOf(record), head: sealed?.head ?? null, meta: sealed?.meta ?? null,
    };
  }

  /**
   * The download page for a link opened in a browser (or by a link-preview bot); it never counts a download.
   * `guesser` is the per-transfer hash password tries count for (an IPv6 subscriber's /56, see networkOf()).
   */
  async page(network: string, guesser: string) {
    return guarded(() => {
      const record = this.shown(network);
      return this.view(record, guesser, false, this.lock(record, guesser, this.holds(record, network)));
    });
  }

  /** The download page's password form: the page unlocked, or showing why not. */
  async unlock(password: string, network: string, guesser: string) {
    return guarded(async () => {
      const record = this.shown(network);
      if (!record.pwHash || this.pending(record)) return this.view(record, guesser);
      const lock = await this.attempt(password, guesser, false, this.holds(record, network));
      return this.view(this.shown(network), guesser, !lock.error, lock);
    });
  }

  /**
   * Starts an upload (or answers a replay of its start). `ipHash` and `liveHash` are today's and the stable hash of the
   * network starting it, for the Budget's admission (see Budget.reserve); neither is kept here.
   */
  async init(id: string, key: string, metadata: InitMetadata, ipHash: string, base: string, liveHash?: string) {
    return guarded(async () => {
      // Hash before reading: nothing may await between finding no record and saving the new one.
      const keyHash = await digest(key), resumeHash = await digest(await resumeToken(key));
      // The link works from now on; it shows "still uploading" until the upload completes. `mode` tells an encrypting
      // client that this server took the upload as encrypted (docs/E2EE.md §7 step 2).
      const started = (record: TransferRecord) => ({ uploadId: id, key, url: canonicalLink(base, record), mode: modeOf(record) });
      let record = this.read();
      if (record) {
        if (!secretMatches(record.keyHash, keyHash) || record.fingerprint !== metadata.fingerprint)
          throw new ApiError(409, 'The upload metadata does not match this session.');
        if (record.status === 'uploading' || record.status === 'ready') return started(record);
        if (record.status === 'creating' && Date.now() - record.operationAt < 120000)
          throw new ApiError(503, 'This upload is still being created.');
        if (record.status !== 'failed' && record.status !== 'creating')
          throw new ApiError(410, 'This upload session is closed.');
      } else {
        const now = Date.now();
        record = { ...metadata, id, keyHash, resumeHash, objectKey: `files/${id}`, uploadId: '', createdAt: now,
          expiresAt: 0, uploadDeadline: now + UPLOAD_TTL_MS, status: 'creating',
          operation: '', operationAt: now, downloads: 0, clean: false,
          slots: Math.min(MAX_SLOTS, Math.floor(R2_PARTS / Math.ceil(metadata.size / PART_BYTES))) };
      }
      const operation = crypto.randomUUID();
      record.status = 'creating'; record.operation = operation; record.operationAt = Date.now();
      this.save(record);
      await this.ctx.storage.setAlarm(record.uploadDeadline);
      try {
        unwrap(await budget(this.env).reserve(id, record.size, ipHash, liveHash ?? null));
        const upload = await this.env.FILES.createMultipartUpload(record.objectKey, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
        const current = this.required();
        if (current.operation !== operation || current.status !== 'creating') {
          await upload.abort(); throw new ApiError(409, 'This upload session changed.');
        }
        current.uploadId = upload.uploadId; current.status = 'uploading';
        this.save(current);
        // Once per admitted upload (a replay returns above), by the kind of client that started it.
        metric(this.env, 'upload_started', clientKind(current));
        return started(current);
      } catch (error) {
        const current = this.required();
        if (current.operation === operation && current.status === 'creating') {
          current.status = 'failed'; this.save(current);
        }
        throw error;
      }
    });
  }

  /**
   * Admits an attempt at part `number`: a ticket and its own R2 part number (`slot`), with `bytes` reserved in the
   * Budget for `network`, today's hash of the network sending them. The Worker reports R2's result with finishPart
   * or failPart. Only an admitted attempt counts: a refused one never reached R2, so it doesn't count against the
   * limit (or a pause or full budget would make the upload unresumable) and leaves the part as it was.
   * An encrypted upload's part must come with `md5` (its Content-MD5, as hex; null when missing or malformed) equal
   * to the part's pin (docs/E2EE.md §8.3): otherwise it is refused here, before R2 and before it counts.
   */
  async reservePart(key: string, number: number, bytes: number, network: string, md5: string | null) {
    return guarded(async () => {
      const { record } = await this.access(key, true);
      if (record.status !== 'uploading' || Date.now() >= record.uploadDeadline)
        throw new ApiError(410, 'This upload session is closed.');
      if (!Number.isInteger(number) || number < 1 || number > Math.ceil(record.size / PART_BYTES) || partBytes(record.size, number) !== bytes)
        throw new ApiError(400, 'Part number or byte length does not match the file.');
      if (modeOf(record) === 'e2ee') {
        const pinned = this.pinOf(number);
        if (!md5 || !pinned) throw new ApiError(400, 'Pin an encrypted part, then send it with a Content-MD5 header equal to its pin.');
        if (md5 !== pinned) throw refused(this.env, 409, CHANGED, 'part_changed');
      }
      // Attempts waiting for the Budget count too, so concurrent ones never pass the limit together.
      const waiting = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM attempts WHERE number=? AND seq=0', number).one().count;
      if ((this.part(number)?.attempts || 0) + waiting >= PART_ATTEMPTS) {
        metric(this.env, 'part_limit'); throw new ApiError(409, 'This part has reached its retry limit.', 'part_limit');
      }
      // The slot is taken before the Budget is asked, so a concurrent attempt gets another one.
      const slot = this.slot(record, number), ticket = crypto.randomUUID();
      this.ctx.storage.sql.exec('INSERT INTO attempts (ticket,number,slot,seq,at) VALUES (?,?,?,0,?)', ticket, number, slot, Date.now());
      try { unwrap(await budget(this.env).reservePart(record.id, number, slot, ticket, bytes, network)); }
      catch (error) {
        if (!this.required().clean) this.ctx.storage.sql.exec('DELETE FROM attempts WHERE ticket=?', ticket);
        metric(this.env, 'part_refused', error instanceof ApiError ? error.code : 'temporarily_unavailable');
        throw error;
      }
      const current = this.required();
      if (current.status !== 'uploading') {
        // Closed or completing while the Budget answered: R2 never gets these bytes.
        await this.dropLater(current, { ticket, number, slot, seq: 0, at: 0 });
        throw new ApiError(410, 'This upload session is closed.');
      }
      const seq = (this.part(number)?.attempts || 0) + 1;
      this.ctx.storage.sql.exec('UPDATE attempts SET seq=? WHERE ticket=?', seq, ticket);
      this.ctx.storage.sql.exec(`INSERT INTO parts (number,size,ticket,attempts,active) VALUES (?,?,?,1,1)
        ON CONFLICT(number) DO UPDATE SET ticket=excluded.ticket, attempts=attempts+1, active=1`, number, bytes, ticket);
      return { objectKey: current.objectKey, uploadId: current.uploadId, ticket, slot };
    });
  }

  /**
   * Pins the MD5 of part `number` of an encrypted upload before its body is sent (docs/E2EE.md §8.3): the first value
   * stays, the same one again is fine, another is 409 part_changed (the file changed). Only while the upload runs.
   */
  async pin(key: string, number: number, md5: string) {
    return guarded(async () => {
      const { record } = await this.access(key, true);
      if (modeOf(record) !== 'e2ee') throw new ApiError(400, 'Only encrypted uploads pin their parts.');
      if (record.status !== 'uploading' || Date.now() >= record.uploadDeadline)
        throw new ApiError(410, 'This upload session is closed.');
      if (!Number.isInteger(number) || number < 1 || number > Math.ceil(record.size / PART_BYTES))
        throw new ApiError(400, 'Part number does not match the file.');
      this.ctx.storage.sql.exec(PINS_TABLE);
      this.ctx.storage.sql.exec('INSERT INTO pins (number,md5) VALUES (?,?) ON CONFLICT(number) DO NOTHING', number, md5);
      if (this.pinOf(number) !== md5) throw refused(this.env, 409, CHANGED, 'part_changed');
      return { partNumber: number, md5 };
    });
  }

  /**
   * State for resuming an upload: finished parts (with their R2 ETag, the part's MD5) and the session.
   * `access` says what authorised it: the management key (`owner`) or the resume token (`resume`). An encrypted
   * upload adds its `head`, `meta` and every pin, confirmed or not (docs/E2EE.md §8.4); its name is in `meta`. With
   * `base`, the canonical link too, which a resuming encrypting client checks like init's (§2.2).
   */
  async uploadStatus(key: string, base?: string) {
    return guarded(async () => {
      const { record, owner } = await this.access(key, true), mode = modeOf(record);
      return {
        status: record.status, access: owner ? 'owner' : 'resume', name: mode === 'raw' ? record.name : null, size: record.size, partSize: PART_BYTES,
        expiresIn: record.expiresIn, once: record.once, uploadDeadline: record.uploadDeadline,
        parts: record.clean ? [] : this.finished().map(({ partNumber, size, etag }) => ({ partNumber, size, etag })), mode,
        ...(base ? { url: canonicalLink(base, record) } : {}), ...(mode === 'e2ee' ? { e2ee: sealedOf(record), pins: this.pins() } : {}),
      };
    });
  }

  /**
   * R2 stored the attempt `ticket` with `etag`. It becomes the part's confirmed attempt unless a newer one already
   * is: a late older attempt wrote to a slot of its own and changes nothing (409, or its ETag if the bytes were the
   * same). The Budget counts the part's bytes once, before the part is confirmed here.
   */
  async finishPart(key: string, number: number, ticket: string, etag: string) {
    return guarded(async () => {
      const { record } = await this.access(key, true), attempt = this.unsettled(ticket);
      if (record.status !== 'uploading') {
        if (attempt) await this.dropLater(record, attempt);
        throw new ApiError(410, 'This upload session is closed.');
      }
      if (!attempt || attempt.number !== number) {
        // Reported again (it settled already): the same answer, changing nothing.
        if (this.part(number)?.etag === etag) return { etag };
        throw new ApiError(409, 'A newer attempt replaced this part.');
      }
      // Past its lease the Budget no longer reserves the attempt's bytes: sent again, they count against the caps.
      if (attempt.at <= Date.now() - ATTEMPT_LEASE_MS) {
        await this.dropLater(record, attempt);
        throw new ApiError(503, 'This part took too long. Please send it again.', 'lease_expired');
      }
      // R2's ETag of a part is the MD5 of what it stored: for an encrypted part it must be the pin, or the bytes were
      // damaged on the way. The attempt failed (it counts; its slot and bytes are free) and the client sends the same
      // buffer again (docs/E2EE.md §8.3). ETags that aren't 32 hex digits (the local simulator's) can't be compared.
      const stored = /^"?([0-9a-f]{32})"?$/i.exec(etag)?.[1].toLowerCase();
      if (modeOf(record) === 'e2ee' && stored && stored !== this.pinOf(number)) {
        await this.dropLater(record, attempt);
        throw refused(this.env, 502, 'This part was stored damaged. Please send it again.', 'part_corrupt');
      }
      const size = partBytes(record.size, number);
      try { unwrap(await budget(this.env).confirmPart(record.id, number, attempt.slot, ticket)); }
      catch (error) { await this.dropLater(this.required(), attempt); throw error; }
      const current = this.required();
      if (current.status !== 'uploading') {
        if (!current.clean) this.ctx.storage.sql.exec('DELETE FROM attempts WHERE ticket=?', ticket);
        throw new ApiError(410, 'This upload session is closed.');
      }
      const part = this.part(number) as Part, confirmed = attempt.seq > (part.seq || 0);
      this.ctx.storage.sql.exec('DELETE FROM attempts WHERE ticket=?', ticket);
      if (confirmed) {
        this.ctx.storage.sql.exec('UPDATE parts SET etag=?, slot=?, seq=?, finished=?, active=CASE WHEN ticket=? THEN 0 ELSE active END WHERE number=?',
          etag, attempt.slot, attempt.seq, Date.now(), ticket, number);
        metric(this.env, 'part_confirmed', '', size);
        return { etag };
      }
      this.ctx.storage.sql.exec('UPDATE parts SET active=0 WHERE number=? AND ticket=?', number, ticket);
      if (part.etag === etag) return { etag };
      throw new ApiError(409, 'A newer attempt replaced this part.');
    });
  }

  /**
   * The Worker's R2 write of attempt `ticket` failed: its slot and reserved bytes are free again (it still counts as an
   * attempt). `disconnected`: the sender went away mid-part (counted as part_failed `disconnected`, not as a fault).
   */
  async failPart(key: string, number: number, ticket: string, disconnected = false) {
    return guarded(async () => {
      const { record } = await this.access(key, true), attempt = this.unsettled(ticket);
      if (!attempt || attempt.number !== number) return false;
      metric(this.env, 'part_failed', disconnected ? 'disconnected' : '', partBytes(record.size, number));
      await this.drop(record, attempt);
      return true;
    });
  }

  async complete(key: string, parts: R2UploadedPart[], base: string) {
    return guarded(async () => {
      const completionHash = await digest(JSON.stringify(parts));
      const access = await this.access(key, true), owner = access.owner ? key : undefined;
      const replay = (record: TransferRecord) => {
        this.assertAvailable(record);
        if (record.completionHash !== completionHash) throw new ApiError(409, 'Completion parts do not match.');
        return this.receipt(record, base, owner);
      };
      // An R2 call lets other requests and the alarm in (a takedown, a deletion, the deadline, another completion):
      // go on only with the record as it is now, still on this completion or finished by it.
      const fresh = () => {
        const record = this.required();
        if (record.status !== 'ready' && (record.status !== 'completing' || record.completionHash !== completionHash))
          throw new ApiError(409, 'Transfer changed during completion.');
        return record;
      };
      // An encrypted upload's object must start with the head its init gave (docs/E2EE.md §12.2), or no download could
      // pass the key check and then decrypt: such an object is deleted and the upload fails, without a receipt.
      const finalize = async (current: TransferRecord, completedAt: number) => {
        if (modeOf(current) === 'e2ee') {
          const start = await this.env.FILES.get(current.objectKey, { range: { offset: 0, length: HEAD_BYTES } });
          const head = start ? base64url(new Uint8Array(await start.arrayBuffer())) : '';
          current = fresh();
          if (current.status === 'ready') return replay(current);
          if (head !== current.head) {
            await this.env.FILES.delete(current.objectKey);
            current = fresh();
            if (current.status === 'ready') return replay(current);
            // The multipart upload became the object, which is gone: no upload is left to abort.
            current.uploadId = '';
            this.close(current, 'aborted');
            await this.ctx.storage.setAlarm(Date.now() + 60000);
            await this.cleanup();
            throw refused(this.env, 409, 'The uploaded file does not start with the header its upload began with. The upload failed.', 'head_mismatch');
          }
        }
        return await this.makeReady(current, base, completedAt, owner);
      };
      let record = access.record;
      if (record.status === 'ready') return replay(record);
      if (record.status === 'completing') {
        if (record.completionHash !== completionHash) throw new ApiError(409, 'Completion parts do not match.');
        // Recover completion after an interrupted response or persistence step.
        const object = await this.env.FILES.head(record.objectKey);
        record = fresh();
        if (record.status === 'ready') return replay(record);
        if (object && object.size === record.size) return await finalize(record, object.uploaded.getTime());
        if (Date.now() - record.operationAt < 120000) throw new ApiError(503, 'Completion is still running.');
        record.status = 'uploading'; this.save(record);
      }
      if (record.status !== 'uploading' || Date.now() >= record.uploadDeadline)
        throw new ApiError(410, 'This upload session is closed.');
      const count = Math.ceil(record.size / PART_BYTES);
      if (parts.length !== count) throw new ApiError(400, 'Every file part is required.');
      // The confirmed parts are the manifest; the request must name each of them, in order. R2 gets their slots.
      const manifest = this.finished();
      if (manifest.length !== count || parts.some((part, index) => part.partNumber !== manifest[index].partNumber || part.etag !== manifest[index].etag))
        throw new ApiError(409, 'A part is missing or its ETag does not match.');
      record.status = 'completing'; record.completionHash = completionHash; record.operationAt = Date.now();
      this.save(record);
      const { operationAt } = record;
      let object: R2Object;
      try {
        object = await this.env.FILES.resumeMultipartUpload(record.objectKey, record.uploadId).complete(manifest.map(({ slot, etag }) => ({ partNumber: slot, etag })));
        metric(this.env, 'completion_ms', '', Date.now() - operationAt);
      } catch (error) {
        // Nothing runs on after a failed completion: unless R2 did finish it, reopen the upload so the
        // client's retry completes right away instead of waiting out 'Completion is still running'.
        const stored = await this.env.FILES.head(record.objectKey).catch(() => null);
        record = this.required();
        if (record.status === 'completing' && record.operationAt === operationAt) {
          if (stored && stored.size === record.size) return await finalize(record, stored.uploaded.getTime());
          record.status = 'uploading'; this.save(record);
        }
        throw error;
      }
      const closed = this.required();
      // Closed while R2 completed it (a takedown, an abort, the deadline): its cleanup may have run before the object existed.
      if (['aborted', 'expired', 'consumed', 'deleted', 'removed'].includes(closed.status))
        await this.env.FILES.delete(closed.objectKey).catch(() => metric(this.env, 'fallback', 'orphan_delete')); // the check an hour later repeats it
      record = fresh();
      if (record.status === 'ready') return replay(record);
      if (object.size !== record.size) throw new ApiError(409, 'Uploaded file size does not match.');
      return await finalize(record, object.uploaded.getTime());
    });
  }

  private async makeReady(record: TransferRecord, base: string, completedAt: number, key?: string) {
    record.status = 'ready'; record.completedAt = completedAt;
    record.expiresAt = completedAt + record.expiresIn * 1000;
    this.save(record);
    // With the kind of client and the options chosen (password, one download); the mode (e2ee) is the code.
    metric(this.env, 'upload_completed', modeOf(record) === 'raw' ? '' : modeOf(record), record.size,
      [clientKind(record), record.pwHash ? 'password' : '', record.once ? 'once' : '']);
    metric(this.env, 'completion_lifetime', '', record.expiresIn, [clientKind(record)]);
    await this.ctx.storage.setAlarm(record.expiresAt);
    // It no longer runs for its network, and R2 kept only the parts it named. Without this (the Budget failing) the
    // network's place stays taken until UTC midnight and the copies count until the cleanup: never too little.
    await budget(this.env).uploaded(record.id).then(unwrap).catch(() => metric(this.env, 'fallback', 'budget_uploaded'));
    return this.receipt(record, base, key);
  }

  /** The management link only for a completion made with the key: the server keeps just its hash. */
  private receipt(record: TransferRecord, base: string, key?: string) {
    const receipt = { ...publicRecord(record, base, true), transferId: record.id };
    return key ? { ...receipt, managementUrl: `${base}/#manage/${record.id}/${key}`, deleteToken: key } : receipt;
  }

  /**
   * The transfer for its owner or, without a key, the public: recipients poll an upload still running for its
   * progress, and its sender sees it as well (state `uploading`), so a client can show it and delete it. The owner
   * of a protected transfer also sees its password pauses (see clearPause()). An encrypted transfer adds `e2ee`, its
   * head and meta, where a raw file's name would show, else null (docs/E2EE.md §11, §12.2): a protected one's only to its
   * owner or with its `password` (HTTP Basic), whose tries count for `guesser` as on /d/, also while it uploads; from the
   * `network` holding the one-time session they go on through a pause of the whole transfer (holds()), as on /d/. A wrong
   * or paused password returns its lock as `refused` instead. A mode this server doesn't know gets no `e2ee`.
   */
  async info(base: string, key?: string, password: string | null = null, guesser = '', network = '') {
    return guarded(async () => {
      let record = key ? await this.authorized(key) : this.required();
      if (!this.pending(record)) this.assertAvailable(record);
      this.assertClear(record);
      let unlocked = Boolean(key) || !record.pwHash;
      if (!unlocked && password !== null) {
        // `fyl download` and the encrypted page ask here before /d/, also on a rerun or a reload during a download.
        const lock = await this.attempt(password, guesser, true, this.holds(record, network));
        if (lock.error) return { refused: lock };
        record = this.required(); unlocked = true;
      }
      const mode = modeOf(record), sealed = mode === 'e2ee' ? { e2ee: unlocked ? sealedOf(record) : null } : {};
      if (this.pending(record)) {
        const { size, once, protected: secret, received, updatedAt } = this.view(record);
        if (key) return { ...publicRecord(record, base, true), state: 'uploading', expiresAt: null, received, updatedAt, owner: true, ...sealed };
        return { id: record.id, state: 'uploading', size, received, updatedAt, once, protected: secret, name: mode === 'raw' && unlocked ? record.name : null,
          expiresAt: null, mode, ...sealed };
      }
      return key ? this.ownerView(record, base) : { ...publicRecord(record, base, unlocked), owner: false, ...sealed };
    });
  }

  private ownerView(record: TransferRecord, base: string) {
    return { ...publicRecord(record, base, true), owner: true, ...(record.pwHash ? { passwordPause: this.pauses(record) } : {}),
      ...(modeOf(record) === 'e2ee' ? { e2ee: sealedOf(record) } : {}) };
  }

  /**
   * The sender lifts the password pauses at once, every network's and the whole transfer's (a recipient who mistyped,
   * or guessing that paused everyone). It tries no password and counts as none; networks not paused keep their count.
   */
  async clearPause(key: string, base: string) {
    return guarded(async () => {
      const record = await this.authorized(key);
      this.assertAvailable(record);
      this.assertClear(record);
      const { until, networks } = this.pauses(record);
      if (networks) this.ctx.storage.sql.exec('DELETE FROM tries WHERE paused_until>0');
      if (record.pwPausedUntil !== undefined) { delete record.pwPausedUntil; this.save(record); }
      if (until || networks) metric(this.env, 'password_unpaused', until ? 'transfer' : '', networks);
      return this.ownerView(record, base);
    });
  }

  /**
   * Admits a download request. One-time links open a download session for the first requesting network
   * (`network` is a per-transfer hash of the client IP). That network may resume and split the download
   * with range requests until the session goes idle; other networks are refused. HEAD never opens one.
   * A one-time GET keeps the session open until its response ends and the Worker reports it (ended()).
   * A protected file takes a grant the Worker checked (`granted`) or its `password` (HTTP Basic Auth), whose tries
   * count for `guesser` (see page()); an upload still running answers `waiting` with its progress.
   * An encrypted transfer (docs/E2EE.md §11, §12.2): a browser navigation (`ask.navigate`) gets its page whatever it asks
   * for (`page`), any other request the file only when it asks for it (`ask.explicit`: ?dl=1, a grant or Basic), and
   * `encrypted` otherwise, so link unfurlers and plain curl open nothing. A mode this server doesn't know: 503.
   */
  async claim(head: boolean, network: string, rangeHeader: string | null, password: string | null, granted: boolean, guesser: string,
              ask: { navigate: boolean; explicit: boolean }) {
    return guarded(async () => {
      let record = this.required();
      const pending = this.pending(record);
      if (!pending) this.assertAvailable(record);
      this.assertClear(record);
      this.assertKnown(record);
      const mode = modeOf(record);
      if (mode === 'e2ee' && ask.navigate) return { kind: 'page' as const };
      if (mode === 'e2ee' && !ask.explicit) return { kind: 'encrypted' as const };
      if (pending) return { kind: 'waiting' as const, size: record.size, received: this.progress(record).received };
      if (record.pwHash && !granted) {
        // The network holding the one-time session goes on through a pause of the whole transfer (see holds()).
        let lock = password === null ? null : await this.attempt(password, guesser, false, this.holds(record, network));
        // Without a password, a paused network hears that it is paused (429) rather than asked for a password it can't
        // try yet. That costs no try, so an open download page can ask it to see when the sender lifted the pause.
        if (!lock) { const current = this.lock(record, guesser, this.holds(record, network)); if (current.error) lock = current; }
        if (!lock || lock.error) return { kind: 'locked' as const, lock, mode };
        record = this.required();
      }
      // A range that can't be served is refused before it counts a download or opens a session.
      const range = rangeHeader ? rangeOf(rangeHeader, record.size) : undefined;
      if (!head) {
        const now = Date.now();
        if (!record.once) record.downloads++;
        else if (!record.session) { record.session = { network, guesser, startedAt: now, lastAt: now, open: 1 }; record.downloads = 1; metric(this.env, 'one_time_session'); }
        else if (!secretMatches(record.session.network, network))
          throw new ApiError(410, 'This one-time link is already being downloaded.', 'consumed');
        else { record.session.lastAt = now; record.session.open += 1; }
        // A grant opens a session through a pause of its network running already: that pause holds it too (see hold()).
        if (record.once) this.hold(record);
        // Persist the claim before issuing any R2 read.
        this.save(record);
        if (record.once) await this.ctx.storage.setAlarm(this.nextDeadline(record));
      }
      return { kind: 'file' as const, objectKey: record.objectKey, name: record.name, size: record.size, once: record.once, range, mode };
    });
  }

  /**
   * A client verified the last chunk of a one-time encrypted download (docs/E2EE.md §11): from the session's own network
   * the link closes at once instead of idling out its retry window; from any other, and for anything else, nothing changes.
   */
  async done(network: string) {
    return guarded(async () => {
      const record = this.read();
      if (record?.status !== 'ready' || Date.now() >= record.expiresAt || !record.once || modeOf(record) !== 'e2ee' || !record.session
          || !secretMatches(record.session.network, network)) return false;
      this.close(record, 'consumed');
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      await this.cleanup();
      return true;
    });
  }

  /** A one-time response has ended, delivered or not: once none is left streaming, the session idles from now. */
  async ended() {
    return guarded(async () => {
      const record = this.required();
      if (record.status !== 'ready' || !record.session) return true;
      record.session.open = Math.max(0, record.session.open - 1); record.session.lastAt = Date.now();
      this.save(record);
      await this.ctx.storage.setAlarm(this.nextDeadline(record));
      return true;
    });
  }

  async changeExpiry(key: string, expiresIn: number, base: string) {
    return guarded(async () => {
      const record = await this.authorized(key);
      this.assertAvailable(record);
      this.assertClear(record);
      const expiresAt = (record.completedAt || record.createdAt) + expiresIn * 1000;
      if (expiresAt <= Date.now()) throw new ApiError(400, 'That lifetime has already elapsed.');
      record.expiresIn = expiresIn; record.expiresAt = expiresAt; this.save(record);
      await this.ctx.storage.setAlarm(this.nextDeadline(record));
      // What the owner's GET answers, password pauses included, so a client can take it over as it is.
      return this.ownerView(record, base);
    });
  }

  /**
   * The Budget's cleanup reconciler, for a reservation that outlived this transfer's lifetime: 'gone' when there is no
   * record or it is clean already (the Budget releases the reservation itself), else runs the alarm now, which closes
   * and cleans whatever is due (or retries a failed cleanup) and re-arms the next alarm, and answers 'rearmed'.
   */
  async reconcileCleanup(_id: string) {
    return guarded(async (): Promise<'gone' | 'rearmed'> => {
      const record = this.read();
      if (!record || record.clean) return 'gone';
      await this.alarm();
      return 'rearmed';
    });
  }

  /** The operator's view of the transfer (`id` names it when nothing was stored); like every read it closes a lapsed link. */
  async operatorView(id: string) {
    return guarded(() => this.inspect(id, this.read()));
  }

  private inspect(id: string, record: TransferRecord | null): OperatorView {
    if (!record) return { id, exists: false, status: null, name: null, size: null, createdAt: null, mode: null, expiresAt: null, once: null, protected: null, quarantine: null, clean: null };
    if (this.lapse(record)) this.ctx.waitUntil(this.cleanup());
    // An upload past its window is closed for good, also before its alarm marks it aborted.
    const late = ['creating', 'uploading', 'completing', 'failed'].includes(record.status) && Date.now() >= record.uploadDeadline;
    return {
      id: record.id, exists: true, status: late ? 'aborted' : record.status, name: record.name || null, size: record.size, createdAt: record.createdAt, mode: modeOf(record),
      expiresAt: record.expiresAt || null, once: record.once, protected: Boolean(record.pwHash), quarantine: record.quarantine ?? null, clean: record.clean,
    };
  }

  /**
   * For a link-preview bot (see the Worker's preview()): the file of a ready image anyone with the link may download
   * any number of times (not protected, not one-time, not quarantined), at most PREVIEW_BYTES and named as an image
   * type previews show; otherwise null. It counts no download and opens no session.
   */
  async previewable() {
    return guarded(() => {
      const record = this.read();
      if (!record) return null;
      // Ready only: not still uploading, not closed (also before its cleanup ran or its alarm marked it).
      try { this.assertAvailable(record); } catch { return null; }
      // An encrypted file has no picture to show: like a protected one, it never previews (docs/E2EE.md §12.2).
      if (record.quarantine || record.pwHash || record.once || modeOf(record) !== 'raw' || record.size > PREVIEW_BYTES || !previewType(record.name)) return null;
      return { objectKey: record.objectKey, name: record.name, size: record.size, expiresAt: record.expiresAt };
    });
  }

  /** Operator: closes every way to the file while a report about it is reviewed (see assertClear()). Idempotent; a closed transfer can't be. */
  async quarantine(note: string) {
    return guarded(() => {
      const record = this.required();
      if (closedOutcome(this.inspect(record.id, record))) throw new ApiError(409, 'This transfer is closed already.', 'closed');
      if (!record.quarantine) { record.quarantine = { at: Date.now(), note }; this.save(record); }
      return this.inspect(record.id, record);
    });
  }

  /** Operator: lifts the quarantine. A takedown stays final whether it was quarantined or not. */
  async restore() {
    return guarded(() => {
      const record = this.required();
      if (record.status === 'removed') throw new ApiError(409, 'This file was taken down for good.', 'removed');
      if (!record.quarantine) throw new ApiError(409, 'This file is not quarantined.', 'not_quarantined');
      delete record.quarantine; this.save(record);
      return this.inspect(record.id, record);
    });
  }

  async remove(key: string, abort: boolean) {
    return guarded(async () => {
      // Aborting takes the resume token too: it only ever revokes an incomplete upload.
      const { record } = await this.access(key, abort);
      if (!abort) this.lapse(record); // a lapsed link keeps the reason it would show anyway
      if (abort && (record.status === 'ready' || record.status === 'consumed' || record.status === 'completing'))
        throw new ApiError(409, 'This upload has completed or is finalizing; use private deletion.');
      if (['aborted', 'expired', 'consumed', 'deleted', 'removed'].includes(record.status)) {
        // Already closed: keep its public reason (an operator takedown above all) and only make sure cleanup has run.
        if (!record.clean) await this.cleanup();
        return true;
      }
      this.close(record, abort ? 'aborted' : 'deleted');
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      await this.cleanup();
      return true;
    });
  }

  /**
   * Operator takedown: closes the transfer for everyone, removes the bytes now and records the reason. It is
   * kept for good: a client can derive the same id again (clientKey with Idempotency-Key), so it must never
   * take an upload again. An id that doesn't exist (any more) gets the same tombstone, so it can be blocked
   * in advance; the result says whether a transfer existed.
   */
  async takedown(id: string) {
    return guarded(async () => {
      const existing = this.read();
      const record: TransferRecord = existing ?? { id, name: '', size: 0, expiresIn: 0, once: false, fingerprint: '', keyHash: '',
        objectKey: '', uploadId: '', createdAt: Date.now(), expiresAt: 0, uploadDeadline: 0, status: 'removed', operation: '',
        operationAt: 0, downloads: 0, clean: true };
      delete record.purgeAt; this.close(record, 'removed');
      if (!record.clean) {
        await this.ctx.storage.setAlarm(Date.now() + 60000);
        await this.cleanup();
      }
      return Boolean(existing);
    });
  }

  /** Called after a one-time link delivered the whole file in one response: close it right away. */
  async finishConsumed() {
    return guarded(async () => {
      const record = this.required();
      if (record.once && record.status === 'ready') this.close(record, 'consumed');
      if (record.status !== 'consumed') return true;
      if (!record.clean) await this.ctx.storage.setAlarm(Date.now() + 60000);
      await this.cleanup();
      return true;
    });
  }

  /**
   * Every cleanup entry (finishConsumed, remove and abort, takedown, a lapse, the alarm) runs `work` through here.
   * Access is closed before; a failure keeps it closed and retries soon (CLEANUP_RETRY_MS by the tries so far), so
   * the alarm never stays at a far-off time while the bytes or their reservation are left. False if it failed.
   */
  private cleaning: Promise<boolean> | null = null;
  private async cleanup(work = () => this.cleanupRecord()) {
    // One at a time: the alarm, a lapse found by a read and the Budget's reconciler can start one together, and a
    // second run over a half-cleaned record would count the storage twice and clear the late-object check.
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.runCleanup(work).finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  private async runCleanup(work: () => Promise<void>) {
    try { await work(); return true; }
    catch (error) {
      const record = this.read(), code = error instanceof CleanupError ? error.code : 'storage';
      const tries = (record?.cleanupTries || 0) + 1;
      if (record) { record.cleanupTries = tries; this.save(record); }
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS[Math.min(tries, CLEANUP_RETRY_MS.length) - 1]);
      metric(this.env, 'cleanup_retry', code);
      console.error(JSON.stringify({ event: 'cleanup_retry_scheduled', code, tries,
        error: error instanceof CleanupError ? error.reason : error instanceof Error ? error.name : 'unknown' }));
      return false;
    }
  }

  /** Aborts a multipart upload; one that is gone (aborted, or completed into the object) is fine. */
  private async abort(objectKey: string, uploadId: string) {
    try { await this.env.FILES.resumeMultipartUpload(objectKey, uploadId).abort(); }
    catch (error) {
      const missing = error instanceof Error && /\b10024\b|NoSuchUpload/.test(error.message);
      if (!missing && !await this.env.FILES.head(objectKey)) throw error;
    }
  }

  /** Cleanup keeps only the record: every other table (parts, attempts and whatever else a transfer keeps) goes with the bytes. */
  private dropTables() {
    for (const { name } of this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name<>'transfer' AND name NOT GLOB '_cf_*'").toArray())
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
  }

  private async cleanupRecord() {
    const record = this.required();
    if (record.status === 'ready' || record.status === 'uploading' || record.status === 'creating' || record.status === 'completing') return;
    if (!record.clean) {
      if (record.uploadId && !record.completedAt) await step('r2_abort', this.abort(record.objectKey, record.uploadId));
      await step('r2_delete', this.env.FILES.delete(record.objectKey));
      // Storage is released only once R2 confirmed both; a failed release is retried like the rest.
      await step('budget_release', budget(this.env).release(record.id).then(unwrap));
      const current = this.required(), now = Date.now();
      if (current.clean) return;
      // Storage the transfer used, for statistics: the file (or the parts of an upload that never completed) times how
      // long R2 held it, in GB-days of 2^30 bytes as R2 bills them; by how it ended.
      // double2: how often it was downloaded (each download request that started counts; a one-time link 1 at most).
      metric(this.env, 'stored_gb_days', current.status, this.held(current) / 2 ** 30 * Math.max(0, now - (current.completedAt || current.createdAt)) / DAY_MS,
        [clientKind(current)], current.downloads || 0);
      current.verifyAt = now + VERIFY_MS; current.verifyUpload = current.completedAt ? '' : current.uploadId;
      current.clean = true; current.uploadId = '';
      current.name = ''; current.fingerprint = '';
      // A one-time link's session goes too: its network hash is no use once the link is closed. So do an encrypted
      // transfer's head and meta (its pins go with the tables below): a tombstone keeps none of them (docs/E2EE.md §4.4).
      for (const field of ['pwSalt', 'pwHash', 'pwIter', 'pwPausedUntil', 'quarantine', 'session', 'head', 'meta', 'client'] as const) delete current[field];
      if (current.status !== 'removed') current.purgeAt = now + TOMBSTONE_TTL_MS;
      if (current.cleanupDue) metric(this.env, 'cleanup_age', '', Math.max(0, Math.round((now - current.cleanupDue) / 1000)));
      delete current.cleanupDue; delete current.cleanupTries;
      this.dropTables();
      this.save(current);
    }
    await this.schedule();
  }

  /** An hour after cleanup: removes an object or upload that an R2 completion racing the cleanup left behind. */
  private async verify() {
    const record = this.required();
    if (record.verifyUpload) await step('r2_abort', this.abort(record.objectKey, record.verifyUpload));
    if (record.objectKey && await step('r2_verify', this.env.FILES.head(record.objectKey))) {
      await step('r2_delete', this.env.FILES.delete(record.objectKey));
      metric(this.env, 'cleanup_orphan');
    }
    const current = this.required();
    delete current.verifyAt; delete current.verifyUpload; delete current.cleanupTries;
    this.save(current);
    await this.schedule();
  }

  /** The alarm a clean record still needs: the check for a late object, then the purge (a takedown has none). */
  private async schedule() {
    const { verifyAt, purgeAt, status } = this.required();
    const next = verifyAt || (status !== 'removed' && purgeAt);
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const record = this.read();
    if (!record) return;
    if (record.clean) {
      if (record.verifyAt) {
        if (Date.now() < record.verifyAt) await this.ctx.storage.setAlarm(record.verifyAt);
        else await this.cleanup(() => this.verify());
        return;
      }
      // A takedown is never purged, whatever purge date it may carry.
      if (record.status === 'removed' || !record.purgeAt) return;
      if (Date.now() >= record.purgeAt) await this.purge();
      else await this.ctx.storage.setAlarm(record.purgeAt);
      return;
    }
    const now = Date.now();
    if (record.status === 'ready') {
      if (record.session && now >= sessionDeadline(record.session)) this.close(record, 'consumed', sessionDeadline(record.session));
      else if (now < record.expiresAt) { await this.ctx.storage.setAlarm(this.nextDeadline(record)); return; }
      else this.close(record, 'expired', record.expiresAt);
    } else if (['creating', 'uploading', 'completing', 'failed'].includes(record.status)) {
      if (now < record.uploadDeadline) { await this.ctx.storage.setAlarm(record.uploadDeadline); return; }
      this.close(record, 'aborted', record.uploadDeadline);
    }
    await this.cleanup();
  }
}
