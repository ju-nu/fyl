import { expect } from 'vitest';
// @ts-expect-error: dist/e2ee is plain browser ES modules without type declarations; Age below describes what these tests use.
import * as ageModule from '../dist/e2ee/age.js';
import { call, post, type Session } from './helpers';

// End-to-end encrypted uploads for the Worker tests, made with the browser's crypto core (dist/e2ee, docs/E2EE.md) as
// the upload page makes them: real heads, metadata and parts, so the server's checks meet what clients send.

interface ContentKey { readonly head: Uint8Array; readonly size: number }
export interface Prepared { identity: Uint8Array; key: string; name: string; size: number; ciphertextSize: number; head: Uint8Array; meta: Uint8Array; content: ContentKey }
interface Age {
  PART: number;
  prepareUpload(name: string, size: number, options?: { maxFileBytes?: number }): Promise<Prepared>;
  encryptPart(content: ContentKey, source: Uint8Array, part: number, options?: { partSize?: number }): Promise<Uint8Array>;
  checkKey(identity: Uint8Array | string, head: Uint8Array, meta: Uint8Array, ciphertextSize: number): Promise<{ name: string; size: number; content: ContentKey }>;
  decryptBytes(key: ContentKey | Uint8Array | string, data: Uint8Array, options?: { verifiedHead?: Uint8Array }): Promise<Uint8Array>;
  encodeBlob(data: Uint8Array): string;
  decodeBlob(text: string): Uint8Array;
  md5Hex(data: Uint8Array): string;
  contentMd5(data: Uint8Array): string;
}
export const age = ageModule as Age;

/** Plaintext of `size` bytes: byte i is i mod 251, as in the shared vectors. */
export const plaintext = (size: number) => Uint8Array.from({ length: size }, (_, index) => index % 251);

/** An encrypted upload of `data`, prepared like §7 step 1: the init body (without a password) and its parts. */
export async function prepare(data: Uint8Array, name = 'Quarterly report.pdf') {
  const prepared = await age.prepareUpload(name, data.length);
  const parts: Uint8Array[] = [];
  for (let part = 1; part <= Math.ceil(prepared.ciphertextSize / age.PART); part++) parts.push(await age.encryptPart(prepared.content, data, part));
  const body = { mode: 'e2ee', size: prepared.ciphertextSize, e2ee: { head: age.encodeBlob(prepared.head), meta: age.encodeBlob(prepared.meta) }, expiresIn: 86400 };
  return { prepared, parts, body, data };
}
export type Sealed = Awaited<ReturnType<typeof prepare>>;

export async function sealedInit(sealed: Sealed, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await post('/api/upload/init', { ...sealed.body, ...extra }, headers);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<Session & { mode: string }>();
}

export const pin = (session: Session, number: number, md5: string, key = session.key) => call('/api/upload/pin', {
  method: 'POST', body: JSON.stringify({ uploadId: session.uploadId, partNumber: number, md5 }),
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
});

/** An encrypted part request with the Content-MD5 header given (none for null); the caller checks the outcome. */
export const sealedPut = (session: Session, payload: Uint8Array, number: number, contentMd5: string | null) => call('/api/upload/part?' + new URLSearchParams({ uploadId: session.uploadId, partNumber: String(number) }), {
  method: 'PUT', body: payload,
  headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.byteLength), Authorization: 'Bearer ' + session.key,
    ...(contentMd5 === null ? {} : { 'Content-MD5': contentMd5 }) },
});

/** Pins and sends part `number` as a conforming client does (§8.2, §8.3), and returns it for the completion. */
export async function sealedPart(session: Session, sealed: Sealed, number: number) {
  const payload = sealed.parts[number - 1];
  expect((await pin(session, number, age.md5Hex(payload))).status).toBe(200);
  const response = await sealedPut(session, payload, number, age.contentMd5(payload));
  expect(response.status, await response.clone().text()).toBe(200);
  return { partNumber: number, ...(await response.json<{ etag: string }>()) };
}

/** A whole encrypted upload of `size` bytes, completed with the management key. */
export async function sealedFile(size = 1000, extra: Record<string, unknown> = {}, name?: string) {
  const sealed = await prepare(plaintext(size), name), session = await sealedInit(sealed, extra);
  const parts = [];
  for (let number = 1; number <= sealed.parts.length; number++) parts.push(await sealedPart(session, sealed, number));
  const response = await post('/api/upload/complete', { ...session, parts });
  expect(response.status, await response.clone().text()).toBe(200);
  return { sealed, session, parts, receipt: await response.json<Record<string, unknown> & { id: string; url: string; deleteToken: string }>() };
}
