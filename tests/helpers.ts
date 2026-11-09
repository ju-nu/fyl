import { env, exports as main } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import worker from '../src/index';
import { networkHash, networkOf, type TransferRecord } from '../src/shared';

// Shared request helpers for the Worker test files. Each file picks its own address range with useNetworkPrefix(), so
// per-network rate limits and budgets of different files never collide (vitest.config.ts refuses a range used twice).
let prefix = '192.0.2.';
export const useNetworkPrefix = (value: string) => { prefix = value; };
/** The client address `host` (1 to 254) in this file's range, for a test that needs a fixed one. */
export const address = (host: number) => `${prefix}${host}`;
let ip = 1;
/** Calls the Worker as a client would; `path` is on https://fyl.at, or a whole URL (another host, such as the admin host). */
export const call = (path: string, init: RequestInit = {}, from?: string) => {
  const headers = new Headers(init.headers);
  headers.set('CF-Connecting-IP', from || `${prefix}${ip++ % 250 + 1}`);
  return main.default.fetch(/^https?:\/\//.test(path) ? path : `https://fyl.at${path}`, { ...init, headers });
};
export const post = (path: string, data: unknown, headers: Record<string, string> = {}) => call(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
});
/**
 * Calls the Worker's fetch handler with some bindings replaced, from the file's .251; `settled` waits for its waitUntil
 * work. `path` is on https://fyl.at, or a whole URL (another host, such as the admin host).
 */
export async function direct(path: string, bindings: Partial<Env>, init: RequestInit = {}) {
  const headers = new Headers(init.headers), ctx = createExecutionContext();
  headers.set('CF-Connecting-IP', `${prefix}251`);
  const url = /^https?:\/\//.test(path) ? path : `https://fyl.at${path}`;
  const response = await worker.fetch(new Request(url, { ...init, headers }), { ...env, ...bindings }, ctx);
  return { response, settled: () => waitOnExecutionContext(ctx) };
}
export interface Session { uploadId: string; key: string; url: string }
export interface Receipt { id: string; url: string; deleteToken: string; expiresAt: number; managementUrl: string }

/** Starts an upload; with a `password`, its download needs it. */
export async function init(size: number, once = false, name = "report & '旅行'.zip", password?: string) {
  const response = await post('/api/upload/init', { filename: name, size, oneTime: once, expiresIn: 86400, password });
  expect(response.status).toBe(201);
  return response.json<Session>();
}
/** A part request whose outcome the caller checks itself. */
export const put = (session: Session, payload: Uint8Array, number = 1) => call('/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: String(number) }), {
  method: 'PUT', body: payload,
  headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.byteLength), Authorization: 'Bearer ' + session.key },
});
export async function part(session: Session, payload: Uint8Array, number = 1) {
  const response = await put(session, payload, number);
  expect(response.status).toBe(200);
  return { partNumber: number, ...(await response.json<{ etag: string }>()) };
}
export async function finish(session: Session, parts: R2UploadedPart[]) {
  const response = await post('/api/upload/complete', { ...session, parts });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<Receipt>();
}
export async function file(once = false, password?: string, name?: string) {
  const payload = new TextEncoder().encode('a real R2 fixture');
  const session = await init(payload.length, once, name, password);
  const parts = [await part(session, payload)];
  const receipt = await finish(session, parts);
  return { session, receipt, payload, parts };
}
export const pathOf = (url: string) => new URL(url).pathname;

/** What the Worker injected into a download page: the JSON state block and the <html> start tag with its flags. */
export interface PageData {
  state: string; id: string | null; name: string | null; size: number | null; type: string | null; ext: string | null;
  expiresAt: number | null; once: boolean; protected: boolean; risky: boolean; url: string | null; downloadUrl: string | null;
  received: number | null; updatedAt: number | null; reason: string | null; error: string | null; triesLeft: number | null; pausedUntil: number | null;
  now: number;
}
export async function pageOf(response: Response) {
  expect(response.headers.get('Content-Type')).toContain('text/html');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.has('WWW-Authenticate')).toBe(false);
  const html = await response.text(), block = /<script type="application\/json" id="fyl-state">(.*?)<\/script>/s.exec(html);
  if (!block) throw new Error('The download page has no state block.');
  return { html, root: /<html[^>]*>/.exec(html)?.[0] || '', data: JSON.parse(block[1]) as PageData };
}
export const OPERATOR_TOKEN = 'test-operator-token-0123456789abcdef';

// Cloudflare Access in front of the admin host, as the tests sign it: the team and audience are wrangler.jsonc's, the
// owner is the ADMIN_EMAILS that vitest.config.ts binds, and one RSA key pair (kid k1) stands in for the team's keys.
export const ADMIN = `https://${env.ADMIN_HOST}`;
export const OWNER_EMAIL = 'owner@example.org';
export const ACCESS_TEAM = String(env.ACCESS_TEAM_DOMAIN), ACCESS_CERTS = `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
const encode = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
let pair: Promise<CryptoKeyPair> | undefined;
/** The key pair the tests' Access tokens are signed with; publish its public half as kid k1. */
export const accessKeys = () => {
  pair ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  return pair;
};
export const jwkOf = async (key: CryptoKey, kid: string) => ({ ...await crypto.subtle.exportKey('jwk', key) as JsonWebKey, kid, alg: 'RS256', use: 'sig' });
/** A Cloudflare Access application token, as Access would sign it (the owner's identity by default; `common_name` for a service token). */
export async function accessJwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key?: CryptoKey) {
  const now = Math.floor(Date.now() / 1000), signing = key ?? (await accessKeys()).privateKey;
  const head = b64(encode(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header })));
  const body = b64(encode(JSON.stringify({ aud: [String(env.ACCESS_AUD)], iss: `https://${ACCESS_TEAM}`, iat: now, nbf: now, exp: now + 3600, email: OWNER_EMAIL, type: 'app', ...claims })));
  return `${head}.${body}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing, encode(`${head}.${body}`))))}`;
}
/** A service token's Access JWT, as the operator scripts' CF-Access-Client-Id/Secret get one. */
export const serviceJwt = () => accessJwt({ email: undefined, common_name: '0123abcd.access', sub: '' });

/**
 * Runs `work` while the Worker's fetch of the team's certs endpoint answers the tests' key. A file that stubs fetch
 * itself (tests/admin-host.test.ts) answers that endpoint in its stub, so nothing is wrapped there. Overlapping calls
 * share one wrapper, which the last of them removes.
 */
let certsUsers = 0, unwrapped: typeof fetch | undefined;
async function withAccessCerts<T>(work: () => Promise<T>): Promise<T> {
  if (vi.isMockFunction(globalThis.fetch)) return work();
  const published = [await jwkOf((await accessKeys()).publicKey, 'k1')];
  if (certsUsers++ === 0) {
    const previous = globalThis.fetch;
    unwrapped = previous;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input) === ACCESS_CERTS
      ? Promise.resolve(Response.json({ keys: published })) : previous(input, init)) as typeof fetch;
  }
  try { return await work(); }
  finally { if (--certsUsers === 0 && unwrapped) globalThis.fetch = unwrapped; }
}
/** An operator call on the admin host: through Access with a service token, then the bearer `token`. */
export const operator = (path: string, init: RequestInit = {}, token = OPERATOR_TOKEN) => withAccessCerts(async () =>
  call(ADMIN + path, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await serviceJwt(), ...init.headers } }));
export const pause = (paused: boolean) => operator('/api/admin/uploads', { method: 'POST', body: JSON.stringify({ paused }) });
/** direct() on the admin host, through Access with a service token: for operator calls with some bindings replaced. */
export const operatorDirect = (path: string, bindings: Partial<Env>, init: RequestInit = {}) => withAccessCerts(async () => {
  const headers = new Headers(init.headers);
  headers.set('Cf-Access-Jwt-Assertion', await serviceJwt());
  return direct(ADMIN + path, bindings, { ...init, headers });
});

// The transfer record as its Durable Object stores it, to read or to change behind the API's back.
const payloadOf = (ctx: DurableObjectState) =>
  JSON.parse(ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM transfer WHERE id=1').one().payload) as TransferRecord;
export const record = (id: string) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => payloadOf(ctx));
export const edit = (id: string, change: (record: TransferRecord) => void) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => {
  const value = payloadOf(ctx);
  change(value);
  ctx.storage.sql.exec('UPDATE transfer SET payload=? WHERE id=1', JSON.stringify(value));
});

/** Wrong password tries per network as the transfer counts them (none before the first wrong try). */
export const tries = (id: string) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => {
  try { return ctx.storage.sql.exec<{ network: string; fails: number; paused_until: number }>('SELECT network, fails, paused_until FROM tries ORDER BY network').toArray(); }
  catch { return []; }
});
/** Ends the pauses of every network that tried a transfer's password. */
export const unpause = (id: string) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => {
  ctx.storage.sql.exec('UPDATE tries SET paused_until=? WHERE paused_until>0', Date.now() - 1);
});
/** The per-transfer network hash claim and unlock get for a client address; password tries count per `bits` 56 (a subscriber). */
export const networkOfClient = (address: string, id: string, bits: 64 | 56 = 64) => networkHash(env.NETWORK_HASH_KEY, networkOf(address, bits) + ':' + id);

/** Durable Objects keep the env they were created with: replaces bindings on the live instance; call the result to undo. */
export async function swap(stub: DurableObjectStub, bindings: (original: Env) => Partial<Env>) {
  let original: Env | undefined;
  await runInDurableObject(stub, instance => {
    const target = instance as unknown as { env: Env };
    original = target.env; target.env = { ...original, ...bindings(original) };
  });
  return () => runInDurableObject(stub, instance => { (instance as unknown as { env: Env }).env = original as Env; });
}
