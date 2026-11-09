// The heavy work of the E2EE pages (docs/E2EE.md), run in a dedicated worker (dist/e2ee/worker.js) or, where no module
// worker starts, on the page itself: building one upload part (§7 step 4) and fetching and decrypting a download
// (§9.2). Both get KEY from the page; the download service worker (/_dl/sw.js) never does. The upload page also runs
// a folder zip's CRC pre-pass here (docs/FOLDER-ZIP.md §7.1), which needs no key.
import * as age from './age.js';
import { crc32 } from './crc32.js';

const BUFFERED = 4, RETRIES = 5, PROGRESS = 1048576, ALIVE = 5000;

/**
 * Part `part` of the stored object for a transfer {key, head (b64url), size: P}: the stored head is checked alone with
 * KEY (§9.1), the part is encrypted from `file` in pieces of at most 1 MiB, hashed, and becomes an immutable Blob, so
 * what is sent is exactly what was hashed (§7). A File that changed on disk (NotReadableError) is file_changed.
 * `spans` ([from, to) plaintext ranges inside what the part reads, ascending) asks for the CRC-32 of exactly the bytes
 * that were encrypted there (`crcs`): a folder zip's entries are checked with them before completing (FOLDER-ZIP §7.3).
 */
export async function buildPart({key, head, size, partSize}, file, part, spans = null) {
  const content = await age.openContent(key, age.decodeBlob(head), size), crcs = spans?.map(() => 0);
  const source = !spans ? file : async (from, to) => {
    const bytes = new Uint8Array(await file.slice(from, to).arrayBuffer());
    spans.forEach(([a, b], i) => { const lo = Math.max(a, from), hi = Math.min(b, from + bytes.length); if (lo < hi) crcs[i] = crc32(bytes.subarray(lo - from, hi - from), crcs[i]); });
    return bytes;
  };
  let bytes;
  try { bytes = await age.encryptPart(content, source, part, partSize ? {partSize} : {}); }
  catch (error) { throw error?.name === 'NotReadableError' ? new age.E2EEError('file_changed') : error; }
  return {blob: new Blob([bytes]), md5: age.md5Hex(bytes), contentMd5: age.contentMd5(bytes), ...(crcs ? {crcs} : {})};
}

const PIECE = 4194304, BATCH = 512;
/**
 * A folder zip's CRC pre-pass (docs/FOLDER-ZIP.md §7.1): the CRC-32 of each File, read once from start to end in
 * pieces of at most 4 MiB, small files up to 512 to a read. `emit(read)` gets the bytes read so far after each read. A
 * file that can't be read or isn't exactly its listed size any more throws file_changed with its `index`.
 */
export async function crcFiles(files, emit = () => {}) {
  const crcs = new Array(files.length).fill(0), changed = index => Object.assign(new age.E2EEError('file_changed'), {index});
  const read = async (blob, length, index) => {
    try { const bytes = new Uint8Array(await blob.arrayBuffer()); if (bytes.length === length) return bytes; } catch {}
    throw changed(index);
  };
  let done = 0;
  for (let index = 0; index < files.length;) {
    const file = files[index];
    if (file.size > PIECE / 4) {
      let crc = 0;
      for (let offset = 0; offset < file.size; offset += PIECE) {
        const bytes = await read(file.slice(offset, offset + PIECE), Math.min(PIECE, file.size - offset), index);
        crc = crc32(bytes, crc); done += bytes.length; emit(done);
      }
      crcs[index++] = crc;
      continue;
    }
    // Small files share a read; where it fails, each is read alone, so the error names the file.
    let end = index, total = 0;
    while (end < files.length && end - index < BATCH && files[end].size <= PIECE / 4 && total + files[end].size <= PIECE) total += files[end++].size;
    let bytes = null;
    try { bytes = await read(new Blob(files.slice(index, end)), total, index); } catch {}
    for (let at = 0; index < end; at += files[index++].size)
      crcs[index] = crc32(bytes ? bytes.subarray(at, at + files[index].size) : await read(files[index], files[index].size, index));
    done += total; emit(done);
  }
  return crcs;
}

// A refusal by the server: its status and code. 408, 429 and 5xx are worth another try (2.3.0 retry classes), except a
// password pause, which is permanent whatever its status.
class Refused extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : 'The download was refused.');
    this.status = status; this.serverCode = typeof body?.code === 'string' ? body.code : null;
    this.retry = this.serverCode !== 'password_paused' && (status === 408 || status === 429 || status >= 500);
  }
}
const refused = async response => new Refused(response.status, await response.json().catch(() => null));
const corrupt = () => new age.E2EEError('corrupt');
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * §9.2 "Fetch and decrypt" for a transfer whose key check passed: GET `url` (`/d/ID?dl=1`) with `auth` (Basic, for a
 * protected transfer) as the only credential, 200 with Content-Length C required, the head compared with the verified
 * one, then every chunk decrypted and handed to `port` as it verifies: `{type: 'chunk', data}` at most four ahead of
 * the consumer's `{type: 'ack'}`s, then `{type: 'end'}`, or `{type: 'error'}` on any failure, so a consumer never sees
 * an end that didn't verify. A dropped connection continues with Range and If-Range from the first chunk not handed on,
 * at most five times with backoff; a 200 instead of 206 means the object changed (corrupt). The consumer's
 * `{type: 'cancel'}` aborts the fetch. `{type: 'alive'}` goes to the consumer every 5 s until the end, also while a
 * retry waits, so the service worker can tell a slow download from a closed page (§9.2). `emit` tells the page:
 * progress, done (the final chunk verified), error, cancelled, and closed when the consumer reports its stream closed.
 */
export async function produce({url, auth = null, key, head, size, ciphertextSize}, port, emit, {fetch: get = globalThis.fetch, wait = pause} = {}) {
  const controller = new AbortController();
  let acked = 0, sent = 0, wake = null, cancelled = false, ended = false, etag = null, attempts = 0, verified = 0, told = 0;
  port.onmessage = ({data}) => {
    if (data?.type === 'ack') acked++;
    // A cancel after the end still means the browser didn't keep the whole file.
    else if (data?.type === 'cancel') { cancelled = true; controller.abort(); if (ended) emit({type: 'cancelled'}); }
    else if (data?.type === 'closed') emit({type: 'closed'});
    wake?.();
  };
  const request = async offset => {
    const headers = {...(auth ? {Authorization: auth} : {}), ...(offset ? {Range: 'bytes=' + offset + '-', ...(etag ? {'If-Range': etag} : {})} : {})};
    const response = await get(url, {cache: 'no-store', credentials: 'omit', redirect: 'error', headers, signal: controller.signal});
    if (!offset) {
      if (response.status !== 200) throw await refused(response);
      if (response.headers.get('Content-Length') !== String(ciphertextSize)) throw corrupt();
      etag = response.headers.get('ETag');
    } else {
      if (response.status === 200) throw corrupt();
      if (response.status !== 206) throw await refused(response);
      if (!(response.headers.get('Content-Range') || '').startsWith('bytes ' + offset + '-')) throw corrupt();
    }
    if (!response.body) throw corrupt();
    return response.body;
  };
  // The decryptor calls this at the start and after each failed read, with the offset it needs next.
  const open = async (offset, error) => {
    for (let failure = error; ; ) {
      if (failure) {
        if (cancelled || failure instanceof age.E2EEError || (failure instanceof Refused && !failure.retry)) throw failure;
        if (++attempts > RETRIES) throw new age.E2EEError('network');
        await wait(1000 * 2 ** (attempts - 1) * (0.8 + Math.random() * 0.4));
        if (cancelled) throw failure;
      }
      try { return await request(offset); }
      catch (problem) { failure = problem; }
    }
  };
  let reader = null;
  const alive = setInterval(() => port.postMessage({type: 'alive'}), ALIVE);
  try {
    const content = await age.openContent(key, age.decodeBlob(head), size);
    reader = age.decryptReadable(open, content).getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      while (sent - acked >= BUFFERED && !cancelled) await new Promise(resolve => { wake = resolve; });
      if (cancelled) throw new DOMException('Cancelled.', 'AbortError');
      const data = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.slice().buffer;
      verified += value.byteLength;
      port.postMessage({type: 'chunk', data}, [data]); sent++;
      if (verified - told >= PROGRESS) { told = verified; emit({type: 'progress', verified}); }
    }
    port.postMessage({type: 'end'}); ended = true;
    emit({type: 'progress', verified}); emit({type: 'done'});
  } catch (error) {
    reader?.cancel().catch(() => {});
    if (cancelled) { emit({type: 'cancelled'}); return; }
    port.postMessage({type: 'error'});
    emit({type: 'error', code: error instanceof age.E2EEError ? error.code : error instanceof Refused ? 'refused' : 'network',
      status: error?.status ?? 0, serverCode: error?.serverCode ?? null});
  } finally { clearInterval(alive); }
}

/** The dedicated worker's side: `part` and `crc` jobs answer by id, `decrypt` jobs write to the port they bring. */
export function serve(scope) {
  scope.onmessage = async ({data, ports}) => {
    if (data?.job === 'part') {
      try { scope.postMessage({id: data.id, ...await buildPart(data.transfer, data.file, data.part, data.spans)}); }
      catch (error) { scope.postMessage({id: data.id, error: error?.code || 'failed'}); }
    } else if (data?.job === 'crc') {
      try { scope.postMessage({id: data.id, crcs: await crcFiles(data.files, read => scope.postMessage({id: data.id, read}))}); }
      catch (error) { scope.postMessage({id: data.id, error: error?.code || 'failed', index: error?.index ?? -1}); }
    } else if (data?.job === 'decrypt' && ports[0]) await produce(data.download, ports[0], event => scope.postMessage(event));
  };
  // The page hands a download's port over only to a worker that started (a port sent to one that failed would be lost).
  scope.postMessage({type: 'ready'});
}
