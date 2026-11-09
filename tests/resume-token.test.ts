import { describe, expect, it } from 'vitest';
import { digest, resumeToken } from '../src/shared';
import { call, post, init, part, put, finish, file, pathOf, record, edit, useNetworkPrefix, type Session } from './helpers';

useNetworkPrefix('198.18.4.');

const payload = new TextEncoder().encode('resumable fixture');
const status = (session: Session) => call(`/api/upload/status?uploadId=${session.uploadId}`, { headers: { Authorization: 'Bearer ' + session.key } });
const owner = (id: string, key: string, init: RequestInit = {}) =>
  call(`/api/transfers/${id}`, { ...init, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } });
const resumable = async (session: Session) => ({ ...session, key: await resumeToken(session.key) });

describe('resume token', () => {
  it('is derived from the key, differs from it and is stored only as a hash', async () => {
    const session = await init(payload.length);
    const token = await resumeToken(session.key);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(session.key);
    expect(token).toBe(await resumeToken(session.key));
    // The CLI derives it on its own: this vector is pinned in tests/test_cli.py as well.
    expect(await resumeToken('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_')).toBe('V6sO2to1wFlealOmFdn5p7nK8Ylb6xzK4pJCkCUmSm8');
    const stored = await record(session.uploadId);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.resumeHash).toBe(await digest(token));
  });

  it('continues and completes an upload, but its receipt carries no management link', async () => {
    const session = await init(payload.length), resume = await resumable(session);
    const before = await status(resume);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ status: 'uploading', access: 'resume', size: payload.length, parts: [] });
    const parts = [await part(resume, payload)];
    expect((await (await status(resume)).json<{ parts: { partNumber: number; etag: string }[] }>()).parts)
      .toEqual([{ partNumber: 1, size: payload.length, etag: parts[0].etag }]);
    const receipt = await finish(resume, parts);
    expect(receipt).not.toHaveProperty('managementUrl');
    expect(receipt).not.toHaveProperty('deleteToken');
    expect(new Uint8Array(await (await call(pathOf(receipt.url))).arrayBuffer())).toEqual(payload);
    // Replays: the key still gets its management link, the resume token still doesn't.
    const managed = await finish(session, parts);
    expect(managed).toMatchObject({ id: receipt.id, url: receipt.url, deleteToken: session.key });
    expect(managed.managementUrl).toBe(`https://fyl.at/#manage/${receipt.id}/${session.key}`);
    expect(await finish(resume, parts)).toEqual({ ...receipt, downloads: 1 });
  });

  it('works alongside the key on one upload, the status says which of them it got, and a completion with the key is unchanged', async () => {
    const session = await init(payload.length), resume = await resumable(session);
    expect(await (await status(session)).json()).toMatchObject({ status: 'uploading', access: 'owner' });
    const parts = [await part(resume, payload)];
    const receipt = await finish(session, parts);
    expect(receipt).toMatchObject({ deleteToken: session.key, managementUrl: `https://fyl.at/#manage/${receipt.id}/${session.key}` });
    expect(await (await status(resume)).json()).toMatchObject({ status: 'ready', access: 'resume' });
    expect(await (await status(session)).json()).toMatchObject({ status: 'ready', access: 'owner' });
  });

  it('aborts an incomplete upload but never a completed one', async () => {
    const session = await init(payload.length), resume = await resumable(session);
    await part(resume, payload);
    const aborted = await post('/api/upload/abort', resume);
    expect(aborted.status).toBe(200);
    expect(await aborted.json()).toEqual({ aborted: true });
    expect((await (await status(session)).json<{ status: string }>()).status).toBe('aborted');
    expect((await put(resume, payload)).status).toBe(410);
    const done = await file();
    const refused = await post('/api/upload/abort', await resumable(done.session));
    expect(refused.status).toBe(409);
    expect((await call(pathOf(done.receipt.url))).status).toBe(200);
  });

  it('gets the same 403 as a wrong key on the owner routes, and the file stays as it was', async () => {
    const { session, receipt } = await file();
    const token = await resumeToken(session.key), wrong = 'w'.repeat(43);
    const requests: RequestInit[] = [{}, { method: 'PATCH', body: JSON.stringify({ expiresIn: 300 }) }, { method: 'DELETE' }];
    for (const request of requests) {
      const denied = await owner(receipt.id, token, request), reference = await owner(receipt.id, wrong, request);
      expect([denied.status, await denied.json()]).toEqual([403, await reference.json()]);
      expect(reference.status).toBe(403);
    }
    const info = await owner(receipt.id, session.key);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ owner: true, minutes: 1440, expiresAt: receipt.expiresAt, state: 'ready' });
    expect((await call(pathOf(receipt.url))).status).toBe(200);
    expect((await owner(receipt.id, session.key, { method: 'DELETE' })).status).toBe(200);
  });

  it('refuses the resume token on a record without resumeHash', async () => {
    const session = await init(payload.length), resume = await resumable(session);
    await edit(session.uploadId, record => { delete record.resumeHash; });
    for (const response of [await status(resume), await put(resume, payload), await post('/api/upload/complete', { ...resume, parts: [{ partNumber: 1, etag: 'x' }] }),
      await post('/api/upload/abort', resume)]) {
      expect(response.status).toBe(403);
      expect((await response.json<{ code: string }>()).code).toBe('denied');
    }
    const receipt = await finish(session, [await part(session, payload)]);
    expect(receipt.deleteToken).toBe(session.key);
  });

  it('only matches the key it was derived from', async () => {
    const session = await init(payload.length), other = await init(payload.length);
    const response = await status({ ...session, key: await resumeToken(other.key) });
    expect(response.status).toBe(403);
  });
});
