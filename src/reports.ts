import { DurableObject } from 'cloudflare:workers';
import { ApiError, guarded, unwrap, metric, closedOutcome } from './shared';

/** Closed cases go, with their events, this long after they closed (daily alarm); open ones stay until decided. */
const RETENTION_MS = 183 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Every transfer is gone 24 h (upload window) + 7 d (longest lifetime) after it was created: the alarm closes open
 * cases older than that (and an hour) as their transfer ended, read or not, a batch of transfers at a time.
 */
const STALE_MS = 8 * DAY_MS + 60 * 60 * 1000, STALE_BATCH = 100;
/** Open case ids the operator's transfer view names, in the order of the queue. */
const SHOWN_CASES = 20;
// Crockford base32 (no I, L, O, U), so a case id read out or typed is unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CATEGORIES: readonly string[] = ['malware', 'phishing', 'csam', 'illegal', 'copyright', 'privacy', 'other'];
export const DECISIONS: readonly string[] = ['quarantine', 'restore', 'remove', 'reject', 'note'];
/**
 * How urgent a category is, 1 the most: child sexual abuse material first, then files that attack whoever opens them,
 * then other unlawful content, then rights and the rest. The open queue is sorted by it, then oldest first.
 */
export const PRIORITY: Readonly<Record<string, number>> = { csam: 1, malware: 2, phishing: 2, illegal: 3, privacy: 3, copyright: 4, other: 4 };
const PRIORITY_SQL = `CASE category ${Object.entries(PRIORITY).map(([category, rank]) => `WHEN '${category}' THEN ${rank}`).join(' ')} ELSE 4 END`;
type Outcome = 'removed' | 'restored' | 'rejected' | 'expired';
const OUTCOMES: Record<string, Outcome> = { restore: 'restored', remove: 'removed', reject: 'rejected' };
type CaseRow = {
  id: string; created_at: number; transfer_id: string; category: string; details: string; name: string | null; email: string | null;
  network: string; status: 'open' | 'closed'; outcome: Outcome | null; updated_at: number; closed_at: number | null; file_available: number;
};
/** `fileAvailable` is false for a transfer already closed (its tombstone still known); `outcome` stores the case closed at once. */
export interface Report {
  transferId: string; category: string; details: string; name: string | null; email: string | null; network: string;
  fileAvailable: boolean; outcome: 'removed' | null;
}

/** The one Reports object; any other name would be an empty one. */
export const reports = (env: Pick<Env, 'REPORTS'>) => env.REPORTS.getByName('reports-v1');
export const validCase = (value: string) => /^R-[0-9A-HJKMNP-TV-Z]{10}$/.test(value);

const shown = (row: CaseRow) => ({
  case: row.id, createdAt: row.created_at, transferId: row.transfer_id, category: row.category, details: row.details, name: row.name,
  email: row.email, network: row.network, status: row.status, outcome: row.outcome, updatedAt: row.updated_at, closedAt: row.closed_at,
  priority: PRIORITY[row.category] ?? 4, fileAvailable: row.file_available === 1,
});

/**
 * Reports about transfers (POST /api/reports) and what the operator decided, kept apart from the transfers so a
 * case outlives its file. A case is `open` until a decision closes it with an outcome; when its transfer is gone
 * first, the next read (or the daily alarm, once the transfer must be gone) closes it as `removed` (taken down) or
 * `expired`. A case filed about a transfer already closed (`fileAvailable` false: its link still answers 410, e.g. a
 * one-time link used up) stays open for the operator to see and decide; unless they do, the alarm closes it once it
 * is STALE_MS old, as it closes any open case by then. `network` is the reporter's daily network hash, the only trace
 * of them besides the contact details they gave; a network files at most MAX_DAILY_REPORTS_PER_NETWORK cases a day
 * (across Cloudflare's locations, which the rate limit counts apart), so a flood of fake reports can't grow without bound.
 */
export class Reports extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, transfer_id TEXT NOT NULL,
      category TEXT NOT NULL, details TEXT NOT NULL, name TEXT, email TEXT, network TEXT NOT NULL, status TEXT NOT NULL,
      outcome TEXT, updated_at INTEGER NOT NULL, closed_at INTEGER, file_available INTEGER NOT NULL DEFAULT 1)`);
    sql.exec('CREATE TABLE IF NOT EXISTS events (case_id TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS cases_status ON cases(status, created_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS cases_transfer ON cases(transfer_id, status)');
    sql.exec('CREATE INDEX IF NOT EXISTS cases_closed ON cases(closed_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS cases_network ON cases(network)');
    sql.exec('CREATE INDEX IF NOT EXISTS events_case ON events(case_id, at)');
  }

  private row(id: string) {
    const row = this.ctx.storage.sql.exec<CaseRow>('SELECT * FROM cases WHERE id=?', id).toArray()[0];
    if (!row) throw new ApiError(404, 'Report not found.', 'not_found');
    return row;
  }

  private full(row: CaseRow) {
    const events = this.ctx.storage.sql.exec<{ at: number; action: string; note: string }>(
      'SELECT at, action, note FROM events WHERE case_id=? ORDER BY at, rowid', row.id).toArray();
    return { ...shown(row), events };
  }

  /**
   * Closes the open cases on a transfer that is gone, with the outcome as their last event. Cases filed about the
   * file once it was gone already close only when it is taken down (that decides them) or if they were filed before
   * `stale` (see the class).
   */
  private closeAll(transferId: string, outcome: Outcome, stale = 0) {
    const sql = this.ctx.storage.sql, now = Date.now(), open = `transfer_id=? AND status='open' AND (file_available=1 OR created_at<?)`;
    const before = outcome === 'removed' ? Number.MAX_SAFE_INTEGER : stale;
    this.ctx.storage.transactionSync(() => {
      sql.exec(`INSERT INTO events (case_id, at, action, note) SELECT id, ?, ?, '' FROM cases WHERE ${open}`, now, outcome, transferId, before);
      sql.exec(`UPDATE cases SET status='closed', outcome=?, updated_at=?, closed_at=? WHERE ${open}`, outcome, now, now, transferId, before);
    });
  }

  /** Asks the transfer of each open case among `rows` once and closes the cases of those gone; true if any closed. */
  private settle(rows: CaseRow[]) {
    return this.closeGone([...new Set(rows.filter(row => row.status === 'open').map(row => row.transfer_id))]);
  }

  /** Asks each transfer once and closes the open cases of those gone (see closeAll()); true if any closed. */
  private async closeGone(ids: string[], stale = 0) {
    const outcomes = await Promise.all(ids.map(async id => {
      // A transfer that can't answer now is asked again on the next read.
      try { return [id, closedOutcome(unwrap(await this.env.TRANSFERS.getByName(id).operatorView(id)))] as const; }
      catch { return [id, null] as const; }
    }));
    for (const [id, outcome] of outcomes) if (outcome) this.closeAll(id, outcome, stale);
    return outcomes.some(([, outcome]) => outcome);
  }

  async create(report: Report) {
    return guarded(async () => {
      const sql = this.ctx.storage.sql, now = Date.now();
      if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM cases WHERE network=?', report.network).one().count >= Number(this.env.MAX_DAILY_REPORTS_PER_NETWORK))
        throw new ApiError(429, 'This network has sent too many reports today. Please try again tomorrow.', 'report_limit');
      let id: string;
      do id = 'R-' + Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => ALPHABET[byte & 31]).join('');
      while (sql.exec('SELECT 1 FROM cases WHERE id=?', id).toArray().length);
      this.ctx.storage.transactionSync(() => {
        sql.exec(`INSERT INTO cases (id, created_at, transfer_id, category, details, name, email, network, status, outcome, updated_at, closed_at, file_available)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, now, report.transferId, report.category, report.details, report.name,
          report.email, report.network, report.outcome ? 'closed' : 'open', report.outcome, now, report.outcome ? now : null, report.fileAvailable ? 1 : 0);
        sql.exec(`INSERT INTO events (case_id, at, action, note) VALUES (?, ?, 'received', '')`, id, now);
        if (report.outcome) sql.exec(`INSERT INTO events (case_id, at, action, note) VALUES (?, ?, ?, '')`, id, now, report.outcome);
      });
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now + DAY_MS);
      return { case: id, received: now, fileAvailable: report.fileAvailable };
    });
  }

  /**
   * Cases, of one transfer only with `transfer`, following the case `after` names (the last case of the page before):
   * the open queue by priority, then oldest first; closed and all cases newest first. Open cases on the page whose
   * transfer is gone are closed before it is answered (see closeAll(): one filed once its file was gone already stays
   * open unless the file was taken down).
   */
  async list(status: 'open' | 'closed' | 'all', limit: number, filter: { after?: string; transfer?: string } = {}) {
    return guarded(async () => {
      const where: string[] = [], bindings: SqlStorageValue[] = [], queue = status === 'open';
      if (status !== 'all') { where.push('status=?'); bindings.push(status); }
      if (filter.transfer) { where.push('transfer_id=?'); bindings.push(filter.transfer); }
      if (filter.after) {
        const last = this.ctx.storage.sql.exec<CaseRow>('SELECT * FROM cases WHERE id=?', filter.after).toArray()[0];
        if (!last) throw new ApiError(400, 'That case is gone: list again from the start.', 'invalid_cursor');
        where.push(queue ? `(${PRIORITY_SQL}, created_at, id) > (?, ?, ?)` : '(created_at, id) < (?, ?)');
        bindings.push(...(queue ? [PRIORITY[last.category] ?? 4] : []), last.created_at, last.id);
      }
      const query = () => this.ctx.storage.sql.exec<CaseRow>(`SELECT * FROM cases${where.length ? ' WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${queue ? `${PRIORITY_SQL}, created_at, id` : 'created_at DESC, id DESC'} LIMIT ?`, ...bindings, limit).toArray();
      let rows = query();
      if (await this.settle(rows)) rows = query();
      return rows.map(shown);
    });
  }

  async get(id: string) {
    return guarded(async () => {
      const row = this.row(id);
      return this.full(await this.settle([row]) ? this.row(id) : row);
    });
  }

  /** Open cases on a transfer and the first ids among them in the queue, after closing them if the transfer is gone (`outcome`, from closedOutcome()). */
  async forTransfer(transferId: string, outcome: 'removed' | 'expired' | null) {
    return guarded(() => {
      if (outcome) this.closeAll(transferId, outcome);
      const sql = this.ctx.storage.sql;
      return {
        count: sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM cases WHERE transfer_id=? AND status='open'`, transferId).one().count,
        cases: sql.exec<{ id: string }>(`SELECT id FROM cases WHERE transfer_id=? AND status='open' ORDER BY ${PRIORITY_SQL}, created_at, id LIMIT ?`, transferId, SHOWN_CASES)
          .toArray().map(row => row.id),
      };
    });
  }

  /**
   * Records an operator action taken on a transfer outside a case (quarantine, restore, remove: a takedown) with its
   * reason in each of its open cases. After a takedown the next read closes them as removed.
   */
  async annotate(transferId: string, action: string, note: string) {
    return guarded(() => {
      const sql = this.ctx.storage.sql, now = Date.now();
      this.ctx.storage.transactionSync(() => {
        sql.exec(`INSERT INTO events (case_id, at, action, note) SELECT id, ?, ?, ? FROM cases WHERE transfer_id=? AND status='open'`, now, action, note, transferId);
        sql.exec(`UPDATE cases SET updated_at=? WHERE transfer_id=? AND status='open'`, now, transferId);
      });
      return true;
    });
  }

  async openCount() {
    return guarded(() => this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM cases WHERE status='open'`).one().count);
  }

  /** For readiness: how many cases are open, when the oldest of them was filed and the most urgent priority among them (counts only). */
  async summary() {
    return guarded(() => {
      const row = this.ctx.storage.sql.exec<{ open: number; oldest: number | null; priority: number | null }>(
        `SELECT COUNT(*) AS open, MIN(created_at) AS oldest, MIN(${PRIORITY_SQL}) AS priority FROM cases WHERE status='open'`).one();
      return { open: row.open, oldest: row.oldest, priority: row.priority };
    });
  }

  /**
   * The operator's decision on a case, applied to its transfer first: `quarantine` (stays open), `restore` (lifts it),
   * `remove` (the final takedown) or `reject` (the transfer stays as it is) close the case with that outcome; `note`
   * only adds to its record, also once it is closed. A quarantine must not outlast its review unseen: rejecting the
   * last open case on a quarantined transfer is refused (409 quarantined), restore or remove decide it. The answer
   * carries the transfer's status and quarantine as the decision left them.
   */
  async decide(id: string, action: string, note: string) {
    return guarded(async () => {
      let row = this.row(id);
      if (await this.settle([row])) row = this.row(id);
      const transfer = this.env.TRANSFERS.getByName(row.transfer_id);
      if (action !== 'note') {
        if (row.status !== 'open') throw new ApiError(409, 'This report is closed already.', 'closed');
        if (action === 'quarantine') { unwrap(await transfer.quarantine(note)); metric(this.env, 'quarantine'); }
        if (action === 'restore') { unwrap(await transfer.restore()); metric(this.env, 'restore'); }
        if (action === 'remove') { unwrap(await transfer.takedown(row.transfer_id)); metric(this.env, 'takedown'); }
        if (action === 'reject' && unwrap(await transfer.operatorView(row.transfer_id)).quarantine
            && !this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM cases WHERE transfer_id=? AND status='open' AND id<>?`, row.transfer_id, id).one().count)
          throw new ApiError(409, 'This file is quarantined. Decide restore to lift the quarantine, or remove to take the file down.', 'quarantined');
      }
      const sql = this.ctx.storage.sql, now = Date.now(), outcome = OUTCOMES[action];
      this.ctx.storage.transactionSync(() => {
        sql.exec('INSERT INTO events (case_id, at, action, note) VALUES (?, ?, ?, ?)', id, now, action, note);
        if (outcome) sql.exec(`UPDATE cases SET status='closed', outcome=?, updated_at=?, closed_at=? WHERE id=? AND status='open'`, outcome, now, now, id);
        else sql.exec('UPDATE cases SET updated_at=? WHERE id=?', now, id);
      });
      const after = await transfer.operatorView(row.transfer_id).then(result => unwrap(result)).catch(() => null);
      return { ...this.full(this.row(id)), transfer: after && { status: after.status, quarantine: after.quarantine } };
    });
  }

  async alarm() {
    const sql = this.ctx.storage.sql, now = Date.now(), cutoff = now - RETENTION_MS;
    // Cases nobody reads still close once their transfer must be gone, so their retention starts.
    const stale = sql.exec<{ transfer_id: string }>(`SELECT DISTINCT transfer_id FROM cases WHERE status='open' AND created_at<? LIMIT ?`, now - STALE_MS, STALE_BATCH)
      .toArray().map(row => row.transfer_id);
    const more = await this.closeGone(stale, now - STALE_MS) && stale.length === STALE_BATCH;
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM events WHERE case_id IN (SELECT id FROM cases WHERE status='closed' AND closed_at<?)`, cutoff);
      sql.exec(`DELETE FROM cases WHERE status='closed' AND closed_at<?`, cutoff);
    });
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM cases').one().count) await this.ctx.storage.setAlarm(Date.now() + (more ? 60000 : DAY_MS));
  }
}
