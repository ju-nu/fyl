(() => {
  'use strict';
  // A folder as one file: the deterministic, uncompressed ZIP/ZIP64 of docs/FOLDER-ZIP.md (profile fyl-folder-zip-1),
  // which binds this page and the CLI to the bytes of tests/vectors/folder-zip/ (scripts/folder_zip.py is the
  // reference). Everything but the CRCs follows from the paths and sizes, so the size is known before a byte is read,
  // and the zip is a File composed of header bytes and the folder's own Files: the upload reads any part of it by offset,
  // again on a resume, without copying the data. The CRCs come from the pre-pass (crcFiles() in e2ee/jobs.js).
  const U16 = 0xFFFF, U32 = 0xFFFFFFFF, T_MIN = 315532800, T_MAX = 2147483647, MODE = 0o100644;
  const MAX_ENTRIES = 100000, MAX_PATH = 4095, MAX_NAME = 255;
  // The server's rule for file names (src/index.ts, upload init): bidi controls are dropped, the rest is refused (§2.3).
  const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, UNSAFE = /[\p{Cc}\u2028\u2029/\\]/u;
  const encoder = new TextEncoder(), strict = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  const utf8 = text => encoder.encode(text);
  // §2.4: bytewise order of the UTF-8 paths. JS strings compare UTF-16 code units, which put U+1F600 before U+FF5E.
  const compare = (a, b) => {
    for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  // A skipped item's path below the root as bytes, for its order (the names it can't be shown by stay as they came).
  const raw = parts => {
    const chunks = parts.map(part => typeof part === 'string' ? utf8(part) : part), out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length + 1, -1));
    let at = 0;
    for (const chunk of chunks) { if (at) out[at - 1] = 0x2F; out.set(chunk, at); at += chunk.length + 1; }
    return out;
  };

  /** §2.3: one path component as the platform gives it (a string, or bytes) → its name in the zip, or null to skip it. */
  function clean(name) {
    if (typeof name !== 'string') { try { name = strict.decode(name); } catch { return null; } }
    if (/\p{Cs}/u.test(name)) return null; // a lone surrogate
    name = name.replace(BIDI, '');
    return /^[. ]*$/.test(name) || UNSAFE.test(name) || utf8(name).length > MAX_NAME ? null : name;
  }
  /** §5.1: whole seconds, rounded down, clamped to what both DOS time and a signed 32-bit UT field hold. */
  const seconds = ms => Number.isFinite(ms) ? Math.min(Math.max(Math.floor(ms / 1000), T_MIN), T_MAX) : T_MIN;

  /**
   * §2: the folder named `root` from what a walk found, `items` [{parts (path components below the root, strings or
   * bytes), kind: file, dir, symlink or special, size, mtimeMs, file}] (a browser lists only files and folders).
   * Returns {root, entries in zip order [{path, bytes, size, mtime, file}], skipped [{parts, reason}] in bytewise order},
   * a skipped folder listed once for everything under it: one whose name is skipped, or whose path leaves no room for
   * "/" and a name (§2.3).
   */
  function gather(root, items) {
    root = clean(root) || 'folder';
    const entries = [], skipped = new Map();
    const skip = (parts, reason) => { const bytes = raw(parts), key = bytes.join(); if (!skipped.has(key)) skipped.set(key, {parts, bytes, reason}); };
    for (const {parts, kind = 'file', size = 0, mtimeMs = 0, file = null} of items) {
      if (!parts.length) continue;
      let path = root, length = utf8(root).length, safe = true;
      for (let i = 0; i < parts.length && safe; i++) {
        if (i === parts.length - 1 && (kind === 'symlink' || kind === 'special')) { skip(parts, kind); safe = false; break; }
        const name = clean(parts[i]), folder = kind === 'dir' || i < parts.length - 1;
        if (name !== null) { path += '/' + name; length += 1 + utf8(name).length; }
        if (name === null || (folder && length + 2 > MAX_PATH)) { skip(parts.slice(0, i + 1), 'name'); safe = false; }
      }
      if (!safe || kind !== 'file') continue;
      const bytes = utf8(path);
      if (bytes.length > MAX_PATH) skip(parts, 'name');
      else entries.push({path, bytes, size, mtime: seconds(mtimeMs), file});
    }
    entries.sort((a, b) => compare(a.bytes, b.bytes));
    return {root, entries, skipped: [...skipped.values()].sort((a, b) => compare(a.bytes, b.bytes)).map(({parts, reason}) => ({parts, reason}))};
  }

  /** §6: everything but the CRCs, from the paths and sizes alone. */
  function layout(entries) {
    const rows = [];
    let offset = 0, central = 0;
    for (const entry of entries) {
      const n = entry.bytes.length, large = entry.size >= U32, far = offset >= U32, k = 2 * large + far;
      const row = {offset, local: 30 + n + 9 + 20 * large, central: 46 + n + 9 + (k ? 4 + 8 * k : 0), large, far};
      rows.push(row); offset += row.local + entry.size; central += row.central;
    }
    const zip64End = entries.length >= U16 || central >= U32 || offset >= U32;
    return {entries, rows, centralOffset: offset, centralSize: central, zip64End, size: offset + central + 22 + 76 * zip64End};
  }

  /** §2.6, in this order: throws {code: empty, too_many, collision or too_large, detail}; else the layout. */
  function check(entries, limit) {
    const refuse = (code, detail = '') => { throw Object.assign(new Error(code), {code, detail}); };
    if (!entries.length) refuse('empty');
    if (entries.length > MAX_ENTRIES) refuse('too_many', String(entries.length));
    // The first path the next one repeats, or that is also a folder of another entry ('a' and 'a/b').
    const folders = new Set();
    for (const {path} of entries) for (let at = path.indexOf('/'); at > 0; at = path.indexOf('/', at + 1)) folders.add(path.slice(0, at));
    entries.forEach(({path, bytes}, i) => { if ((i + 1 < entries.length && !compare(bytes, entries[i + 1].bytes)) || folders.has(path)) refuse('collision', path); });
    const out = layout(entries);
    if (out.size > limit) refuse('too_large', String(out.size));
    return out;
  }

  // 64-bit fields as two 32-bit halves: every value stays below 2^53, and bit operators would be 32-bit signed.
  const u64 = (view, at, value) => { view.setUint32(at, value % 4294967296, true); view.setUint32(at + 4, Math.floor(value / 4294967296), true); };
  const dos = t => {
    const d = new Date(t * 1000);
    return [d.getUTCHours() << 11 | d.getUTCMinutes() << 5 | d.getUTCSeconds() >> 1, (d.getUTCFullYear() - 1980) << 9 | (d.getUTCMonth() + 1) << 5 | d.getUTCDate()];
  };
  // §3.1 and §3.2 into `view` at `at`; each returns where it ended.
  function localHeader(view, at, entry, row, crc) {
    const [time, date] = dos(entry.mtime), size = row.large ? U32 : entry.size, n = entry.bytes.length;
    view.setUint32(at, 0x04034B50, true); view.setUint16(at + 4, row.large || row.far ? 45 : 20, true); view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true); view.setUint16(at + 10, time, true); view.setUint16(at + 12, date, true); view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, size, true); view.setUint32(at + 22, size, true); view.setUint16(at + 26, n, true); view.setUint16(at + 28, row.large ? 29 : 9, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 30, n).set(entry.bytes);
    at += 30 + n;
    if (row.large) { view.setUint16(at, 0x0001, true); view.setUint16(at + 2, 16, true); u64(view, at + 4, entry.size); u64(view, at + 12, entry.size); at += 20; }
    return stamp(view, at, entry.mtime);
  }
  function centralHeader(view, at, entry, row, crc) {
    const [time, date] = dos(entry.mtime), fields = [...(row.large ? [entry.size, entry.size] : []), ...(row.far ? [row.offset] : [])];
    const version = fields.length ? 45 : 20, size = row.large ? U32 : entry.size, n = entry.bytes.length;
    view.setUint32(at, 0x02014B50, true); view.setUint16(at + 4, 0x0300 | version, true); view.setUint16(at + 6, version, true); view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true); view.setUint16(at + 12, time, true); view.setUint16(at + 14, date, true); view.setUint32(at + 16, crc, true);
    view.setUint32(at + 20, size, true); view.setUint32(at + 24, size, true); view.setUint16(at + 28, n, true);
    view.setUint16(at + 30, 9 + (fields.length ? 4 + 8 * fields.length : 0), true); view.setUint32(at + 32, 0, true); view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, MODE * 65536, true); view.setUint32(at + 42, row.far ? U32 : row.offset, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 46, n).set(entry.bytes);
    at += 46 + n;
    if (fields.length) {
      view.setUint16(at, 0x0001, true); view.setUint16(at + 2, 8 * fields.length, true);
      fields.forEach((value, i) => u64(view, at + 4 + 8 * i, value));
      at += 4 + 8 * fields.length;
    }
    return stamp(view, at, entry.mtime);
  }
  // §3.3: the extended timestamp, mtime only.
  function stamp(view, at, t) {
    view.setUint16(at, 0x5455, true); view.setUint16(at + 2, 5, true); view.setUint8(at + 4, 1); view.setUint32(at + 5, t, true);
    return at + 9;
  }
  // §3.4.
  function endRecords(view, at, out) {
    let count = out.entries.length, size = out.centralSize, offset = out.centralOffset;
    if (out.zip64End) {
      view.setUint32(at, 0x06064B50, true); u64(view, at + 4, 44); view.setUint16(at + 12, 0x032D, true); view.setUint16(at + 14, 45, true);
      view.setUint32(at + 16, 0, true); view.setUint32(at + 20, 0, true); u64(view, at + 24, count); u64(view, at + 32, count); u64(view, at + 40, size); u64(view, at + 48, offset);
      view.setUint32(at + 56, 0x07064B50, true); view.setUint32(at + 60, 0, true); u64(view, at + 64, offset + size); view.setUint32(at + 72, 1, true);
      at += 76; count = U16; size = U32; offset = U32;
    }
    view.setUint32(at, 0x06054B50, true); view.setUint32(at + 4, 0, true); view.setUint16(at + 8, count, true); view.setUint16(at + 10, count, true);
    view.setUint32(at + 12, size, true); view.setUint32(at + 16, offset, true); view.setUint16(at + 20, 0, true);
    return at + 22;
  }

  /**
   * The zip in stream order: {bytes} (header bytes, adjacent ones merged) and {entry: i, size} (entry i's data), as
   * the vectors' segments list them. All header bytes share one buffer, as long as the zip minus its data.
   */
  function segments(out, crcs) {
    const data = out.entries.reduce((sum, entry) => sum + entry.size, 0), buffer = new Uint8Array(out.size - data), view = new DataView(buffer.buffer);
    const list = [];
    let at = 0, from = 0;
    out.entries.forEach((entry, i) => {
      at = localHeader(view, at, entry, out.rows[i], crcs[i]);
      if (entry.size) { list.push({bytes: buffer.subarray(from, at)}, {entry: i, size: entry.size}); from = at; }
    });
    out.entries.forEach((entry, i) => { at = centralHeader(view, at, entry, out.rows[i], crcs[i]); });
    list.push({bytes: buffer.subarray(from, endRecords(view, at, out))});
    return list;
  }
  /** The zip as a File named `<root>.zip`: header bytes and the entries' own Files, which the browser reads when sent. */
  const file = (root, out, crcs) => new File(segments(out, crcs).map(part => part.bytes || out.entries[part.entry].file), root + '.zip', {type: 'application/zip'});
  /** Each entry's data in the zip, [start, end) by zip offset, for the check of the bytes sent (§7.3). */
  const dataRanges = out => out.entries.map((entry, i) => [out.rows[i].offset + out.rows[i].local, out.rows[i].offset + out.rows[i].local + entry.size]);

  /** §9: F, 22 characters, over the entries' paths, sizes and times. */
  async function fingerprint(entries) {
    const lines = entries.map(entry => [entry.bytes, utf8('\0' + entry.size + '\0' + entry.mtime + '\n')]);
    const parts = [utf8('fyl-folder-zip-1\n'), ...lines.flat()], message = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    parts.reduce((at, part) => { message.set(part, at); return at + part.length; }, 0);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', message)).subarray(0, 16);
    return btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }

  window.FylZip = {MAX_ENTRIES, MAX_PATH, clean, seconds, gather, layout, check, segments, file, dataRanges, fingerprint};
})();
