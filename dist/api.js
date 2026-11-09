(() => {
  'use strict';
  const PART = 50 * 1024 * 1024;
  // Messages in the page's language (dist/i18n.js, loaded first); the server's own errors stay English, and the page
  // translates them by code.
  const say = (key, vars) => window.FylText ? window.FylText.t(key, vars) : key;
  const percent = value => window.FylText ? window.FylText.percent(value) : value + ' %';
  // Error classes shared with the server and the CLI (tests/vectors/errors.json). 'retry' is tried again and leaves
  // the upload resumable, 'permanent' ends it; status 0 is a dropped connection. Like the CLI, every 5xx retries. A few
  // codes are permanent whatever their status: `part_limit`, and `password_paused` (a 429 that waits out a pause).
  const classify = (status, code) => code === 'part_limit' || code === 'password_paused' ? 'permanent' : [0, 408, 429].includes(status) || status >= 500 ? 'retry' : 'permanent';
  // Exponential backoff with ±20 % jitter; a Retry-After in seconds is honoured up to 60 s.
  const backoff = (attempt, retryAfter) => {
    const seconds = Number(retryAfter);
    return seconds > 0 ? Math.min(60, seconds) * 1000 : 1000 * 2 ** attempt * (0.8 + Math.random() * 0.4);
  };
  const aborted = () => new DOMException(say('home.api.cancelled'), 'AbortError');
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, ms);
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const object = body => !!body && typeof body === 'object' && !Array.isArray(body);
  function failure(status, body, message) {
    const error = new Error(body?.error || message || say('home.api.failed'));
    error.status = status; error.code = body?.code; error.kind = classify(status, body?.code); return error;
  }
  // A 2xx answer whose body is unreadable or fails `valid` is 'unclear': it may have worked, so it is asked again. Every
  // request here may be repeated: init carries its Idempotency-Key, completion and status are idempotent.
  const unclear = status => Object.assign(failure(status, null, say('home.api.unclear')), { kind: 'unclear' });
  async function request(path, { method = 'GET', data, key, signal, headers = {}, retries = 3, valid = object } = {}) {
    let last;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (last) await pause(backoff(attempt - 1, last.retryAfter), signal);
      let response, text = null, body = null;
      try {
        response = await fetch(path, {
          method, signal, cache: 'no-store', credentials: 'omit',
          headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}),
            ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
          ...(data ? { body: JSON.stringify(data) } : {}),
        });
        text = await response.text();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        // Dropped before an answer arrived; one that broke off while its body was read goes on with no body.
        if (!response) { last = failure(0, null, say('home.api.interrupted')); continue; }
      }
      try { body = JSON.parse(text); } catch {}
      if (response.ok) {
        if (valid(body)) return body;
        last = unclear(response.status); continue;
      }
      last = failure(response.status, object(body) ? body : null);
      last.retryAfter = response.headers.get('Retry-After');
      if (last.kind === 'permanent') throw last;
    }
    throw last;
  }
  // What makes an answer to /api/upload/complete a receipt. The site always completes with the management key, so the
  // management link has to be there as well.
  const RECEIPT_URL = /^https?:\/\/[^/]+\/d\/[A-Za-z0-9_-]{43,64}(\/[^?#]*)?$/;
  // An encrypted upload's receipt also names the mode, no name, the stored size and exactly `<origin>/d/<ID>` (docs/E2EE.md
  // §7 step 5). One that differs only in its link stops the upload: the key never goes with a link the server chose.
  const validReceipt = (body, uploadId, size, e2ee = false) => object(body) && typeof body.url === 'string' && RECEIPT_URL.test(body.url)
    && body.transferId === uploadId && Number.isFinite(body.expiresAt) && body.size === size && typeof body.managementUrl === 'string'
    && (!e2ee || (body.mode === 'e2ee' && body.name === null && body.url === location.origin + '/d/' + uploadId));
  const foreignReceipt = (body, uploadId) => object(body) && body.transferId === uploadId && typeof body.url === 'string'
    && body.url !== location.origin + '/d/' + uploadId;
  const statusOf = (session, signal) => request('/api/upload/status?uploadId=' + encodeURIComponent(session.uploadId),
    { key: session.key, signal, valid: body => object(body) && typeof body.status === 'string' && Array.isArray(body.parts) });
  // Completing is idempotent, so a lost or garbled answer is asked for again; if that keeps failing, the upload's
  // status tells whether the server finished it, and then it is asked once more. Whatever stays unclear leaves the
  // session for a resume, which replays the completion.
  async function complete(session, parts, size, signal, e2ee = false) {
    const ask = () => request('/api/upload/complete', { method: 'POST', signal, retries: 5,
      data: { uploadId: session.uploadId, key: session.key, parts }, valid: body => {
        if (e2ee && foreignReceipt(body, session.uploadId)) throw Object.assign(failure(200, null, URL_MISMATCH), { kind: 'permanent', code: 'url_mismatch', noAbort: true });
        return validReceipt(body, session.uploadId, size, e2ee);
      } });
    try { return await ask(); }
    catch (error) {
      if (error.name === 'AbortError' || error.kind === 'permanent') throw error;
      const state = await statusOf(session, signal).catch(() => null);
      if (!['ready', 'completing'].includes(state?.status)) throw error;
      return await ask();
    }
  }
  // A part may take as long as the uplink needs (a 50 MiB part takes 7 minutes at 1 Mbit/s). Only a request that sends
  // nothing for STALL counts as dropped, and is retried like a network error.
  const STALL = 120000;
  function uploadPart(session, partNumber, blob, signal, progress, contentMd5 = '') {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(aborted()); return; }
      const xhr = new XMLHttpRequest();
      let stalled = false, timer;
      const watch = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; xhr.abort(); }, STALL); };
      const cancel = () => xhr.abort();
      const dropped = () => reject(failure(0, null, say('home.api.interrupted')));
      xhr.open('PUT', '/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber }));
      xhr.setRequestHeader('Authorization', 'Bearer ' + session.key);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Accept', 'application/json');
      if (contentMd5) xhr.setRequestHeader('Content-MD5', contentMd5);
      xhr.upload.onprogress = event => { watch(); progress(event.loaded); };
      xhr.onload = () => {
        let body = null; try { body = JSON.parse(xhr.responseText); } catch {}
        const ok = xhr.status >= 200 && xhr.status < 300;
        if (ok && typeof body?.etag === 'string' && body.etag) resolve({ partNumber, etag: body.etag });
        else if (ok) reject(unclear(xhr.status));
        else reject(Object.assign(failure(xhr.status, object(body) ? body : null), { retryAfter: xhr.getResponseHeader('Retry-After') }));
      };
      xhr.onerror = dropped;
      xhr.onabort = () => { if (stalled) dropped(); else reject(aborted()); };
      xhr.onloadend = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      signal.addEventListener('abort', cancel, { once: true });
      watch(); xhr.send(blob);
    });
  }
  // A resume reads every finished part again and compares its MD5 with R2's ETag for it, as the CLI does: a file edited
  // in the middle keeps its name, size, date and fingerprint. Parts that differ, whose ETag is no MD5 (the local R2
  // simulator's) or that couldn't be checked are uploaded again. Workers do the hashing, so the page stays responsive.
  const MD5 = /^"?([0-9a-f]{32})"?$/i;
  function hashPart(worker, blob, signal, progress) {
    return new Promise((resolve, reject) => {
      const stop = () => { worker.terminate(); reject(aborted()); };
      const done = hash => { signal.removeEventListener('abort', stop); resolve(hash); };
      worker.onmessage = ({ data }) => { if ('hash' in data) done(data.hash); else progress(data.read); };
      worker.onerror = () => done(null);
      signal.addEventListener('abort', stop, { once: true });
      worker.postMessage(blob);
    });
  }
  async function verify(file, parts, signal, onProgress) {
    const bytes = number => Math.min(PART, file.size - (number - 1) * PART);
    const jobs = parts.filter(part => Number.isSafeInteger(part.partNumber) && part.partNumber > 0 && (part.partNumber - 1) * PART < file.size && MD5.test(part.etag));
    if (!jobs.length) return [];
    const total = jobs.reduce((sum, part) => sum + bytes(part.partNumber), 0), read = new Map(), kept = [];
    const report = () => onProgress(null, say('home.api.checking', { percent: percent(Math.floor([...read.values()].reduce((a, b) => a + b, 0) / total * 100)) }), undefined, 'checking');
    let next = 0;
    const run = async () => {
      let worker;
      try { worker = new Worker('/md5-worker.js'); } catch { return; }
      try {
        while (next < jobs.length) {
          const part = jobs[next++], start = (part.partNumber - 1) * PART;
          const hash = await hashPart(worker, file.slice(start, start + bytes(part.partNumber)), signal, value => { read.set(part.partNumber, value); report(); });
          if (hash === null) return; // this worker failed: its remaining parts stay unverified
          if (hash === MD5.exec(part.etag)[1].toLowerCase()) kept.push(part);
          read.set(part.partNumber, bytes(part.partNumber)); report();
        }
      } finally { worker.terminate(); }
    };
    report();
    await Promise.all(Array.from({ length: Math.min(jobs.length, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))) }, run));
    return kept;
  }
  // Errors other than permanent ones keep the session so the upload can resume. A refusal ('refused': the file changed,
  // a resume that can't be checked) stops without calling abort and keeps the upload for a resume (docs/E2EE.md §8.4).
  // An encrypted upload whose record another tab's upload replaced ('replaced') is handed back like an interrupted
  // one, so the page treats it as 2.3.0 treats a replaced interrupted upload: it discards the session.
  const resumable = error => error.name !== 'AbortError' && error.kind !== 'permanent' && error.kind !== 'refused';
  const newClientKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const idempotencyKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const validSession = body => object(body) && typeof body.uploadId === 'string' && typeof body.key === 'string' && typeof body.url === 'string';

  // End-to-end encryption (docs/E2EE.md §7, §8). The core (dist/e2ee/) and the part builder are ES modules, loaded
  // only for an encrypted upload. At most two parts are in flight, each built and hashed in its own dedicated worker
  // into one immutable Blob, which every retry of that part sends again.
  const E2EE_LANES = 2;
  const URL_MISMATCH = say('home.api.urlMismatch');
  const FILE_CHANGED = say('home.api.fileChanged');
  const UNSAFE_RESUME = say('home.api.unsafeResume');
  const REPLACED = say('home.replaced');
  const FOLDER_CHANGED = say('home.api.folderChanged');
  const loadCore = () => import('./e2ee/age.js');
  const stop = (message, code, kind = 'refused') => Object.assign(new Error(message), { code, kind });
  // A failure of the core: the file changed, a key that doesn't fit, a browser without the crypto it needs.
  const refusal = error => error?.code === 'file_changed' ? stop(FILE_CHANGED, 'file_changed')
    : error?.code === 'key_wrong' || error?.code === 'key_invalid' ? stop(say('home.api.keyWrong'), error.code)
    : error?.code === 'platform' ? stop(say('home.api.platform'), 'platform', 'permanent')
    : stop(UNSAFE_RESUME, error?.code || 'failed');
  // One lane per part in flight, with its own dedicated module worker; where none starts, the page builds the part.
  function lane(transfer) {
    let worker = null, calls = 0;
    const waiting = new Map(), inline = (file, part, spans) => import('./e2ee/jobs.js').then(jobs => jobs.buildPart(transfer, file, part, spans));
    try {
      worker = new Worker('/e2ee/worker.js', { type: 'module' });
      worker.onmessage = ({ data }) => { const answer = waiting.get(data?.id); if (answer) { waiting.delete(data.id); answer(data); } };
      worker.onerror = () => { worker = null; for (const answer of waiting.values()) answer({ error: 'worker' }); waiting.clear(); };
    } catch { worker = null; }
    return {
      async build(file, part, signal, spans = null) {
        if (signal.aborted) throw aborted();
        let answer;
        try {
          answer = !worker ? await inline(file, part, spans) : await new Promise((resolve, reject) => {
            const id = ++calls, cancel = () => { waiting.delete(id); reject(aborted()); };
            signal.addEventListener('abort', cancel, { once: true });
            waiting.set(id, data => { signal.removeEventListener('abort', cancel); resolve(data); });
            worker.postMessage({ job: 'part', id, transfer, file, part, spans });
          });
          if (answer.error === 'worker') answer = await inline(file, part, spans);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw refusal(error?.name === 'NotReadableError' ? { code: 'file_changed' } : error);
        }
        if (answer.error) throw refusal({ code: answer.error });
        return answer;
      },
      close() { worker?.terminate(); },
    };
  }
  // `records` keeps the MD5 of every part in this browser's pending-upload entry (§8.2): get(uploadId) gives them,
  // put(uploadId, part, md5) stores one and says whether that worked. `folder` ({ranges, crcs}) marks a folder zip:
  // each entry's data range in the zip and its CRC from the pre-pass (docs/FOLDER-ZIP.md §7.3).
  async function uploadEncrypted(file, { minutes, once, password, records, folder }, controller, onProgress, resume, onSession) {
    const signal = controller.signal, core = await loadCore();
    if (!await core.supported()) throw stop(say('home.api.platform'), 'platform', 'permanent');
    let session = resume || null, lanes = [];
    // What this run knows of each part's MD5: the server's pins, the local record, earlier attempts.
    const pins = new Map(), tried = new Map(), recorded = new Set(), local = () => records?.get(session.uploadId) || {};
    try {
      let finished = [], replay = false, key, head, name;
      if (session) {
        const state = await statusOf(session, signal);
        if (!['uploading', 'completing', 'ready'].includes(state.status))
          throw Object.assign(failure(410, { error: say('home.api.stale') }), { stale: true });
        // §8.4 step 1: only a status that names the mode, head, meta and pins can be checked; an older server can't.
        if (state.mode !== 'e2ee' || !object(state.e2ee) || !Array.isArray(state.pins)) throw stop(UNSAFE_RESUME, 'resume_unsafe');
        key = session.e2eeKey;
        let checked;
        try { checked = await core.checkKey(key, core.decodeBlob(state.e2ee.head), core.decodeBlob(state.e2ee.meta), state.size); }
        catch (error) { throw refusal(error); }
        if (checked.size !== file.size || core.ciphertextSize(file.size) !== state.size) throw stop(FILE_CHANGED, 'file_changed');
        head = state.e2ee.head; name = checked.name;
        replay = state.status !== 'uploading'; finished = state.parts;
        for (const pin of state.pins) if (Number.isSafeInteger(pin?.partNumber) && /^[0-9a-f]{32}$/.test(pin?.md5)) pins.set(pin.partNumber, pin.md5);
      } else {
        const prepared = await core.prepareUpload(file.name, file.size, { maxFileBytes: window.FYL_CONFIG?.maxFileBytes || core.MAX_FILE_BYTES });
        key = prepared.key; head = core.encodeBlob(prepared.head); name = prepared.name;
        // No file name: it is inside the encrypted metadata (§12.1). Retries resend this exact body.
        session = await request('/api/upload/init', { method: 'POST', signal, headers: { 'Idempotency-Key': idempotencyKey() },
          data: { mode: 'e2ee', size: prepared.ciphertextSize, e2ee: { head, meta: core.encodeBlob(prepared.meta) }, expiresIn: minutes * 60,
            oneTime: once, partSize: PART, clientKey: newClientKey(), ...(password ? { password } : {}) }, valid: validSession });
        // A server that ignores the mode would keep the file as raw: stop before any part (§7 step 2).
        if (session.mode !== 'e2ee') throw stop(say('home.api.modeMismatch'), 'mode_mismatch', 'permanent');
      }
      // §2.2: the keyed link is built here from this page's origin; the server's url must be <origin>/d/<ID> exactly.
      let share;
      try { share = core.shareLink(location.origin, session.uploadId, session.url, key); }
      catch { throw stop(URL_MISMATCH, 'url_mismatch', resume ? 'refused' : 'permanent'); }
      session = { ...session, e2eeKey: key, share };
      await onSession?.(session);
      const size = core.ciphertextSize(file.size), count = Math.ceil(size / PART), transfer = { key, head, size: file.size };
      const bytes = number => Math.min(PART, size - (number - 1) * PART);
      const loaded = new Array(count).fill(0), parts = new Array(count).fill(null);
      lanes = Array.from({ length: Math.min(E2EE_LANES, count) }, () => lane(transfer));
      // A folder zip's part also gives the CRC-32 of the entry bytes it encrypted, over the chunks that start in it, so
      // every byte counts once (a chunk on a part boundary is read by both parts). The latest build of each part counts.
      const { crc32Combine } = folder ? await import('./e2ee/crc32.js') : {}, seen = new Map();
      const spansOf = number => {
        const { start, end } = core.partRange(size, number, PART), ranges = folder.ranges;
        const first = number === 1 ? 0 : Math.ceil((start - core.H) / core.S), last = Math.min(core.chunkCount(file.size) - 1, Math.floor((end - 1 - core.H) / core.S));
        const lo = core.CHUNK * first, hi = Math.min(file.size, core.CHUNK * (last + 1)), spans = [], owners = [];
        let at = 0, top = ranges.length;
        while (at < top) { const mid = (at + top) >> 1; if (ranges[mid][1] <= lo) at = mid + 1; else top = mid; }
        for (; at < ranges.length && ranges[at][0] < hi; at++) {
          const from = Math.max(lo, ranges[at][0]), to = Math.min(hi, ranges[at][1]);
          if (from < to) { spans.push([from, to]); owners.push(at); }
        }
        return { spans, owners };
      };
      const build = async (builder, number) => {
        if (!folder) return builder.build(file, number, signal);
        const own = spansOf(number), built = await builder.build(file, number, signal, own.spans);
        seen.set(number, { ...own, crcs: built.crcs });
        return built;
      };
      // §7.3 before completing: each entry's pieces, in order, must cover its data and give its pre-pass CRC.
      const checkFolder = () => {
        const pieces = folder.ranges.map(() => []);
        for (const { spans, owners, crcs } of seen.values()) owners.forEach((index, k) => pieces[index].push([...spans[k], crcs?.[k]]));
        folder.ranges.forEach(([start, end], index) => {
          let at = start, crc = 0;
          for (const [from, to, piece] of pieces[index].sort((a, b) => a[0] - b[0])) {
            if (from !== at || !Number.isInteger(piece)) throw stop(FOLDER_CHANGED, 'file_changed');
            crc = crc32Combine(crc, piece, to - from); at = to;
          }
          if (at !== end || crc !== folder.crcs[index]) throw stop(FOLDER_CHANGED, 'file_changed');
        });
      };
      // Runs `job` for every part number in `numbers`, one at a time per lane.
      const each = (numbers, job) => {
        let next = 0;
        return Promise.all(lanes.slice(0, numbers.length).map(async builder => { while (next < numbers.length) await job(builder, numbers[next++]); }));
      };
      if (resume && !replay) {
        // §8.4 step 3: every pinned or confirmed part is rebuilt from the file as it is now and must equal its pin (or
        // its ETag where it has none) and this browser's record of it. Equal confirmed parts are kept.
        const confirmed = new Map(finished.filter(part => Number.isSafeInteger(part?.partNumber) && part.partNumber >= 1 && part.partNumber <= count)
          .map(part => [part.partNumber, part.etag]));
        const checks = [...new Set([...pins.keys(), ...confirmed.keys()])].filter(number => number >= 1 && number <= count).sort((a, b) => a - b);
        const total = checks.reduce((sum, number) => sum + bytes(number), 0);
        let done = 0;
        const report = () => onProgress(null, say('home.api.checking', { percent: percent(Math.floor(total ? done / total * 100 : 100)) }), undefined, 'checking');
        report();
        await each(checks, async (builder, number) => {
          const expected = pins.get(number) || MD5.exec(confirmed.get(number) || '')?.[1].toLowerCase();
          if (!expected) throw stop(UNSAFE_RESUME, 'resume_unsafe');
          const built = await build(builder, number);
          if (built.md5 !== expected || (local()[number] && local()[number] !== built.md5)) throw stop(FILE_CHANGED, 'file_changed');
          if (confirmed.has(number)) { parts[number - 1] = { partNumber: number, etag: confirmed.get(number) }; loaded[number - 1] = bytes(number); }
          done += bytes(number); report();
        });
      }
      const progress = () => {
        const total = loaded.reduce((a, b) => a + b, 0);
        onProgress(Math.min(99, Math.floor(total / size * 100)), say('home.api.uploading'), Math.round(total / size * file.size), 'uploading');
      };
      // §8.2 and §8.3 before every request of a part, retries too: compare its MD5 with all known for it, record it in
      // this browser, pin it, send it. Each retry sends the same Blob; a part is never rebuilt while in flight.
      async function send(number, built) {
        let corrupted = false;
        for (let attempt = 0; ; attempt++) {
          if ([pins.get(number), local()[number], tried.get(number)].some(md5 => md5 && md5 !== built.md5)) throw stop(FILE_CHANGED, 'file_changed');
          tried.set(number, built.md5);
          if (!recorded.has(number)) {
            const saved = await records?.put(session.uploadId, number, built.md5);
            // An upload started in another tab took the record's place: this one can't be resumed without it, so it
            // stops like an interrupted upload and the page, finding the record replaced, discards it.
            if (saved === 'replaced') throw stop(REPLACED, 'record_replaced', 'replaced');
            if (saved !== true)
              throw stop(say('home.api.recordFailed'), 'record_failed');
            recorded.add(number);
          }
          if (pins.get(number) !== built.md5) {
            await request('/api/upload/pin', { method: 'POST', signal, key: session.key, data: { uploadId: session.uploadId, partNumber: number, md5: built.md5 } });
            pins.set(number, built.md5);
          }
          try {
            return await uploadPart(session, number, built.blob, signal, sent => { loaded[number - 1] = sent; progress(); }, built.contentMd5);
          } catch (error) {
            if (error.name === 'AbortError' || error.kind === 'permanent') throw error;
            // A stored part that differs from its pin is sent again once; a second time leaves the upload resumable.
            if (error.code === 'part_corrupt') { if (corrupted) throw error; corrupted = true; }
            else if (attempt >= 2) throw error;
            loaded[number - 1] = 0;
            onProgress(null, say('home.api.retrying'), undefined, 'retrying');
            await pause(backoff(attempt, error.retryAfter), signal);
          }
        }
      }
      if (!replay) await each(parts.map((part, index) => part ? 0 : index + 1).filter(Boolean), async (builder, number) => {
        parts[number - 1] = await send(number, await build(builder, number));
      });
      if (folder && !replay) checkFolder();
      onProgress(99, say('home.api.creating'), undefined, 'creating');
      const receipt = await complete(session, replay ? finished.map(({ partNumber, etag }) => ({ partNumber, etag })) : parts, size, signal, true);
      // The receipt counts stored bytes; the sender's record keeps the file's own size.
      return { ...receipt, id: receipt.transferId, name, size: file.size, mode: 'e2ee', e2eeKey: key, state: receipt.state || 'ready', ownerKey: session.key };
    } catch (error) {
      controller.abort();
      if (error.code === 'part_changed') error.message = FILE_CHANGED;
      if (session && !error.stale && resumable(error)) { error.resumable = true; throw error; }
      // Only a permanent refusal (part_changed, a server that ignored the mode, a foreign link at init) or cancelling
      // ends the upload; a refusal of this run leaves it for a resume.
      if (session && error.kind === 'permanent' && !error.noAbort)
        await request('/api/upload/abort', { method: 'POST', data: { uploadId: session.uploadId, key: session.key }, retries: 1 }).catch(() => {});
      throw error;
    } finally {
      lanes.forEach(builder => builder.close());
    }
  }

  // A folder zip's CRC pre-pass (docs/FOLDER-ZIP.md §7.1), run by crcFiles() of e2ee/jobs.js in the E2EE part worker
  // (it needs no key), so the page stays responsive; where no module worker starts, on the page. onProgress(read) gets
  // the bytes read so far. A file that changed or can't be read rejects with code file_changed and its index.
  async function crcPass(files, signal, onProgress) {
    if (signal.aborted) throw aborted();
    let worker = null;
    try { worker = new Worker('/e2ee/worker.js', { type: 'module' }); } catch {}
    const answer = worker && await new Promise((resolve, reject) => {
      const cancel = () => { worker.terminate(); reject(aborted()); };
      const done = data => { worker.terminate(); signal.removeEventListener('abort', cancel); resolve(data); };
      worker.onmessage = ({ data }) => { if (data?.id === 1) { if ('read' in data) onProgress(data.read); else done(data); } };
      worker.onerror = () => done(null);
      signal.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ job: 'crc', id: 1, files });
    });
    if (answer?.crcs) return answer.crcs;
    if (answer?.error) throw Object.assign(new Error(answer.error), { code: answer.error, index: answer.index });
    const crcs = await (await import('./e2ee/jobs.js')).crcFiles(files, onProgress);
    if (signal.aborted) throw aborted();
    return crcs;
  }

  // The init response already carries the final link, so onSession lets the app show it while the parts upload.
  async function upload(file, options, controller, onProgress, resume, onSession) {
    if (options.e2ee) return uploadEncrypted(file, options, controller, onProgress, resume, onSession);
    const { minutes, once, password } = options, signal = controller.signal;
    let session = resume || null;
    try {
      let finished = [], replay = false;
      if (session) {
        const state = await statusOf(session, signal);
        if (!['uploading', 'completing', 'ready'].includes(state.status) || state.size !== file.size)
          throw Object.assign(failure(410, { error: say('home.api.stale') }), { stale: true });
        // A finished upload ('completing' or 'ready') only replays its completion.
        replay = state.status !== 'uploading';
        finished = state.parts;
      } else {
        session = await request('/api/upload/init', { method: 'POST', signal, headers: { 'Idempotency-Key': idempotencyKey() },
          data: { filename: file.name, size: file.size, expiresIn: minutes * 60, oneTime: once, partSize: PART, clientKey: newClientKey(), ...(password ? { password } : {}) },
          valid: validSession });
      }
      await onSession?.(session);
      if (resume && !replay) finished = await verify(file, finished, signal, onProgress);
      const count = Math.ceil(file.size / PART), loaded = new Array(count).fill(0), parts = new Array(count).fill(null);
      for (const part of finished) {
        if (!(part.partNumber >= 1 && part.partNumber <= count)) continue;
        parts[part.partNumber - 1] = { partNumber: part.partNumber, etag: part.etag };
        loaded[part.partNumber - 1] = Math.min(PART, file.size - (part.partNumber - 1) * PART);
      }
      const pending = replay ? [] : parts.map((part, index) => part ? -1 : index).filter(index => index >= 0);
      let next = 0;
      const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (next < pending.length) {
          const index = pending[next++], blob = file.slice(index * PART, Math.min(file.size, (index + 1) * PART));
          for (let attempt = 0; ; attempt++) {
            try {
              parts[index] = await uploadPart(session, index + 1, blob, signal, sent => {
                loaded[index] = sent;
                const total = loaded.reduce((a, b) => a + b, 0);
                onProgress(Math.min(99, Math.floor(total / file.size * 100)), say('home.api.uploading'), total, 'uploading');
              });
              break;
            } catch (error) {
              if (error.name === 'AbortError' || error.kind === 'permanent' || attempt === 2) throw error;
              loaded[index] = 0;
              onProgress(null, say('home.api.retrying'), undefined, 'retrying');
              await pause(backoff(attempt, error.retryAfter), signal);
            }
          }
        }
      });
      await Promise.all(workers);
      onProgress(99, say('home.api.creating'), undefined, 'creating');
      const receipt = await complete(session, replay ? finished.map(({ partNumber, etag }) => ({ partNumber, etag })) : parts, file.size, signal);
      return { ...receipt, id: receipt.transferId, name: receipt.name || file.name, state: receipt.state || 'ready', ownerKey: session.key };
    } catch (error) {
      controller.abort();
      if (session && !error.stale && resumable(error)) { error.resumable = true; throw error; }
      if (session) await request('/api/upload/abort', { method: 'POST', data: { uploadId: session.uploadId, key: session.key }, retries: 1 }).catch(() => {});
      throw error;
    }
  }
  // The server's rule (validPassword in src/shared.ts): 6 to 200 code points after NFC, none of them a control
  // character or a lone surrogate. Counting the raw text instead would refuse or allow different passwords.
  const validPassword = text => {
    const normal = String(text).normalize('NFC'), length = [...normal].length;
    return length >= 6 && length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(normal);
  };
  // Passwords offered for protected links: three of 256 short words and two digits, like tide-lamp-fern-41 (about 30
  // bits, against a link that pauses after 5 wrong tries). One random byte picks each word, so all are equally likely.
  const WORDS = 'acorn amber apple arch arrow atlas barn basil beach beam bean bear bell bench berry bird blue boat bolt bone book boot bowl brave bread brick brook brush cabin cake calm camel camp candy canoe cape cedar chalk chair chess cider clay cliff clock cloud coast coat cocoa comet coral corn cove crane crisp crow crown daisy dawn deer dome dove dream drift duck dune dusk eagle earth echo elm ember fable fern ferry field fig flag flame flint flock flute foam fog forge fox frog frost fruit gate giant glade glass globe glow goat gold grape grass grove gull harp hawk hazel heart hedge hill honey horn horse ice igloo iris iron ivory ivy jade jazz jelly jewel juice kayak kite kiwi knot lace lake lamp lark lava leaf lemon lily lime linen lion lodge loft lotus lunar mango maple marsh melon mint mist moon moose moss moth mouse nest nova oak oasis ocean olive onion opal orbit otter owl paint palm panda paper park path peach pearl piano pier pilot pine pixel plum poem polar pond pony prism quail quilt radio rain ranch raven reed reef ridge river robin rock rose ruby sage sail salt sand scarf seal seed shade shell shore silk sky sled slope snow solar spark spice spoon star stem stone storm sugar sun swan swift tent thorn tide tiger toast topaz torch tower train tree tulip tuna twig vapor vault verse vine viola wagon wave wheat whale wind wing wolf wood wool wren yacht yarn yolk zebra zest zinc zone'.split(' ');
  const passphrase = () => {
    const [number] = crypto.getRandomValues(new Uint32Array(1));
    return [...crypto.getRandomValues(new Uint8Array(3))].map(byte => WORDS[byte]).join('-') + '-' + String(number % 100).padStart(2, '0');
  };
  window.FylAPI = {
    upload, crcPass, passphrase, validPassword, classify, validReceipt,
    discard: session => request('/api/upload/abort', { method: 'POST', data: session, retries: 1 }).catch(() => {}),
    info: (id, key) => request('/api/transfers/' + encodeURIComponent(id), { key }),
    remove: (id, key) => request('/api/transfers/' + encodeURIComponent(id), { method: 'DELETE', key }),
    expiry: (id, key, minutes) => request('/api/transfers/' + encodeURIComponent(id), { method: 'PATCH', key, data: { expiresIn: minutes * 60 } }),
    // Lifts the pauses after wrong passwords, every network's and the whole transfer's; it counts as no password try.
    // The answer is the owner info.
    unpause: (id, key) => request('/api/transfers/' + encodeURIComponent(id), { method: 'PATCH', key, data: { clearPause: true } }),
  };
})();
