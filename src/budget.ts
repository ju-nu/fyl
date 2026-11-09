import { DurableObject } from 'cloudflare:workers';
import { ApiError, guarded, metric, unwrap, ATTEMPT_LEASE_MS } from './shared';

/**
 * Every transfer closes 24 h (upload window) + 7 d (longest lifetime) after it was admitted; a reservation still active
 * an hour after that means its cleanup never ran or keeps failing (status() `overdueCleanups`, reconcileCleanups()).
 */
const OVERDUE_MS = 8 * 86400000 + 3600000;

const DAY_MS = 86400000;
const dayOf = (time: number) => Math.floor(time / DAY_MS) * DAY_MS;
type Pending = { id: string; part: number; slot: number; ticket: string; bytes: number; day: number; network: string };
type Totals = { used: number; copies: number; reserved: number; active: number };
type Counts = { bytes: number; reserved: number; uploads: number };

/**
 * Global admission accounting only; file bytes and normal reads never pass here. What it counts:
 * - reserved: bytes of admitted part attempts not yet settled (the Worker hasn't reported R2's result). Temporary
 *   admission control only: an attempt that never settles stops counting after ATTEMPT_LEASE_MS.
 * - stored payload (`used` of an upload): its unique confirmed part bytes, a part confirmed twice counting once.
 * - copies (`copies` of an upload): a part R2 stored again in another of its slots (a retry whose first attempt
 *   did arrive, a second client) is held there until the completion drops every copy it doesn't name, or the
 *   cleanup aborts the upload. Each such copy counts its bytes until then; one written over in the same slot doesn't.
 *   MAX_STORED_BYTES checks the stored payload and copies of live uploads plus reserved bytes; an upload's payload
 *   is released only once its cleanup removed the bytes from R2.
 * - daily payload: confirmed part bytes R2 stored (each part once, plus each copy), charged to the UTC day their
 *   attempt was admitted, plus reserved bytes admitted that day. MAX_DAILY_UPLOAD_BYTES applies to it.
 * - attempted bytes: every admitted attempt's bytes per day, failed and duplicate ones too. An indicator for the
 *   operator without a limit, and no billing guarantee.
 * - network daily payload: the daily payload per network of the request that sends the part (today's network hash,
 *   which rotates daily), limited by MAX_DAILY_UPLOAD_BYTES_PER_NETWORK. A resumed upload counts where it is sent from.
 *   A network is an IPv4 address or an IPv6 /56 (see networkOf()).
 * - running uploads per network: uploads admitted under today's network hash that neither completed nor were
 *   released, at most MAX_ACTIVE_UPLOADS_PER_NETWORK; a completed upload stays stored but no longer runs. Uploads
 *   admitted before UTC midnight carry yesterday's hash and stop counting then.
 * - network stored bytes: what MAX_STORED_BYTES counts (payload, copies and reserved bytes), per network that
 *   admitted the upload, for the upload's whole life and wherever its parts come from; at most
 *   MAX_STORED_BYTES_PER_NETWORK. It needs a hash that doesn't rotate (`live_hash`, HMAC of 'fyl-live:' and the
 *   network), kept only on active reservations and in the `live` sums, both dropped once the cleanup released the
 *   upload's bytes: at most the upload window plus the longest lifetime (8 days). A reservation without one counts
 *   for no network.
 * A part reserves (pending row) before R2 may receive it, then confirms or releases it; each booking is idempotent
 * and atomic, so a crash leaves at most a pending row that the lease ends. Only reserved bytes are ever confirmed:
 * an attempt whose lease ended is refused, so no byte counts that the caps didn't admit. Sums live in maintained
 * aggregates (totals, daily, networks), updated in the same transaction and reconciled from the rows by the alarm.
 */
export class Budget extends DurableObject<Env> {
  /** Rows the SQL statements read so far; tests check the admission path's share doesn't grow with the tables. */
  rowsRead = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, ip_hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0, copies INTEGER NOT NULL DEFAULT 0, live_hash TEXT
    )`);
    sql.exec('CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // When the cleanup reconciler last tried an overdue reservation, so one that stays stuck never keeps newer ones out.
    sql.exec('CREATE TABLE IF NOT EXISTS reconciled (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS daily (day INTEGER PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, attempted INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE INDEX IF NOT EXISTS reservations_day ON reservations(created_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS reservations_active ON reservations(active)');
    sql.exec('CREATE TABLE IF NOT EXISTS pending (id TEXT NOT NULL, part INTEGER NOT NULL, slot INTEGER NOT NULL, ticket TEXT NOT NULL, bytes INTEGER NOT NULL, day INTEGER NOT NULL, network TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, part, slot))');
    sql.exec('CREATE INDEX IF NOT EXISTS pending_at ON pending(at)');
    // The slots R2 holds a confirmed copy of a part in: the first counts as payload, every other one as a copy.
    sql.exec('CREATE TABLE IF NOT EXISTS confirmed (id TEXT NOT NULL, part INTEGER NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (id, part, slot))');
    sql.exec('CREATE TABLE IF NOT EXISTS networks (network TEXT NOT NULL, day INTEGER NOT NULL, uploads INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (network, day))');
    sql.exec('CREATE INDEX IF NOT EXISTS networks_day ON networks(day)');
    sql.exec('CREATE TABLE IF NOT EXISTS totals (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    // Stored bytes and active uploads per stable network hash (see the class); a row goes with its network's last upload.
    sql.exec('CREATE TABLE IF NOT EXISTS live (network TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0)');
  }

  private all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings), rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    return rows;
  }

  /** Operator kill switch: while paused, no upload is admitted and no further part may be stored. */
  private paused() {
    return this.all<{ value: string }>("SELECT value FROM settings WHERE name = 'paused'")[0]?.value === 'true';
  }

  private assertOpen() {
    if (this.paused()) throw this.refused(503, 'Uploads are paused for maintenance. Please try again later.', 'uploads_paused');
  }

  /** An admission or charge refused by the switch or a budget, counted by its code. */
  private refused(status: number, message: string, code: string) {
    metric(this.env, 'budget_refused', code);
    return new ApiError(status, message, code);
  }

  private totals(): Totals {
    const totals: Totals = { used: 0, copies: 0, reserved: 0, active: 0 };
    for (const row of this.all<{ name: keyof Totals; value: number }>('SELECT name, value FROM totals')) totals[row.name] = row.value;
    return totals;
  }

  private total(name: keyof Totals, delta: number) {
    if (delta) this.all('INSERT INTO totals (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value', name, delta);
  }

  private today(day: number) {
    return this.all<Counts & { attempted: number }>('SELECT bytes, reserved, attempted, uploads FROM daily WHERE day = ?', day)[0]
      ?? { bytes: 0, reserved: 0, attempted: 0, uploads: 0 };
  }

  private daily(day: number, change: Partial<Counts & { attempted: number }>) {
    this.all(`INSERT INTO daily (day, bytes, reserved, attempted, uploads) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET
      bytes = bytes + excluded.bytes, reserved = reserved + excluded.reserved, attempted = attempted + excluded.attempted, uploads = uploads + excluded.uploads`,
    day, change.bytes || 0, change.reserved || 0, change.attempted || 0, change.uploads || 0);
  }

  private network(network: string, day: number) {
    return this.all<Counts & { active: number }>('SELECT uploads, active, bytes, reserved FROM networks WHERE network = ? AND day = ?', network, day)[0]
      ?? { uploads: 0, active: 0, bytes: 0, reserved: 0 };
  }

  private networks(network: string, day: number, change: Partial<Counts & { active: number }>) {
    this.all(`INSERT INTO networks (network, day, uploads, active, bytes, reserved) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(network, day) DO UPDATE SET
      uploads = uploads + excluded.uploads, active = MAX(0, active + excluded.active), bytes = bytes + excluded.bytes, reserved = reserved + excluded.reserved`,
    network, day, change.uploads || 0, change.active || 0, change.bytes || 0, change.reserved || 0);
  }

  /** The stable network hash an active upload counts its stored bytes for (see the class), or null. */
  private liveOf(id: string) {
    return this.all<{ live_hash: string | null }>('SELECT live_hash FROM reservations WHERE id = ? AND active = 1', id)[0]?.live_hash ?? null;
  }

  private stored(network: string) {
    return this.all<{ bytes: number }>('SELECT bytes FROM live WHERE network = ?', network)[0]?.bytes ?? 0;
  }

  private lived(network: string | null, change: { bytes?: number; uploads?: number }) {
    if (network && (change.bytes || change.uploads)) this.all(`INSERT INTO live (network, bytes, uploads) VALUES (?, ?, ?) ON CONFLICT(network) DO UPDATE SET
      bytes = bytes + excluded.bytes, uploads = uploads + excluded.uploads`, network, change.bytes || 0, change.uploads || 0);
  }

  /**
   * Removes a pending attempt and its reserved bytes; every pending row counts until it is removed, and only once.
   * `live` is the stable network hash of its upload, looked up unless the caller has it.
   */
  private unpend(row: Pending, live = this.liveOf(row.id)) {
    const cursor = this.ctx.storage.sql.exec('DELETE FROM pending WHERE id = ? AND part = ? AND slot = ? AND ticket = ?', row.id, row.part, row.slot, row.ticket);
    cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    if (!cursor.rowsWritten) return;
    this.total('reserved', -row.bytes);
    this.daily(row.day, { reserved: -row.bytes });
    this.networks(row.network, row.day, { reserved: -row.bytes });
    this.lived(live, { bytes: -row.bytes });
  }

  /** Ends the lease of attempts that never settled; `limit` keeps the admission path's share small. */
  private sweep(now: number, limit = 50) {
    for (const row of this.all<Pending>('SELECT * FROM pending WHERE at < ? ORDER BY at LIMIT ?', now - ATTEMPT_LEASE_MS, limit)) this.unpend(row);
  }

  /**
   * Rejects `delta` more bytes for `network` today, and for `live` (the stable hash of the network that admitted the
   * upload), if they would exceed the storage, daily or network budgets.
   */
  private assertFits(delta: number, day: number, network: string, live: string | null, admission = false) {
    const totals = this.totals(), daily = this.today(day), net = this.network(network, day);
    if (totals.used + totals.copies + totals.reserved + delta > Number(this.env.MAX_STORED_BYTES) || (admission && totals.active >= Number(this.env.MAX_ACTIVE_UPLOADS)))
      throw this.refused(429, 'Storage capacity is temporarily full. Please try later.', 'storage_capacity');
    if (daily.bytes + daily.reserved + delta > Number(this.env.MAX_DAILY_UPLOAD_BYTES) || (admission && daily.uploads >= Number(this.env.MAX_DAILY_UPLOADS)))
      throw this.refused(429, 'The daily upload budget is full. Please try later.', 'daily_budget');
    if (admission && net.uploads >= Number(this.env.MAX_DAILY_UPLOADS_PER_NETWORK))
      throw this.refused(429, 'Daily upload limit reached for this network.', 'network_budget');
    if (admission && net.active >= Number(this.env.MAX_ACTIVE_UPLOADS_PER_NETWORK))
      throw this.refused(429, 'Too many uploads from this network are running. Finish or cancel one first.', 'network_uploads');
    if (net.bytes + net.reserved + delta > Number(this.env.MAX_DAILY_UPLOAD_BYTES_PER_NETWORK))
      throw this.refused(429, "This network's daily upload volume is used up. Please try tomorrow.", 'network_bytes');
    if (live && this.stored(live) + delta > Number(this.env.MAX_STORED_BYTES_PER_NETWORK))
      throw this.refused(429, 'This network already stores the maximum for now. Delete a file or wait until one expires.', 'network_storage');
  }

  async setPaused(paused: boolean) {
    return guarded(() => {
      this.all("INSERT INTO settings (name, value) VALUES ('paused', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", String(paused));
      return this.status();
    });
  }

  /** Operator view of the switches and budgets: `bytes` is what each limit checks, the rest its parts. */
  status() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => this.sweep(now, 1000));
    const totals = this.totals(), today = this.today(dayOf(now));
    return {
      paused: this.paused(),
      stored: { bytes: totals.used + totals.copies + totals.reserved, payload: totals.used, copies: totals.copies, reserved: totals.reserved, uploads: totals.active,
        maxBytes: Number(this.env.MAX_STORED_BYTES), maxUploads: Number(this.env.MAX_ACTIVE_UPLOADS) },
      today: { bytes: today.bytes + today.reserved, payload: today.bytes, reserved: today.reserved, attempted: today.attempted,
        uploads: today.uploads, maxBytes: Number(this.env.MAX_DAILY_UPLOAD_BYTES), maxUploads: Number(this.env.MAX_DAILY_UPLOADS) },
      network: { maxBytes: Number(this.env.MAX_DAILY_UPLOAD_BYTES_PER_NETWORK), maxUploads: Number(this.env.MAX_DAILY_UPLOADS_PER_NETWORK),
        maxActive: Number(this.env.MAX_ACTIVE_UPLOADS_PER_NETWORK), maxStored: Number(this.env.MAX_STORED_BYTES_PER_NETWORK) },
      overdueCleanups: this.all<{ count: number }>('SELECT COUNT(*) AS count FROM reservations WHERE created_at < ? AND active = 1',
        now - OVERDUE_MS)[0].count,
    };
  }

  /**
   * Admits a declared upload from `ipHash` (today's network hash) and `liveHash` (the same network's stable hash, which
   * the upload's stored bytes count for while it lives; without it the upload counts for no network). Only checks that the file
   * could still fit; nothing is charged yet.
   */
  async reserve(id: string, bytes: number, ipHash: string, liveHash: string | null = null) {
    return guarded(async () => {
      const now = Date.now(), day = dayOf(now), live = typeof liveHash === 'string' ? liveHash : null;
      this.ctx.storage.transactionSync(() => {
        const existing = this.all<{ bytes: number; active: number }>('SELECT bytes, active FROM reservations WHERE id = ?', id)[0];
        if (existing) {
          if (existing.bytes !== bytes || !existing.active) throw new ApiError(409, 'This upload reservation is closed.');
          return;
        }
        this.assertOpen();
        this.sweep(now);
        this.assertFits(bytes, day, ipHash, live, true);
        this.all('INSERT INTO reservations (id, bytes, created_at, ip_hash, running, live_hash) VALUES (?, ?, ?, ?, 1, ?)', id, bytes, now, ipHash, live);
        this.total('active', 1);
        this.daily(day, { uploads: 1 });
        this.networks(ipHash, day, { uploads: 1, active: 1 });
        this.lived(live, { uploads: 1 });
      });
      const nextAlarm = await this.ctx.storage.getAlarm();
      if (nextAlarm === null || nextAlarm > now + DAY_MS)
        await this.ctx.storage.setAlarm(now + DAY_MS);
      return true;
    });
  }

  /**
   * Reserves `bytes` for one admitted attempt of a part before R2 may receive them: `slot` is its R2 part number,
   * `ticket` the attempt and `network` today's hash of the network sending it. Asking again for the same attempt
   * changes nothing; a slot handed out again (its old attempt settled or its lease ended) replaces the old row.
   * Every attempt asks, so a pause also blocks re-uploads of confirmed parts.
   */
  async reservePart(id: string, part: number, slot: number, ticket: string, bytes: number, network: string) {
    return guarded(() => {
      const now = Date.now(), day = dayOf(now);
      this.ctx.storage.transactionSync(() => {
        const row = this.all<{ bytes: number; active: number; live_hash: string | null }>('SELECT bytes, active, live_hash FROM reservations WHERE id = ?', id)[0];
        if (!row?.active) throw new ApiError(409, 'This upload reservation is closed.');
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > row.bytes) throw new ApiError(400, 'The upload exceeds its declared size.');
        // The sweep first: a row it ends must not be read here and then released a second time.
        this.sweep(now);
        const existing = this.all<Pending>('SELECT * FROM pending WHERE id = ? AND part = ? AND slot = ?', id, part, slot)[0];
        if (existing?.ticket === ticket) return;
        this.assertOpen();
        if (existing) this.unpend(existing, row.live_hash);
        // The day's bytes count for the network sending them, the stored ones for the network that admitted the upload.
        this.assertFits(bytes, day, network, row.live_hash);
        this.all('INSERT INTO pending (id, part, slot, ticket, bytes, day, network, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, part, slot, ticket, bytes, day, network, now);
        this.total('reserved', bytes);
        this.daily(day, { reserved: bytes, attempted: bytes });
        this.networks(network, day, { reserved: bytes });
        this.lived(row.live_hash, { bytes });
      });
      return true;
    });
  }

  /**
   * R2 stored the attempt in `slot`: its reserved bytes become the upload's stored payload, or a copy if R2 holds the
   * part in another slot already, charged to the day and network that reserved them. Bytes written over a copy in
   * the same slot add nothing. Repeating it changes nothing. True if the bytes counted as payload now. An attempt
   * whose lease ended reserves nothing any more: it is refused (503 lease_expired), and the client sends it again.
   */
  async confirmPart(id: string, part: number, slot: number, ticket: string) {
    return guarded(() => this.ctx.storage.transactionSync(() => {
      const pending = this.all<Pending>('SELECT * FROM pending WHERE id = ? AND part = ? AND slot = ? AND ticket = ?', id, part, slot, ticket)[0];
      const row = this.all<{ bytes: number; used: number; active: number; live_hash: string | null }>('SELECT bytes, used, active, live_hash FROM reservations WHERE id = ?', id)[0];
      if (pending) this.unpend(pending, row?.active ? row.live_hash : null);
      // Released meanwhile: its cleanup removes the bytes.
      if (!row?.active) return false;
      const held = this.all<{ slot: number }>('SELECT slot FROM confirmed WHERE id = ? AND part = ?', id, part);
      if (held.some(copy => copy.slot === slot)) return false;
      if (!pending) throw new ApiError(503, 'This part took too long. Please send it again.', 'lease_expired');
      this.all('INSERT INTO confirmed (id, part, slot) VALUES (?, ?, ?)', id, part, slot);
      if (held.length) {
        this.all('UPDATE reservations SET copies = copies + ? WHERE id = ?', pending.bytes, id);
        this.total('copies', pending.bytes);
        this.daily(pending.day, { bytes: pending.bytes });
        this.networks(pending.network, pending.day, { bytes: pending.bytes });
        this.lived(row.live_hash, { bytes: pending.bytes });
        return false;
      }
      // Never charge more than the declared size, however many attempts a part took.
      const delta = Math.max(0, Math.min(pending.bytes, row.bytes - row.used));
      if (!delta) return true;
      this.all('UPDATE reservations SET used = used + ? WHERE id = ?', delta, id);
      this.total('used', delta);
      this.daily(pending.day, { bytes: delta });
      this.networks(pending.network, pending.day, { bytes: delta });
      this.lived(row.live_hash, { bytes: delta });
      return true;
    }));
  }

  /** R2 did not store the attempt (or its bytes are not needed): its reserved bytes are free again. Idempotent. */
  async releasePart(id: string, part: number, slot: number, ticket: string) {
    return guarded(() => this.ctx.storage.transactionSync(() => {
      const pending = this.all<Pending>('SELECT * FROM pending WHERE id = ? AND part = ? AND slot = ? AND ticket = ?', id, part, slot, ticket)[0];
      if (pending) this.unpend(pending);
      return true;
    }));
  }

  /**
   * The upload completed: it no longer runs for its network, and R2 dropped every copy the completion didn't name.
   * Idempotent. Without this call (a failure) the place is freed by the cleanup or once the network hash rotates.
   */
  async uploaded(id: string) {
    return guarded(() => this.ctx.storage.transactionSync(() => {
      const row = this.all<{ active: number; running: number; copies: number; created_at: number; ip_hash: string; live_hash: string | null }>(
        'SELECT active, running, copies, created_at, ip_hash, live_hash FROM reservations WHERE id = ?', id)[0];
      if (!row?.active) return false;
      if (row.running) this.all('UPDATE networks SET active = MAX(0, active - 1) WHERE network = ? AND day = ?', row.ip_hash, dayOf(row.created_at));
      this.total('copies', -row.copies);
      this.lived(row.live_hash, { bytes: -row.copies });
      this.all('UPDATE reservations SET running = 0, copies = 0 WHERE id = ?', id);
      return true;
    }));
  }

  /**
   * The upload's bytes are gone from R2: its stored payload, copies, pending attempts and slot among the active uploads
   * are free, and its stable network hash goes (the network's `live` row with its last upload). Idempotent.
   */
  async release(id: string) {
    return guarded(() => this.ctx.storage.transactionSync(() => {
      const row = this.all<{ used: number; copies: number; active: number; running: number; created_at: number; ip_hash: string; live_hash: string | null }>(
        'SELECT used, copies, active, running, created_at, ip_hash, live_hash FROM reservations WHERE id = ?', id)[0];
      if (!row?.active) return true;
      for (const pending of this.all<Pending>('SELECT * FROM pending WHERE id = ?', id)) this.unpend(pending, row.live_hash);
      this.all('UPDATE reservations SET active = 0, running = 0, copies = 0, live_hash = NULL WHERE id = ?', id);
      this.total('active', -1);
      this.total('used', -row.used);
      this.total('copies', -row.copies);
      if (row.running) this.all('UPDATE networks SET active = MAX(0, active - 1) WHERE network = ? AND day = ?', row.ip_hash, dayOf(row.created_at));
      this.lived(row.live_hash, { bytes: -(row.used + row.copies), uploads: -1 });
      if (row.live_hash) this.all('DELETE FROM live WHERE network = ? AND uploads <= 0', row.live_hash);
      this.all('DELETE FROM confirmed WHERE id = ?', id);
      return true;
    }));
  }

  /**
   * Recomputes the aggregates that rows prove (stored payload, copies and reserved bytes, active uploads, the stored
   * bytes per stable network hash, and for today and yesterday the admissions, running uploads and reserved bytes per
   * day and network) and fixes any difference, counted as budget_drift by
   * aggregate; returns the drift. Confirmed bytes per day and network are ledgers, like the daily volume always was: no rows prove them.
   */
  private reconcile(now: number, report = true) {
    const drift = new Map<string, number>();
    const off = (code: string, stored: number, actual: number) => {
      if (stored !== actual) drift.set(code, (drift.get(code) || 0) + Math.abs(actual - stored));
      return stored !== actual;
    };
    const live = this.all<{ used: number; copies: number; active: number }>(
      'SELECT COALESCE(SUM(used), 0) AS used, COALESCE(SUM(copies), 0) AS copies, COUNT(*) AS active FROM reservations WHERE active = 1')[0];
    const actual: Totals = { ...live, reserved: this.all<{ bytes: number }>('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM pending')[0].bytes };
    const totals = this.totals();
    for (const name of ['used', 'copies', 'reserved', 'active'] as const) if (off(name, totals[name], actual[name])) this.total(name, actual[name] - totals[name]);
    // Pending rows are at most a lease old after the sweep, so nothing older than yesterday can be off.
    const since = dayOf(now) - DAY_MS, days = new Map<number, { uploads: number; reserved: number }>();
    const nets = new Map<string, { network: string; day: number; uploads: number; active: number; reserved: number }>();
    const day = (key: number) => days.get(key) ?? days.set(key, { uploads: 0, reserved: 0 }).get(key) as { uploads: number; reserved: number };
    const net = (network: string, key: number) => nets.get(key + ':' + network)
      ?? nets.set(key + ':' + network, { network, day: key, uploads: 0, active: 0, reserved: 0 }).get(key + ':' + network) as { network: string; day: number; uploads: number; active: number; reserved: number };
    for (const row of this.all<{ day: number }>('SELECT day FROM daily WHERE day >= ?', since)) day(row.day);
    for (const row of this.all<{ network: string; day: number }>('SELECT network, day FROM networks WHERE day >= ?', since)) net(row.network, row.day);
    for (const row of this.all<{ day: number; network: string; uploads: number; active: number }>(
      `SELECT created_at / ${DAY_MS} * ${DAY_MS} AS day, ip_hash AS network, COUNT(*) AS uploads, SUM(active AND running) AS active FROM reservations WHERE created_at >= ? GROUP BY 1, 2`, since)) {
      day(row.day).uploads += row.uploads;
      Object.assign(net(row.network, row.day), { uploads: row.uploads, active: row.active });
    }
    for (const row of this.all<{ day: number; network: string; bytes: number }>('SELECT day, network, SUM(bytes) AS bytes FROM pending WHERE day >= ? GROUP BY 1, 2', since)) {
      day(row.day).reserved += row.bytes;
      net(row.network, row.day).reserved = row.bytes;
    }
    for (const [key, expected] of days) {
      const stored = this.today(key);
      if ([off('daily_uploads', stored.uploads, expected.uploads), off('daily_reserved', stored.reserved, expected.reserved)].includes(true))
        this.daily(key, { uploads: expected.uploads - stored.uploads, reserved: expected.reserved - stored.reserved });
    }
    for (const expected of nets.values()) {
      const stored = this.network(expected.network, expected.day);
      if (['uploads', 'active', 'reserved'].map(field => off('network_' + field, stored[field as 'uploads'], expected[field as 'uploads'])).includes(true))
        this.networks(expected.network, expected.day, { uploads: expected.uploads - stored.uploads, active: expected.active - stored.active, reserved: expected.reserved - stored.reserved });
    }
    // Stored bytes per stable network hash: the payload and copies of its active uploads and their pending attempts.
    const lives = new Map<string, { bytes: number; uploads: number }>();
    for (const row of this.all<{ network: string; bytes: number; uploads: number }>(
      'SELECT live_hash AS network, SUM(used + copies) AS bytes, COUNT(*) AS uploads FROM reservations WHERE active = 1 AND live_hash IS NOT NULL GROUP BY 1'))
      lives.set(row.network, { bytes: row.bytes, uploads: row.uploads });
    for (const row of this.all<{ network: string; bytes: number }>(
      'SELECT r.live_hash AS network, SUM(p.bytes) AS bytes FROM pending p JOIN reservations r ON r.id = p.id WHERE r.active = 1 AND r.live_hash IS NOT NULL GROUP BY 1')) {
      const entry = lives.get(row.network);
      if (entry) entry.bytes += row.bytes;
    }
    for (const stored of this.all<{ network: string; bytes: number; uploads: number }>('SELECT network, bytes, uploads FROM live')) {
      const expected = lives.get(stored.network) ?? { bytes: 0, uploads: 0 };
      lives.delete(stored.network);
      if ([off('network_stored', stored.bytes, expected.bytes), off('network_stored_uploads', stored.uploads, expected.uploads)].includes(true))
        this.lived(stored.network, { bytes: expected.bytes - stored.bytes, uploads: expected.uploads - stored.uploads });
      if (!expected.uploads) this.all('DELETE FROM live WHERE network = ?', stored.network);
    }
    for (const [network, expected] of lives) {
      off('network_stored', 0, expected.bytes); off('network_stored_uploads', 0, expected.uploads);
      this.lived(network, expected);
    }
    if (report) for (const [code, amount] of drift) metric(this.env, 'budget_drift', code, amount);
    return Object.fromEntries(drift);
  }

  /**
   * Operator (POST /api/admin/reconcile): what the alarm does, now: the sweep and reconciliation (`drift`, what it fixed by
   * aggregate) and the cleanup reconciler (`cleanups`, reconcileCleanups()).
   */
  async reconcileNow() {
    return guarded(async () => {
      const drift = this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        this.sweep(now, 100000);
        return this.reconcile(now);
      });
      return { drift, cleanups: await this.reconcileCleanups() };
    });
  }

  /**
   * The cleanup reconciler: a reservation still active an hour after its transfer must have closed (OVERDUE_MS, the
   * `overdueCleanups` of status()) means that transfer's cleanup never ran or never reached release(). Each one's
   * Transfer runs its alarm now (closing and cleaning what is due); one with no record left, or one that is clean
   * already, is released here: its bytes are gone from R2 or go with the bucket's lifecycle rule. Counted as
   * `cleanup_reconciled` by what was found (`rearmed`, `released`, `failed`); at most 50 a run, the least recently tried
   * first (`reconciled`).
   */
  private async reconcileCleanups() {
    const counts = { rearmed: 0, released: 0, failed: 0 };
    this.all('DELETE FROM reconciled WHERE id NOT IN (SELECT id FROM reservations WHERE active = 1)');
    // The ones never tried first, then the longest untried; oldest first among equals.
    const overdue = this.all<{ id: string }>(`SELECT r.id FROM reservations r LEFT JOIN reconciled c ON c.id = r.id
      WHERE r.created_at < ? AND r.active = 1 ORDER BY COALESCE(c.at, 0), r.created_at LIMIT 50`, Date.now() - OVERDUE_MS);
    for (const { id } of overdue) {
      this.all('INSERT INTO reconciled (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at', id, Date.now());
      let outcome: keyof typeof counts;
      try {
        const found = unwrap(await this.env.TRANSFERS.getByName(id).reconcileCleanup(id));
        if (found === 'gone') { unwrap(await this.release(id)); outcome = 'released'; } else outcome = 'rearmed';
      } catch { outcome = 'failed'; }
      counts[outcome]++;
      metric(this.env, 'cleanup_reconciled', outcome);
    }
    if (overdue.length) console.log(JSON.stringify({ event: 'cleanup_reconciled', ...counts }));
    return counts;
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sweep(now, 100000);
      this.reconcile(now);
      this.all('DELETE FROM reservations WHERE active = 0 AND created_at < ?', now - 30 * DAY_MS);
      this.all('DELETE FROM daily WHERE day < ?', now - 30 * DAY_MS);
      // Only today's network counts are ever checked; yesterday's stay for the reconciliation.
      this.all('DELETE FROM networks WHERE day < ? AND reserved = 0', dayOf(now) - DAY_MS);
    });
    // The next run is set first: the reconciler calls other objects and must never keep the daily sweep from coming back.
    if (this.all<{ count: number }>('SELECT COUNT(*) AS count FROM reservations')[0].count)
      await this.ctx.storage.setAlarm(now + DAY_MS);
    try { await this.reconcileCleanups(); } catch (error) { console.error(JSON.stringify({ event: 'cleanup_reconcile_failed', error: error instanceof Error ? error.name : 'unknown' })); }
  }
}
