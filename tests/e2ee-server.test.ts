import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { budget, randomToken, resumeToken, unwrap, PASSWORD_PAUSE_MS } from '../src/shared';
import { call, direct, edit, file, networkOfClient, operatorDirect, OPERATOR_TOKEN, pageOf, pathOf, post, record, swap, tries, useNetworkPrefix, type Session } from './helpers';
import { age, pin, plaintext, prepare, sealedFile, sealedInit, sealedPart, sealedPut } from './sealed';

useNetworkPrefix('198.18.20.');

// The server side of end-to-end encrypted transfers (docs/E2EE.md §4.4, §7, §8.3, §11, §12, §14, §15.4): what init
// takes, pins and parts, completion, the info route with passwords, /d/ for encrypted files, one-time sessions and
// `done`, unknown modes, the switch, cleanup, reports and metrics. Raw transfers keep every 2.3.0 behaviour.

const PASSWORD = 'tide-lamp-41';
const html = { Accept: 'text/html,application/xhtml+xml' };
const curl = { 'User-Agent': 'curl/8.5.0', Accept: '*/*' };
const basic = (password: string) => ({ Authorization: 'Basic ' + btoa('fyl:' + password) });
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const transfer = (session: Session) => env.TRANSFERS.getByName(session.uploadId);
const sql = <T>(stub: DurableObjectStub, query: string, ...bindings: SqlStorageValue[]) =>
  runInDurableObject(stub, (_instance, ctx) => { try { return ctx.storage.sql.exec(query, ...bindings).toArray() as T[]; } catch { return null; } });
const info = (id: string, headers: Record<string, string> = {}, from?: string) => call(`/api/transfers/${id}`, { headers }, from);
const status = (session: Session) => call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + session.key } });
/** A METRICS stand-in that keeps "event:code" of every data point and the data points themselves. */
const dataset = () => {
  const events: string[] = [], points: AnalyticsEngineDataPoint[] = [];
  return { events, points, METRICS: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => {
    if (point) { points.push(point); events.push((point.blobs || []).filter(Boolean).join(':')); }
  } } as unknown as AnalyticsEngineDataset };
};
/** Runs `work` with the upload's Durable Object writing its metrics to `metrics` (it keeps the env it was created with). */
async function counted<T>(session: Session, metrics: ReturnType<typeof dataset>, work: () => Promise<T>) {
  const restore = await swap(env.TRANSFERS.getByName(session.uploadId), () => ({ METRICS: metrics.METRICS }));
  try { return await work(); } finally { await restore(); }
}
const md5Of = (payload: Uint8Array) => age.md5Hex(payload);
const base64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)?.map(pair => Number.parseInt(pair, 16)) || []));
/** Changes byte `index` of a b64url blob (its bytes decoded and encoded again). */
const flip = (blob: string, index: number, value?: number) => {
  const data = age.decodeBlob(blob).slice();
  data[index] = value ?? data[index] ^ 1;
  return age.encodeBlob(data);
};
/** `meta` with the byte range [start, end) taken from `head`: a sender that reused the content's randomness. */
const reusing = (head: string, meta: string, start: number, end: number) => {
  const data = age.decodeBlob(meta).slice();
  data.set(age.decodeBlob(head).subarray(start, end), start);
  return age.encodeBlob(data);
};

const directive = (policy: string, name: string) => policy.split('; ').find(part => part.startsWith(name + ' '))?.split(' ').slice(1) || [];
/**
 * The server's policy and the browser's code are written apart: this walks what a page (`template` at `address`) and
 * its scripts load (static and dynamic imports, scripts it adds, workers and their imports, the service worker) and
 * checks each against `policy`, so a script moved or added on one side fails here rather than in a browser. A worker's
 * own script needs worker-src; its imports are checked against worker-src or script-src depending on the browser, so
 * both. Answers the paths loaded.
 */
async function loads(policy: string, template: string, address: string) {
  const allows = (name: string, url: URL) => directive(policy, name).some(source => source.endsWith('/') ? url.href.startsWith(source) : url.href === source);
  type Load = 'page' | 'worker' | 'in-worker';
  const needs = { page: ['script-src'], worker: ['worker-src'], 'in-worker': ['worker-src', 'script-src'] };
  const seen = new Set<string>(), queue: [string, Load][] = [];
  for (const match of template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) queue.push([new URL(match[1], address).href, 'page']);
  while (queue.length) {
    const [href, load] = queue.shift() as [string, Load], url = new URL(href);
    for (const need of needs[load]) expect([url.pathname, need, allows(need, url)]).toEqual([url.pathname, need, true]);
    if (seen.has(href + ' ' + load)) continue;
    seen.add(href + ' ' + load);
    const code = await call(url.pathname);
    expect([url.pathname, code.status]).toEqual([url.pathname, 200]);
    const text = await code.text();
    const found = (pattern: RegExp) => [...text.matchAll(pattern)].map(match => new URL(match[1], href).href);
    for (const module of [...found(/\bimport\(\s*'([^']+)'\s*\)/g), ...found(/^(?:import|export)\b[^'\n]*\bfrom\s+'([^']+)'/gm), ...found(/\.src\s*=\s*'([^']+\.js)'/g),
      ...found(/\bimportScripts\(\s*'([^']+)'/g)]) queue.push([module, load === 'page' ? 'page' : 'in-worker']);
    for (const worker of [...found(/\bnew Worker\(\s*'([^']+)'/g), ...found(/\bserviceWorker\.register\(\s*'([^']+)'/g)]) queue.push([worker, 'worker']);
  }
  return [...seen].map(entry => new URL(entry.split(' ')[0]).pathname);
}

describe('encrypted upload init (docs/E2EE.md §12.1)', () => {
  it('takes mode e2ee with head and meta, echoes the mode, links to /d/ID and stores only a generic name', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed);
    expect(session).toEqual({ uploadId: expect.any(String), key: expect.any(String), url: `https://fyl.at/d/${session.uploadId}`, mode: 'e2ee' });
    const stored = await record(session.uploadId);
    expect(stored).toMatchObject({ mode: 'e2ee', name: `fyl-${session.uploadId.slice(0, 8)}.age`, size: 1200, head: sealed.body.e2ee.head, meta: sealed.body.e2ee.meta });
    // No plaintext name, size or key anywhere in the record.
    expect(JSON.stringify(stored)).not.toMatch(/Quarterly|"1000"|:1000[,}]/);
    expect(JSON.stringify(stored)).not.toContain(sealed.prepared.key);
    // A raw init answers its mode too, and otherwise as in 2.3.0.
    const raw = await post('/api/upload/init', { filename: 'plain.txt', size: 3 });
    expect(await raw.json()).toEqual({ uploadId: expect.any(String), key: expect.any(String), url: expect.stringMatching(/\/d\/[\w-]{43}\/plain\.txt$/), mode: 'raw' });
  });

  it('checks the mode, the switch, the name, the size, the head and the meta, in that order', async () => {
    const sealed = await prepare(plaintext(70000)), { body } = sealed, { head, meta } = body.e2ee;
    const refused = async (data: Record<string, unknown>, status: number, code = 'request_failed') => {
      const response = await post('/api/upload/init', data);
      expect([response.status, (await response.json<{ code: string }>()).code], JSON.stringify(data).slice(0, 120)).toEqual([status, code]);
    };
    // 1: an unknown mode, or e2ee fields with a raw upload.
    await refused({ ...body, mode: 'sealed' }, 400);
    await refused({ ...body, mode: null }, 400);
    await refused({ filename: 'a.txt', size: 3, e2ee: body.e2ee }, 400);
    await refused({ filename: 'a.txt', size: 3, mode: 'raw', e2ee: null }, 400);
    // 2: the switch, before anything else is looked at.
    const off = await direct('/api/upload/init', { E2EE_ENABLED: 'false' } as unknown as Partial<Env>, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, filename: 'secret.pdf', size: 1 }) });
    expect([off.response.status, await off.response.json()]).toEqual([403, { error: "This server doesn't accept encrypted uploads at the moment.", code: 'e2ee_disabled' }]);
    // 3: a plaintext name never reaches the server.
    await refused({ ...body, filename: 'Quarterly report.pdf' }, 400);
    await refused({ ...body, filename: null }, 400);
    // 4: a safe integer from 201 to MAX_FILE_BYTES (413 above) that is the size of an age file.
    await refused({ ...body, size: '70228' }, 400);
    await refused({ ...body, size: 1.5 }, 400);
    await refused({ ...body, size: Number(env.MAX_FILE_BYTES) + 1 }, 413);
    for (const size of [0, 200, 65737, 65752]) await refused({ ...body, size }, 400);
    // 5: head of exactly 184 bytes, meta of a metadata size, both shaped like a profile header; canonical b64url.
    const variants: unknown[] = [undefined, null, 'x', { head }, { meta }, { head: meta, meta }, { head, meta: head },
      { head: head + 'A', meta }, { head: head.slice(0, -1) + String.fromCharCode(head.charCodeAt(head.length - 1) + 1), meta }, { head: `${head}=`, meta },
      { head: head.replace(/.$/, '+'), meta }, { head, meta: meta.slice(0, -4) }, { head: flip(head, 0, 0x41), meta }, { head: flip(head, 25, 0x20), meta },
      { head, meta: flip(meta, 40, 0x2e) }, { head: flip(head, 167, 0x20), meta }];
    for (const e2ee of variants) await refused({ ...body, e2ee }, 400);
    // 6: the metadata's ephemeral share, stanza body or payload nonce taken from the content head.
    for (const [start, end] of [[32, 75], [76, 119], [168, 184]]) await refused({ ...body, e2ee: { head, meta: reusing(head, meta, start, end) } }, 400);
    // The header's other bytes may be anything the pattern allows: the server checks no MAC and decrypts nothing.
    expect((await post('/api/upload/init', { ...body, e2ee: { head: flip(head, 130, age.decodeBlob(head)[130] === 0x41 ? 0x42 : 0x41), meta } })).status).toBe(201);
    expect((await post('/api/upload/init', body)).status).toBe(201);
    expect((await post('/api/upload/init', { ...body, size: 201 })).status).toBe(201);
  });

  it('makes replays idempotent by mode, size, options, head, meta and password, never by name', async () => {
    const sealed = await prepare(plaintext(10)), clientKey = randomToken(), idempotency = { 'Idempotency-Key': 'e2ee-replay-' + randomToken().slice(0, 20) };
    const first = await sealedInit(sealed, { clientKey, password: PASSWORD }, idempotency);
    expect(await sealedInit(sealed, { clientKey, password: PASSWORD }, idempotency)).toEqual(first);
    const other = await prepare(plaintext(10));
    for (const changed of [{ e2ee: other.body.e2ee }, { e2ee: { ...sealed.body.e2ee, meta: other.body.e2ee.meta } }, { password: 'tide-lamp-42' }, { password: undefined },
      { oneTime: true }, { expiresIn: 3600 }, { size: 227 }]) {
      const response = await post('/api/upload/init', { ...sealed.body, clientKey, password: PASSWORD, ...changed }, idempotency);
      expect(response.status, JSON.stringify(changed).slice(0, 60)).toBe(409);
    }
    // A raw upload can't take over the encrypted one's session, nor the other way round.
    expect((await post('/api/upload/init', { filename: 'a.txt', size: 1027, clientKey, password: PASSWORD }, idempotency)).status).toBe(409);
    expect((await post('/api/upload/abort', first)).status).toBe(200);
  });
});

describe('pins and encrypted parts (docs/E2EE.md §8.3)', () => {
  it('stores the first pin, accepts it again and refuses another as part_changed', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), md5 = md5Of(sealed.parts[0]);
    const metrics = dataset();
    const first = await pin(session, 1, md5);
    expect([first.status, await first.json()]).toEqual([200, { partNumber: 1, md5 }]);
    expect((await pin(session, 1, md5, await resumeToken(session.key))).status).toBe(200);
    const changed = await counted(session, metrics, () => pin(session, 1, 'f'.repeat(32)));
    expect([changed.status, (await changed.json<{ code: string }>()).code]).toEqual([409, 'part_changed']);
    expect(await sql(transfer(session), 'SELECT number, md5 FROM pins')).toEqual([{ number: 1, md5 }]);
    // Malformed requests, another key, a part the file doesn't have.
    for (const [number, value] of [[1, md5.toUpperCase()], [1, md5.slice(1)], [1, 42], [2, md5], [0, md5], [1.5, md5]] as const)
      expect((await call('/api/upload/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.key },
        body: JSON.stringify({ uploadId: session.uploadId, partNumber: number, md5: value }) })).status, `${number} ${value}`).toBe(400);
    expect((await pin(session, 1, md5, randomToken())).status).toBe(403);
    expect((await call('/api/upload/pin', { method: 'GET' })).status).toBe(405);
    expect((await pin(session, 1, md5, 'not-a-key')).status).toBe(403);
    // Raw uploads have no pins.
    const raw = await (await post('/api/upload/init', { filename: 'a.txt', size: 3 })).json<Session>();
    expect((await pin(raw, 1, md5)).status).toBe(400);
    // Only while the upload runs.
    expect((await post('/api/upload/abort', session)).status).toBe(200);
    expect((await pin(session, 1, md5)).status).toBe(410);
    // The refusal counts as part_refused with its code, and nothing that names the upload.
    expect(metrics.events).toEqual(['part_refused:part_changed']);
    expect(JSON.stringify(metrics.points)).not.toContain(session.uploadId);
  });

  it('refuses a part without a pin, without a valid Content-MD5 or with another MD5, before R2 and before it counts', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), payload = sealed.parts[0], md5 = md5Of(payload);
    const code = async (response: Response) => [response.status, (await response.json<{ code: string }>()).code];
    expect(await code(await sealedPut(session, payload, 1, age.contentMd5(payload)))).toEqual([400, 'request_failed']);
    expect((await pin(session, 1, md5)).status).toBe(200);
    for (const header of [null, '', md5, base64(md5).slice(0, -2), base64(md5).replace(/.(?===$)/, char => String.fromCharCode(char.charCodeAt(0) + 1)), `${base64(md5)}=`])
      expect(await code(await sealedPut(session, payload, 1, header)), String(header)).toEqual([400, 'request_failed']);
    const other = payload.slice();
    other[500] ^= 1;
    expect(await code(await sealedPut(session, other, 1, age.contentMd5(other)))).toEqual([409, 'part_changed']);
    // Nothing was admitted: no attempt, no part, nothing reserved.
    expect(await sql(transfer(session), 'SELECT * FROM attempts')).toEqual([]);
    expect(await sql(transfer(session), 'SELECT * FROM parts')).toEqual([]);
    expect(await sql(budget(env), 'SELECT * FROM pending WHERE id = ?', session.uploadId)).toEqual([]);
    // The pinned bytes with their Content-MD5 go through.
    const sent = await sealedPut(session, payload, 1, age.contentMd5(payload));
    expect(sent.status).toBe(200);
    expect((await sql<{ attempts: number }>(transfer(session), 'SELECT attempts FROM parts WHERE number = 1'))?.[0].attempts).toBe(1);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('settles a part whose stored MD5 differs from its pin as failed: 502 part_corrupt, slot and bytes freed, one attempt counted', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), payload = sealed.parts[0], md5 = md5Of(payload), stub = transfer(session);
    expect((await pin(session, 1, md5)).status).toBe(200);
    const metrics = dataset();
    await counted(session, metrics, async () => {
      // Two attempts at once, each with its own slot (§8.3 changes nothing about slots).
      const a = unwrap(await stub.reservePart(session.key, 1, payload.length, 'e'.repeat(64), md5));
      const b = unwrap(await stub.reservePart(session.key, 1, payload.length, 'e'.repeat(64), md5));
      expect([a.slot, b.slot]).toEqual([1, 2]);
      expect(await stub.reservePart(session.key, 1, payload.length, 'e'.repeat(64), null)).toMatchObject({ ok: false, status: 400 });
      expect(await stub.finishPart(session.key, 1, a.ticket, `"${'0'.repeat(32)}"`))
        .toEqual({ ok: false, status: 502, code: 'part_corrupt', error: 'This part was stored damaged. Please send it again.' });
      expect(await sql(stub, 'SELECT ticket FROM attempts')).toEqual([{ ticket: b.ticket }]);
      expect(await sql(budget(env), 'SELECT slot FROM pending WHERE id = ?', session.uploadId)).toEqual([{ slot: 2 }]);
      expect(await sql(stub, 'SELECT attempts, etag FROM parts')).toEqual([{ attempts: 2, etag: null }]);
      // The pin's MD5, and an ETag that isn't an MD5 (the local simulator's), are taken.
      expect(unwrap(await stub.finishPart(session.key, 1, b.ticket, md5.toUpperCase()))).toEqual({ etag: md5.toUpperCase() });
      const c = unwrap(await stub.reservePart(session.key, 1, payload.length, 'e'.repeat(64), md5));
      expect(c.slot).toBe(1);
      expect(unwrap(await stub.finishPart(session.key, 1, c.ticket, 'simulator-etag'))).toEqual({ etag: 'simulator-etag' });
    });
    expect(metrics.events.filter(event => event.startsWith('part_refused'))).toEqual(['part_refused:part_corrupt']);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('leaves raw parts as they were: no pin, and a Content-MD5 is not read', async () => {
    const session = await (await post('/api/upload/init', { filename: 'a.txt', size: 3 })).json<Session>();
    const response = await sealedPut(session, new Uint8Array([1, 2, 3]), 1, base64('f'.repeat(32)));
    expect(response.status).toBe(200);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('lists mode, head, meta and every pin in the upload status, confirmed or not', async () => {
    const sealed = await prepare(plaintext(age.PART + 5000)), session = await sealedInit(sealed);
    expect(sealed.parts).toHaveLength(2);
    const before = await (await status(session)).json();
    expect(before).toMatchObject({ status: 'uploading', access: 'owner', name: null, size: sealed.prepared.ciphertextSize, mode: 'e2ee', parts: [], pins: [],
      e2ee: sealed.body.e2ee, url: `https://fyl.at/d/${session.uploadId}` });
    const confirmed = await sealedPart(session, sealed, 2);
    expect((await pin(session, 1, md5Of(sealed.parts[0]))).status).toBe(200);
    const after = await (await status(session)).json<Record<string, unknown>>();
    expect(after.parts).toEqual([{ partNumber: 2, size: sealed.parts[1].length, etag: confirmed.etag }]);
    expect(after.pins).toEqual([{ partNumber: 1, md5: md5Of(sealed.parts[0]) }, { partNumber: 2, md5: md5Of(sealed.parts[1]) }]);
    // With the resume token as well; a raw upload's status says raw and has neither.
    const resumed = await call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + await resumeToken(session.key) } });
    expect(await resumed.json()).toMatchObject({ access: 'resume', pins: after.pins, e2ee: sealed.body.e2ee });
    const raw = await (await post('/api/upload/init', { filename: 'a.txt', size: 3 })).json<Session>();
    const rawStatus = await (await status(raw)).json<Record<string, unknown>>();
    expect([rawStatus.mode, rawStatus.name, rawStatus.url, 'pins' in rawStatus, 'e2ee' in rawStatus]).toEqual(['raw', 'a.txt', `https://fyl.at/d/${raw.uploadId}/a.txt`, false, false]);
    for (const open of [session, raw]) expect((await post('/api/upload/abort', open)).status).toBe(200);
  });
});

describe('encrypted completion (docs/E2EE.md §12.2)', () => {
  it('completes with a nameless receipt of size C whose file decrypts to the plaintext', async () => {
    const sealed = await prepare(plaintext(70000)), session = await sealedInit(sealed), parts = [await sealedPart(session, sealed, 1)];
    const receipt = await (await post('/api/upload/complete', { ...session, parts })).json<Record<string, unknown>>();
    expect(receipt).toMatchObject({ id: session.uploadId, transferId: session.uploadId, name: null, mode: 'e2ee', size: 70000 + 184 + 32, url: `https://fyl.at/d/${session.uploadId}`,
      managementUrl: expect.stringContaining(`/#manage/${session.uploadId}/`) });
    expect(JSON.stringify(receipt)).not.toContain('Quarterly');
    const stored = await env.FILES.get(`files/${session.uploadId}`);
    const content = await bytes(new Response(stored?.body));
    const checked = await age.checkKey(sealed.prepared.key, sealed.prepared.head, sealed.prepared.meta, content.length);
    expect(checked.name).toBe('Quarterly report.pdf');
    expect(await age.decryptBytes(checked.content, content)).toEqual(sealed.data);
  });

  it('refuses a completed object that does not start with the init head: 409 head_mismatch, the object deleted, the upload failed', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), metrics = dataset();
    // A modified client sends a first part whose head differs from the one init got, with a pin of its own.
    const forged = sealed.parts[0].slice();
    forged[100] ^= 1;
    expect((await pin(session, 1, md5Of(forged))).status).toBe(200);
    const sent = await sealedPut(session, forged, 1, age.contentMd5(forged));
    expect(sent.status).toBe(200);
    const parts = [{ partNumber: 1, ...(await sent.json<{ etag: string }>()) }];
    const response = await counted(session, metrics, () => post('/api/upload/complete', { ...session, parts }));
    expect([response.status, (await response.json<{ code: string }>()).code]).toEqual([409, 'head_mismatch']);
    expect(metrics.events).toContain('part_refused:head_mismatch');
    expect(metrics.events.filter(event => event.startsWith('upload_completed'))).toEqual([]);
    expect(await env.FILES.head(`files/${session.uploadId}`)).toBeNull();
    expect(await record(session.uploadId)).toMatchObject({ status: 'aborted', clean: true });
    expect(await sql(budget(env), 'SELECT id FROM reservations WHERE id = ? AND active = 1', session.uploadId)).toEqual([]);
    // No receipt ever: the completion again, the link and the status all say it failed.
    expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(410);
    expect((await call(`/d/${session.uploadId}?dl=1`, { headers: curl })).status).toBe(410);
  });
});

describe('encrypted info and passwords (docs/E2EE.md §11, §12.2)', () => {
  it('gives anyone an unprotected transfer\'s head and meta, also while it uploads, and never a name', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed);
    const uploading = await (await info(session.uploadId)).json();
    expect(uploading).toEqual({ id: session.uploadId, state: 'uploading', size: 1200, received: 0, updatedAt: expect.any(Number), once: false, protected: false,
      name: null, expiresAt: null, mode: 'e2ee', e2ee: sealed.body.e2ee, serverTime: expect.any(Number) });
    const owner = await (await info(session.uploadId, { Authorization: 'Bearer ' + session.key })).json();
    expect(owner).toMatchObject({ name: null, mode: 'e2ee', owner: true, state: 'uploading', e2ee: sealed.body.e2ee, url: `https://fyl.at/d/${session.uploadId}` });
    const parts = [await sealedPart(session, sealed, 1)];
    expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(200);
    expect(await (await info(session.uploadId)).json()).toMatchObject({ state: 'ready', name: null, mode: 'e2ee', protected: false, size: 1200, owner: false,
      url: `https://fyl.at/d/${session.uploadId}`, e2ee: sealed.body.e2ee });
    // A raw file's info says raw and has no e2ee.
    const raw = await file();
    const rawInfo = await (await info(raw.receipt.id)).json<Record<string, unknown>>();
    expect([rawInfo.mode, 'e2ee' in rawInfo]).toEqual(['raw', false]);
  });

  it('gives a protected transfer\'s head and meta only to its owner or with its password as Basic, counting tries as on /d/, never a challenge', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed, { password: PASSWORD }), id = session.uploadId;
    const from = '198.18.20.77';
    expect(await (await info(id)).json()).toMatchObject({ state: 'uploading', protected: true, e2ee: null, name: null });
    // While it uploads too: the page checks the key before the file is there.
    expect(await (await info(id, basic(PASSWORD), from)).json()).toMatchObject({ state: 'uploading', e2ee: sealed.body.e2ee });
    expect((await post('/api/upload/complete', { ...session, parts: [await sealedPart(session, sealed, 1)] })).status).toBe(200);
    expect(await (await info(id)).json()).toMatchObject({ state: 'ready', protected: true, e2ee: null, name: null, url: `https://fyl.at/d/${id}` });
    expect(await (await info(id, { Authorization: 'Bearer ' + session.key })).json()).toMatchObject({ owner: true, e2ee: sealed.body.e2ee, passwordPause: expect.any(Object) });
    const right = await info(id, basic(PASSWORD), from);
    expect([right.status, await right.json()]).toEqual([200, expect.objectContaining({ owner: false, e2ee: sealed.body.e2ee, name: null })]);
    // Wrong ones: JSON with the tries left, no WWW-Authenticate; counted for the subscriber, like the form and Basic on /d/.
    const wrong = await info(id, basic('wrong-password'), from);
    expect(wrong.headers.has('WWW-Authenticate')).toBe(false);
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: 'Wrong password. 4 tries left.', code: 'password_wrong', triesLeft: 4 }]);
    expect(await tries(id)).toEqual([{ network: await networkOfClient(from, id, 56), fails: 1, paused_until: 0 }]);
    for (let attempt = 0; attempt < 4; attempt++) await info(id, basic('wrong-password'), from);
    const paused = await info(id, basic(PASSWORD), from);
    const body = await paused.json<{ pausedUntil: number }>();
    expect([paused.status, body]).toEqual([429, { error: 'Too many wrong tries. Try again in 15 minutes.', code: 'password_paused', pausedUntil: expect.any(Number) }]);
    expect(body.pausedUntil).toBeLessThanOrEqual(Date.now() + PASSWORD_PAUSE_MS);
    expect(Number(paused.headers.get('Retry-After'))).toBeGreaterThan(800);
    expect(paused.headers.has('WWW-Authenticate')).toBe(false);
    // Another network still gets in; an unreadable Basic header counts as none.
    expect(await (await info(id, basic(PASSWORD), '198.18.20.78')).json()).toMatchObject({ e2ee: sealed.body.e2ee });
    expect(await (await info(id, { Authorization: 'Basic !!!' }, '198.18.20.79')).json()).toMatchObject({ e2ee: null });
    expect((await call(`/api/transfers/${id}`, { method: 'DELETE', headers: basic(PASSWORD) })).status).toBe(403);
  });

  it('gives a protected raw file\'s name to the right password as Basic, its link still without a name', async () => {
    const { receipt } = await file(false, PASSWORD, 'secret-plan.zip');
    expect(await (await info(receipt.id)).json()).toMatchObject({ name: null, mode: 'raw' });
    const unlocked = await (await info(receipt.id, basic(PASSWORD))).json<Record<string, unknown>>();
    expect(unlocked).toMatchObject({ name: 'secret-plan.zip', url: `https://fyl.at/d/${receipt.id}`, mode: 'raw', owner: false });
    expect('e2ee' in unlocked).toBe(false);
    expect((await info(receipt.id, basic('nope-nope'))).status).toBe(401);
  });
});

describe('/d/ for encrypted transfers (docs/E2EE.md §9.5, §12.2)', () => {
  it('gives browsers the page for every address of the file, with head and meta and nothing of the name', async () => {
    const { session, sealed } = await sealedFile(1000), id = session.uploadId;
    for (const [path, headers] of [[`/d/${id}`, html], [`/d/${id}?dl=1`, html], [`/d/${id}?grant=1.${'a'.repeat(43)}`, html], [`/d/${id}/Invoice.pdf`, html],
      [`/d/${id}?dl=1`, { 'Sec-Fetch-Mode': 'navigate', Accept: '*/*' }], [`/d/${id}%23${sealed.prepared.key}`, html], [`/d/${id}%23${sealed.prepared.key}?dl=1`, html],
      [`/d/${id}`, { 'User-Agent': 'Slackbot-LinkExpanding 1.0', Accept: '*/*' }]] as const) {
      const response = await call(path, { headers });
      expect(response.status, path).toBe(200);
      const { html: page, root, data } = await pageOf(response);
      expect(data, path).toEqual({
        state: 'ready', id, name: null, size: 1200, type: null, ext: null, expiresAt: expect.any(Number), once: false, protected: false, risky: false,
        url: `https://fyl.at/d/${id}`, downloadUrl: null, received: null, updatedAt: null, reason: null, error: null, triesLeft: null, pausedUntil: null,
        now: expect.any(Number), mode: 'e2ee', head: sealed.body.e2ee.head, meta: sealed.body.e2ee.meta,
      });
      expect(root).toContain('data-e2ee');
      expect(page).toContain('<title>Encrypted file · fyl.at</title>');
      expect(page).not.toContain(sealed.prepared.key);
      // No address of the file in the page, so without JavaScript nothing opens it.
      expect(page).not.toContain(`href="https://fyl.at/d/${id}`);
      expect(page).toContain('<meta property="og:title" content="An encrypted file on fyl.at">');
      expect(page).not.toMatch(/og:image|Quarterly|fyl-[\w-]{8}\.age/);
    }
    expect(await record(id)).toMatchObject({ downloads: 0 });
  });

  it('serves the ciphertext only to ?dl=1, a grant or Basic; anything else gets 409 encrypted and opens nothing', async () => {
    const { session, sealed } = await sealedFile(1000, { oneTime: true }), id = session.uploadId;
    for (const [method, path, headers] of [['GET', `/d/${id}`, curl], ['GET', `/d/${id}/x.bin`, {}], ['GET', `/d/${id}`, { Range: 'bytes=0-' }], ['HEAD', `/d/${id}`, curl],
      ['GET', `/d/${id}%23${sealed.prepared.key}`, curl], ['GET', `/d/${id}?grant=1.${'a'.repeat(43)}`, curl]] as const) {
      const response = await call(path, { method, headers });
      expect(response.status, `${method} ${path}`).toBe(409);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(await response.text()).toBe(method === 'HEAD' ? '' : `This file is end-to-end encrypted. Run: fyl download 'https://fyl.at/d/${id}'\n`);
    }
    expect(await record(id)).toMatchObject({ downloads: 0, status: 'ready' });
    expect(await record(id)).not.toHaveProperty('session');
    // ?dl=1: the stored age file under its generic name, which decrypts with the key.
    const head = await call(`/d/${id}?dl=1`, { method: 'HEAD', headers: curl });
    expect([head.status, head.headers.get('Content-Length')]).toEqual([200, '1200']);
    const response = await call(`/d/${id}%23${sealed.prepared.key}?dl=1`, { headers: curl });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="fyl-${id.slice(0, 8)}.age"; filename*=UTF-8''fyl-${id.slice(0, 8)}.age`);
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(await age.decryptBytes(sealed.prepared.key, await bytes(response), { verifiedHead: sealed.prepared.head })).toEqual(sealed.data);
  });

  it('keeps a one-time encrypted link open for its network after a whole delivery, until it idles out or the client says done', async () => {
    const { session } = await sealedFile(1000, { oneTime: true }), id = session.uploadId, from = '198.18.20.91';
    // The page, also at ?dl=1 and with a grant, and the info open nothing.
    for (const path of [`/d/${id}`, `/d/${id}?dl=1`, `/d/${id}?grant=1.${'b'.repeat(43)}`]) expect((await call(path, { headers: html }, from)).status).toBe(200);
    expect((await info(id, {}, from)).status).toBe(200);
    expect(await record(id)).not.toHaveProperty('session');
    const whole = await call(`/d/${id}?dl=1`, { headers: curl }, from);
    expect((await bytes(whole)).length).toBe(1200);
    // Delivered in full, yet not closed: the same network may fetch it again (a failed decryption or save), others may not.
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    expect((await record(id)).status).toBe('ready');
    const again = await call(`/d/${id}?dl=1`, { headers: { ...curl, Range: 'bytes=184-' } }, from);
    expect([again.status, (await bytes(again)).length]).toEqual([206, 1016]);
    expect((await call(`/d/${id}?dl=1`, { headers: curl }, '198.18.20.92')).status).toBe(410);
    // done: from another network nothing changes, from the session's network the link closes at once.
    const elsewhere = await call(`/api/transfers/${id}/done`, { method: 'POST' }, '198.18.20.93');
    expect([elsewhere.status, await elsewhere.text()]).toEqual([204, '']);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    expect((await record(id)).status).toBe('ready');
    expect((await call(`/api/transfers/${id}/done`, { method: 'POST' }, from)).status).toBe(204);
    expect(await record(id)).toMatchObject({ status: 'consumed', clean: true });
    expect((await call(`/d/${id}?dl=1`, { headers: curl }, from)).status).toBe(410);
    expect(await env.FILES.head(`files/${id}`)).toBeNull();
    // done on anything else: 204 and no effect (a raw one-time link, an unknown id, GET).
    const raw = await file(true);
    expect((await call(`/api/transfers/${raw.receipt.id}/done`, { method: 'POST' })).status).toBe(204);
    expect((await record(raw.receipt.id)).status).toBe('ready');
    expect((await call(`/api/transfers/${randomToken()}/done`, { method: 'POST' })).status).toBe(204);
    expect((await call(`/api/transfers/${id}/done`)).status).toBe(405);
  });

  it('locks a protected encrypted file: the page without head and meta, 401 naming fyl download, the file with Basic', async () => {
    const { session, sealed } = await sealedFile(1000, { password: PASSWORD }), id = session.uploadId;
    const { data, root } = await pageOf(await call(`/d/${id}`, { headers: html }));
    expect(data).toMatchObject({ state: 'protected', mode: 'e2ee', head: null, meta: null, name: null, downloadUrl: null, url: `https://fyl.at/d/${id}` });
    expect(root).toContain('data-e2ee');
    expect(root).toContain('data-protected');
    const locked = await call(`/d/${id}?dl=1`, { headers: curl });
    expect([locked.status, await locked.text()]).toEqual([401, `This file is encrypted and needs a password. Run: fyl download 'https://fyl.at/d/${id}'\n`]);
    // Basic alone asks for the file, with or without ?dl=1.
    for (const path of [`/d/${id}`, `/d/${id}?dl=1`]) {
      const response = await call(path, { headers: { ...curl, ...basic(PASSWORD) } });
      expect([response.status, (await bytes(response)).length], path).toEqual([200, 1200]);
    }
    expect((await call(`/d/${id}`, { headers: { ...curl, ...basic('wrong-password') } })).status).toBe(401);
    // Unlocked by the form (the encrypted page doesn't use it, but it works): head and meta, still no file address.
    const unlocked = await call(`/d/${id}`, { method: 'POST', body: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } });
    expect((await pageOf(unlocked)).data).toMatchObject({ state: 'unlocked', head: sealed.body.e2ee.head, meta: sealed.body.e2ee.meta, downloadUrl: null });
  });

  it('shows an encrypted upload still running with its head and meta, and makes the fyl tool wait', async () => {
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), id = session.uploadId;
    const { data } = await pageOf(await call(`/d/${id}?dl=1`, { headers: html }));
    expect(data).toMatchObject({ state: 'uploading', mode: 'e2ee', head: sealed.body.e2ee.head, meta: sealed.body.e2ee.meta, name: null, downloadUrl: null });
    const waiting = await call(`/d/${id}?dl=1`, { headers: curl });
    expect([waiting.status, (await waiting.json<{ code: string }>()).code]).toEqual([503, 'uploading']);
    expect((await call(`/d/${id}`, { headers: curl })).status).toBe(409);
    expect((await post('/api/upload/abort', session)).status).toBe(200);
  });

  it('sets the page CSP itself: scripts and workers only from fyl\'s own script paths, never \'self\' or /cdn-cgi/', async () => {
    const { session } = await sealedFile(10), raw = await file();
    const template = await (await call('/download')).text();
    const scripts = [...template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const path of [`/d/${session.uploadId}`, pathOf(raw.receipt.url), `/d/${randomToken()}`]) {
      const response = await call(path, { headers: html });
      const policy = response.headers.get('Content-Security-Policy') || '';
      await response.text();
      const directive = (name: string) => policy.split('; ').find(part => part.startsWith(name + ' '))?.split(' ').slice(1) || [];
      expect(directive('script-src'), path).toEqual([...scripts.map(script => 'https://fyl.at' + script), 'https://fyl.at/e2ee/', 'https://fyl.at/vendor/']);
      expect(directive('worker-src'), path).toEqual(['https://fyl.at/e2ee/', 'https://fyl.at/vendor/', 'https://fyl.at/_dl/sw.js']);
      expect(policy).not.toMatch(/cdn-cgi|unsafe|\*/);
      expect(policy).toContain("default-src 'self'; ");
      expect(policy).toContain("frame-ancestors 'self'; form-action 'self'");
    }
  });

  it('allows, in that CSP, every script, module and worker the download page\'s code loads, and nothing it doesn\'t', async () => {
    const { session } = await sealedFile(10), response = await call(`/d/${session.uploadId}`, { headers: html });
    const policy = response.headers.get('Content-Security-Policy') || '', template = await response.text();
    const loaded = await loads(policy, template, `https://fyl.at/d/${session.uploadId}`);
    expect(loaded).toEqual(expect.arrayContaining(['/download.js', '/e2ee/age.js', '/e2ee/jobs.js', '/e2ee/worker.js', '/_dl/sw.js', '/vendor/noble-ciphers-2.4.0/chacha.js']));
    // The hidden frame that saves a download (/_dl/<token>) falls under default-src 'self', as fetch does under connect-src.
    expect([directive(policy, 'default-src'), directive(policy, 'frame-src'), directive(policy, 'child-src'), directive(policy, 'connect-src')]).toEqual([["'self'"], [], [], ["'self'"]]);
  });

  it('sets the site pages\' CSP itself too: scripts and workers from fyl\'s own paths, Turnstile only on the report form (§15.6)', async () => {
    for (const path of ['/', '/report', '/privacy', '/download']) {
      const response = await call(path, { headers: html }), head = await call(path, { method: 'HEAD', headers: html });
      const policy = response.headers.get('Content-Security-Policy') || '', template = await response.text();
      const scripts = [...template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => new URL(match[1], 'https://fyl.at' + path).href);
      expect([path, response.status, head.headers.get('Content-Security-Policy'), response.headers.get('ETag')]).toEqual([path, 200, policy, null]);
      expect(directive(policy, 'script-src'), path).toEqual([...scripts, 'https://fyl.at/e2ee/', 'https://fyl.at/vendor/', ...path === '/report' ? ['https://challenges.cloudflare.com'] : []]);
      expect(directive(policy, 'worker-src'), path).toEqual(['https://fyl.at/md5-worker.js', 'https://fyl.at/e2ee/', 'https://fyl.at/vendor/']);
      expect(directive(policy, 'frame-src'), path).toEqual(path === '/report' ? ['https://challenges.cloudflare.com'] : []);
      expect(policy).not.toMatch(/cdn-cgi|unsafe|\*/);
      expect(policy).toContain("default-src 'self'; ");
    }
    // The upload page's code (its workers, the E2EE core, the QR generator) loads only what its policy allows.
    const page = await call('/', { headers: html }), policy = page.headers.get('Content-Security-Policy') || '';
    const loaded = await loads(policy, await page.text(), 'https://fyl.at/');
    expect(loaded).toEqual(expect.arrayContaining(['/app.js', '/api.js', '/md5-worker.js', '/vendor/spark-md5-3.0.2.js', '/e2ee/age.js', '/e2ee/worker.js',
      '/vendor/qrcode-generator-2.0.4.js']));
  });

  it('answers a transfer of a mode only a newer server knows with 503 unsupported_mode, opening nothing', async () => {
    const { session } = await sealedFile(10, { oneTime: true }), id = session.uploadId;
    await edit(id, value => { value.mode = 'e2ee-v2'; });
    for (const method of ['GET', 'HEAD']) {
      const response = await call(`/d/${id}?dl=1`, { method, headers: curl });
      expect(response.status, method).toBe(503);
      if (method === 'GET') expect(await response.json()).toEqual({ error: 'This file needs a newer fyl.at.', code: 'unsupported_mode' });
    }
    const page = await call(`/d/${id}`, { headers: html });
    expect(page.status).toBe(503);
    expect((await pageOf(page)).data).toMatchObject({ state: 'gone', reason: 'unsupported_mode', mode: null, head: null, meta: null });
    const unknown = await (await info(id)).json<Record<string, unknown>>();
    expect([unknown.mode, 'e2ee' in unknown]).toEqual(['e2ee-v2', false]);
    expect(await record(id)).toMatchObject({ downloads: 0 });
    expect(await record(id)).not.toHaveProperty('session');
  });

  it('never previews an encrypted file and gives link-preview bots generic tags', async () => {
    const { session } = await sealedFile(10), id = session.uploadId;
    expect((await call(`/d/${id}?preview=1`, { headers: { 'User-Agent': 'Twitterbot/1.0', Accept: '*/*' } })).status).toBe(404);
    const page = await (await call(`/d/${id}`, { headers: { 'User-Agent': 'Twitterbot/1.0', Accept: '*/*' } })).text();
    expect(page).toContain('<meta property="og:description" content="An end-to-end encrypted file shared with you on fyl.at.">');
    expect(page).toContain('<meta name="twitter:card" content="summary">');
  });

  it('serves the download page\'s code and the E2EE modules for revalidation on every load, other vendor files as before', async () => {
    for (const path of ['/download.js', '/theme.js', '/e2ee/age.js', '/e2ee/core.js', '/e2ee/jobs.js', '/e2ee/worker.js', '/vendor/noble-ciphers-2.4.0/chacha.js', '/_dl/sw.js']) {
      const response = await call(path);
      await response.arrayBuffer();
      expect([response.status, response.headers.get('Cache-Control')], path).toEqual([200, 'no-cache']);
      expect(response.headers.has('Service-Worker-Allowed'), path).toBe(false);
    }
    const other = await call('/vendor/spark-md5-3.0.2.js');
    await other.arrayBuffer();
    expect(other.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('reads the id up to %23 for raw links too, and 404s /_dl/ addresses that reach the Worker', async () => {
    const raw = await file();
    for (const path of [`/d/${raw.receipt.id}%23anything`, `/d/${raw.receipt.id}%23`, `/d/${raw.receipt.id}%23x/y`]) {
      const response = await call(path, { headers: curl });
      expect([response.status, (await bytes(response)).length], path).toEqual([200, raw.payload.length]);
    }
    expect((await pageOf(await call(`/d/${raw.receipt.id}%23${'k'.repeat(43)}`, { headers: html }))).data).toMatchObject({ state: 'ready', url: raw.receipt.url });
    for (const path of ['/_dl/' + randomToken(), '/_dl/', '/_dl/a/b']) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.has('Service-Worker-Allowed')).toBe(false);
      await response.arrayBuffer();
    }
  });
});

describe('the switch, cleanup, reports and metrics (docs/E2EE.md §4.4, §12.2, §15.4, §17)', () => {
  it('blocks only new encrypted uploads when E2EE_ENABLED is off: running ones continue, ready ones download, and clients are told', async () => {
    const off = { E2EE_ENABLED: 'false' } as unknown as Partial<Env>, request = (path: string, init: RequestInit = {}) => direct(path, off, init);
    const sealed = await prepare(plaintext(1000)), session = await sealedInit(sealed), ready = await sealedFile(10);
    const md5 = md5Of(sealed.parts[0]);
    const pinned = await request('/api/upload/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.key },
      body: JSON.stringify({ uploadId: session.uploadId, partNumber: 1, md5 }) });
    expect(pinned.response.status).toBe(200);
    const sent = await request(`/api/upload/part?uploadId=${session.uploadId}&partNumber=1`, { method: 'PUT', body: sealed.parts[0],
      headers: { 'Content-Length': String(sealed.parts[0].length), Authorization: 'Bearer ' + session.key, 'Content-MD5': age.contentMd5(sealed.parts[0]) } });
    expect(sent.response.status).toBe(200);
    const etag = (await sent.response.json<{ etag: string }>()).etag;
    const completed = await request('/api/upload/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...session, parts: [{ partNumber: 1, etag }] }) });
    expect(completed.response.status).toBe(200);
    expect((await request(`/d/${ready.session.uploadId}?dl=1`, { headers: curl })).response.status).toBe(200);
    const config = await (await request('/config.js')).response.text();
    expect(config).toContain('"e2ee":false');
    expect(await (await request('/api/health')).response.json()).toMatchObject({ e2ee: false });
    const readiness = await operatorDirect('/api/admin/ready', { ...off, ADMIN_RATE: { limit: async () => ({ success: true }) } } as unknown as Partial<Env>,
      { headers: { Authorization: 'Bearer ' + OPERATOR_TOKEN } });
    expect(await readiness.response.json()).toMatchObject({ ready: true, e2ee: 'off' });
    expect(await (await call('/api/health')).json()).toMatchObject({ e2ee: true });
  });

  it('drops head, meta and the pins at cleanup: the tombstone keeps none of them', async () => {
    const { session, receipt } = await sealedFile(10);
    expect(await sql(transfer(session), 'SELECT number FROM pins')).toEqual([{ number: 1 }]);
    expect((await call(`/api/transfers/${receipt.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + receipt.deleteToken } })).status).toBe(200);
    const tombstone = await record(receipt.id);
    expect(tombstone).toMatchObject({ status: 'deleted', clean: true, name: '' });
    for (const field of ['head', 'meta']) expect(tombstone).not.toHaveProperty(field);
    expect(await sql(transfer(session), 'SELECT number FROM pins')).toBeNull();
    expect(await (await status(session)).json()).toMatchObject({ status: 'deleted', e2ee: null, pins: [] });
  });

  it('refuses report details and links that carry key material', async () => {
    const { receipt, sealed } = await sealedFile(10), key = sealed.prepared.key, link = `https://fyl.at/d/${receipt.id}`;
    const report = (extra: Record<string, unknown>) => direct('/api/reports', { REPORT_RATE: { limit: async () => ({ success: true }) } } as unknown as Partial<Env>, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, category: 'phishing', details: 'This file pretends to be an invoice from my bank.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true, ...extra }) });
    const refusal = { error: "Don't paste the key here.", code: 'key_material' };
    for (const extra of [{ details: `It came as ${link}#${key} in a mail I did not expect.` }, { details: `The key was #${key}, which opened a fake login page.` },
      { details: `Someone posted ${link}%23${key} in a forum thread about phishing.` }, { details: 'They sent age-secret-key-1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs too.' },
      { link: `${link}#${key}` }, { link: `${link}%23${key}` }]) {
      const { response } = await report(extra);
      expect([response.status, await response.json()], JSON.stringify(extra).slice(0, 60)).toEqual([400, refusal]);
    }
    // A transfer id is 43 characters of the same alphabet: without '#' it is no key, and the report is taken.
    const { response } = await report({ details: `The transfer ${receipt.id} is a phishing page.` });
    expect(response.status).toBe(201);
  });

  it('refuses key material in the contact fields too, so no case ever stores a key (docs/E2EE.md §15.4)', async () => {
    const { receipt, sealed } = await sealedFile(10), key = sealed.prepared.key, link = `https://fyl.at/d/${receipt.id}`;
    const report = (extra: Record<string, unknown>) => direct('/api/reports', { REPORT_RATE: { limit: async () => ({ success: true }) } } as unknown as Partial<Env>, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, category: 'phishing', details: 'This file pretends to be an invoice from my bank.', name: 'Ada Reporter', email: 'ada@example.org', goodFaith: true, ...extra }) });
    const refusal = { error: "Don't paste the key here.", code: 'key_material' };
    // The name and the email are free text of 200 and 254 characters; a key fits either (an address keeps '#').
    for (const extra of [{ name: `#${key}` }, { name: `Ada ${link}#${key}` }, { name: 'AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS' },
      { email: `#${key}@example.org` }, { email: `ada@example.org#${key}` }]) {
      const { response } = await report(extra);
      expect([response.status, await response.json()], JSON.stringify(extra).slice(0, 60)).toEqual([400, refusal]);
    }
    const cases = await runInDurableObject(env.REPORTS.getByName('reports-v1'), (_instance, ctx) =>
      ctx.storage.sql.exec<{ name: string | null; email: string | null; details: string }>('SELECT name, email, details FROM cases WHERE transfer_id=?', receipt.id).toArray());
    expect(JSON.stringify(cases)).not.toContain(key);
  });

  it('counts encrypted completions by mode and every refusal by its code, never with an id', async () => {
    const metrics = dataset(), sealed = await prepare(plaintext(10)), session = await sealedInit(sealed);
    await counted(session, metrics, async () => {
      const parts = [await sealedPart(session, sealed, 1)];
      expect((await pin(session, 1, 'a'.repeat(32))).status).toBe(409);
      expect((await post('/api/upload/complete', { ...session, parts })).status).toBe(200);
    });
    expect(metrics.events).toEqual(expect.arrayContaining(['part_confirmed', 'part_refused:part_changed', 'upload_completed:e2ee:other']));
    const text = JSON.stringify(metrics.points);
    for (const value of [session.uploadId, session.key, sealed.body.e2ee.head.slice(0, 40), sealed.body.e2ee.meta.slice(0, 40)]) expect(text).not.toContain(value);
  });
});
