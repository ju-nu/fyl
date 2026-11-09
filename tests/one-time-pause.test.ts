import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PASSWORD_PAUSE_MS, PASSWORD_TRIES, PASSWORD_TRANSFER_TRIES } from '../src/shared';
import { call, file, pathOf, pageOf, record, edit, tries, networkOfClient, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.40.');

const PASSWORD = 'tide-lamp-fern-41';
const html = { Accept: 'text/html,application/xhtml+xml' };
const basic = (password: string) => ({ Authorization: 'Basic ' + btoa('fyl:' + password) });
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const form = (password: string): RequestInit => ({ method: 'POST', body: new URLSearchParams({ password }).toString(),
  headers: { ...html, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fyl.at' } });
const alarmIn = (id: string, ms: number) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => ctx.storage.setAlarm(Date.now() + ms));
const alarmAt = (id: string) => runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => ctx.storage.getAlarm());
const info = (id: string, from: string) => call(`/api/transfers/${id}`, { headers: { Accept: 'application/json', ...basic(PASSWORD) } }, from);
// DOWNLOAD_IDLE_MS, as long as PASSWORD_PAUSE_MS.
const IDLE_MS = 15 * 60 * 1000;
/** Lets `ms` pass for a transfer: every time stored for its lifetime, session and password pauses moves that much back. */
async function elapse(id: string, ms: number) {
  await edit(id, stored => {
    stored.expiresAt -= ms;
    if (stored.pwPausedUntil) stored.pwPausedUntil -= ms;
    if (stored.session) {
      stored.session.startedAt -= ms; stored.session.lastAt -= ms;
      if (stored.session.pausedUntil) stored.session.pausedUntil -= ms;
    }
  });
  // The tries tables exist from the first wrong try on.
  if ((await tries(id)).length) await runInDurableObject(env.TRANSFERS.getByName(id), (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE tries SET paused_until=paused_until-? WHERE paused_until>0', ms);
    ctx.storage.sql.exec('UPDATE wrong_tries SET at=at-?', ms);
  });
}
/** Fifty wrong tries from ten other networks within a minute: the whole transfer pauses (the accepted limit). */
async function pauseFromElsewhere(path: string, id: string) {
  for (let net = 1; net <= PASSWORD_TRANSFER_TRIES / PASSWORD_TRIES; net++)
    for (let attempt = 0; attempt < PASSWORD_TRIES; attempt++) await (await call(path, { headers: basic('guess-' + attempt) }, `198.18.41.${net}`)).text();
  const until = (await record(id)).pwPausedUntil as number;
  expect(until).toBeGreaterThan(Date.now() + PASSWORD_PAUSE_MS - 60000);
  return until;
}

/**
 * A one-time download session may idle for as long as a password pause lasts (15 minutes each). A pause of the whole
 * transfer, which ten networks can bring about without the password, must not lock out the network holding the
 * session: refused until the pause ends, it would find its session idled out and the link consumed, the file gone.
 */
describe('a one-time session through a pause of the whole transfer', () => {
  it('keeps serving the network holding the session, file and page, while every other network waits', async () => {
    const { receipt, session, payload } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId, holder = '198.18.40.10';
    // The recipient gives the password and opens the session with the first of several ranges (a resumable download).
    const first = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-3' } }, holder);
    expect(first.status).toBe(206);
    expect(await bytes(first)).toEqual(payload.subarray(0, 4));
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    const until = await pauseFromElsewhere(path, id);
    // It refuses the holder nowhere, so it doesn't hold the session either (see Transfer.hold()).
    expect((await record(id)).session?.pausedUntil).toBeUndefined();
    // Everyone else is paused, right password or not (and the page tells them the link is someone else's download).
    const other = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=4-' } }, '198.18.40.11');
    expect([other.status, other.headers.get('Retry-After')]).toEqual([429, expect.stringMatching(/^\d+$/)]);
    await other.text();
    expect((await pageOf(await call(path, { headers: html }, '198.18.40.12'))).data).toMatchObject({ state: 'gone', reason: 'consumed' });
    // The holder is not: its page shows no pause, its form unlocks, and its next range arrives, restarting the idle time.
    expect((await pageOf(await call(path, { headers: html }, holder))).data).toMatchObject({ state: 'protected', error: null, triesLeft: PASSWORD_TRIES, pausedUntil: null });
    const unlocked = await call(path, form(PASSWORD), holder);
    expect(unlocked.status).toBe(200);
    expect((await pageOf(unlocked)).data).toMatchObject({ state: 'unlocked', error: null, name: "report & '旅行'.zip" });
    const before = (await record(id)).session?.lastAt as number;
    const during = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=4-7' } }, holder);
    expect([during.status, during.headers.get('Content-Range')]).toEqual([206, `bytes 4-7/${payload.length}`]);
    expect(await bytes(during)).toEqual(payload.subarray(4, 8));
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    const stored = await record(id);
    expect(stored.status).toBe('ready');
    expect(stored.session?.lastAt).toBeGreaterThanOrEqual(before);
    // The pause itself stays for the others, and the holder's right password was no free try for anyone.
    expect(stored.pwPausedUntil).toBe(until);
    expect((await call(path, { headers: basic(PASSWORD) }, '198.18.40.11')).status).toBe(429);
    expect(await tries(id)).toHaveLength(PASSWORD_TRANSFER_TRIES / PASSWORD_TRIES);
    // The holder's own wrong tries still count: five in a row pause its network like any other.
    for (let attempt = 0; attempt < PASSWORD_TRIES; attempt++) {
      const wrong = await call(path, { headers: basic('typo-' + attempt) }, holder);
      expect([attempt, wrong.status]).toEqual([attempt, attempt < PASSWORD_TRIES - 1 ? 401 : 429]);
      await wrong.text();
    }
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=8-' } }, holder)).status).toBe(429);
    const guesser = await networkOfClient(holder, id, 56), own = (await tries(id)).find(row => row.network === guesser);
    expect((await record(id)).session?.pausedUntil).toBe(own?.paused_until);
    expect(own?.paused_until).toBeGreaterThan(until);
    // Its client waits out Retry-After: the session's idle time ran out during that pause, and the session is still there.
    await elapse(id, PASSWORD_PAUSE_MS + 1000);
    expect((await record(id)).session?.lastAt).toBeLessThan(Date.now() - IDLE_MS);
    // The holder finishes the download, which closes the link as a delivery does.
    const rest = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-' } }, holder);
    expect(rest.status).toBe(206);
    expect(await bytes(rest)).toEqual(payload);
    await expect.poll(async () => (await record(id)).status).toBe('consumed');
    expect(await env.FILES.head(`files/${id}`)).toBeNull();
  });

  it('closes the session by the idle time counted from the holder\'s last response, never from before a pause', async () => {
    const { receipt, session } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId, holder = '198.18.40.20';
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-1' } }, holder)).status).toBe(206);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    await pauseFromElsewhere(path, id);
    // Halfway through the pause the holder resumes; the idle time runs from then, past the pause's end.
    await edit(id, stored => { if (stored.session) stored.session.lastAt = Date.now() - PASSWORD_PAUSE_MS / 2; });
    const resumed = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=2-3' } }, holder);
    expect(resumed.status).toBe(206);
    await bytes(resumed);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    expect((await record(id)).session?.lastAt).toBeGreaterThan(Date.now() - 5000);
    // When the pause ends, the alarm finds the session still in its idle time: nothing closes, nothing is deleted.
    await edit(id, stored => { stored.pwPausedUntil = Date.now() - 1; });
    await alarmIn(id, 60000);
    expect(await runDurableObjectAlarm(env.TRANSFERS.getByName(id))).toBe(true);
    expect((await record(id)).status).toBe('ready');
    expect(await env.FILES.head(`files/${id}`)).not.toBeNull();
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=4-' } }, holder)).status).toBe(206);
    // Another network with the right password is still refused: the session is the holder's.
    expect((await call(path, { headers: basic(PASSWORD) }, '198.18.40.21')).status).toBe(410);
  });

  it('lets an abandoned session idle out while the whole transfer is paused: guessing without the password keeps no file', async () => {
    const { receipt, session } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId, holder = '198.18.40.25';
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-1' } }, holder)).status).toBe(206);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    // Ten minutes after the holder's last response, ten other networks pause the whole transfer.
    await elapse(id, 10 * 60 * 1000);
    await pauseFromElsewhere(path, id);
    expect((await record(id)).session?.pausedUntil).toBeUndefined();
    // Six minutes on, the holder (never refused) stayed away for longer than the idle time; the pause runs on.
    await elapse(id, 6 * 60 * 1000);
    expect((await record(id)).pwPausedUntil).toBeGreaterThan(Date.now() + 8 * 60 * 1000);
    await alarmIn(id, 60000);
    expect(await runDurableObjectAlarm(env.TRANSFERS.getByName(id))).toBe(true);
    expect((await record(id)).status).toBe('consumed');
    expect(await env.FILES.head(`files/${id}`)).toBeNull();
    const gone = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=2-' } }, holder);
    expect([gone.status, (await gone.json<{ code: string }>()).code]).toEqual([410, 'consumed']);
  });

  it('answers the holder\'s info with the password through the pause too, which fyl download and the encrypted page ask first', async () => {
    const { receipt, session } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId;
    // The session belongs to the holder's /64; its tries count for its /56, which the neighbour's /64 shares.
    const holder = '2001:db8:40:100::1', neighbour = '2001:db8:40:1a0::1';
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-3' } }, holder)).status).toBe(206);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    await pauseFromElsewhere(path, id);
    // A rerun of fyl download (or a reload of the page) from another address of the holder's /64 gets the metadata.
    const rerun = await info(id, '2001:db8:40:100::77');
    expect([rerun.status, await rerun.json()]).toEqual([200, expect.objectContaining({ state: 'ready', once: true, protected: true, owner: false, name: "report & '旅行'.zip" })]);
    // Everyone else waits, the neighbour on the holder's /56 too.
    for (const from of [neighbour, '198.18.40.31']) {
      const paused = await info(id, from);
      expect([paused.status, (await paused.json<{ code: string }>()).code]).toEqual([429, 'password_paused']);
    }
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=4-7' } }, holder)).status).toBe(206);
  });

  it('holds the session through a pause of the holder\'s own network, and closes it a whole idle time after the pause', async () => {
    const { receipt, session } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId, holder = '198.18.40.30';
    const stub = env.TRANSFERS.getByName(id);
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-1' } }, holder)).status).toBe(206);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    // Ten minutes after its last response the holder mistypes five times: its network pauses beyond the idle time.
    await elapse(id, 10 * 60 * 1000);
    for (let attempt = 0; attempt < PASSWORD_TRIES; attempt++) await (await call(path, { headers: basic('typo-' + attempt) }, holder)).text();
    const [own] = await tries(id), { lastAt, pausedUntil } = (await record(id)).session ?? {};
    expect(pausedUntil).toBe(own.paused_until);
    expect(own.paused_until).toBeGreaterThan((lastAt as number) + IDLE_MS + 4 * 60 * 1000);
    // Six minutes on, the idle time is over but the pause is not: the alarm due then keeps the session and the file.
    await elapse(id, 6 * 60 * 1000);
    await alarmIn(id, 60000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await record(id)).status).toBe('ready');
    expect(await env.FILES.head(`files/${id}`)).not.toBeNull();
    expect(await alarmAt(id)).toBe((own.paused_until - 6 * 60 * 1000) + IDLE_MS);
    // A request meanwhile is refused by the pause and closes nothing either.
    const refused = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=2-' } }, holder);
    expect(refused.status).toBe(429);
    await refused.text();
    expect((await record(id)).status).toBe('ready');
    // No client waits a pause out by itself (fyl download exits with the time to try again), so the idle time runs from
    // the pause's end: 14 minutes after it the alarm still keeps the session for the holder to come back.
    const end = async () => (await record(id)).session?.pausedUntil as number;
    await elapse(id, await end() - Date.now() + 14 * 60 * 1000);
    await alarmIn(id, 60000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await record(id)).status).toBe('ready');
    expect(await env.FILES.head(`files/${id}`)).not.toBeNull();
    // A whole idle time after the pause without the holder: the session closes as consumed and the file is deleted.
    await elapse(id, await end() - Date.now() + IDLE_MS + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await record(id)).status).toBe('consumed');
    expect(await env.FILES.head(`files/${id}`)).toBeNull();
    const gone = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=2-' } }, holder);
    expect([gone.status, (await gone.json<{ code: string }>()).code]).toEqual([410, 'consumed']);
  });

  it('holds the session through a pause from a neighbour on the holder\'s /56, also one running when a grant opened it', async () => {
    const { receipt, session, payload } = await file(true, PASSWORD), path = pathOf(receipt.url), id = session.uploadId;
    const holder = '2001:db8:40:200::1', neighbour = '2001:db8:40:2b0::1';
    // The holder unlocks the page, then a neighbour on its /56 (another /64 of the same line) pauses their network.
    const { downloadUrl } = (await pageOf(await call(path, form(PASSWORD), holder))).data, grant = new URL(downloadUrl as string);
    for (let attempt = 0; attempt < PASSWORD_TRIES; attempt++) await (await call(path, { headers: basic('guess-' + attempt) }, neighbour)).text();
    const [line] = await tries(id);
    expect(line.network).toBe(await networkOfClient(holder, id, 56));
    // The grant opens the session through that pause, which holds it from the start.
    const first = await call(grant.pathname + grant.search, { headers: { Range: 'bytes=0-3' } }, holder);
    expect(first.status).toBe(206);
    await bytes(first);
    await expect.poll(async () => (await record(id)).session?.open).toBe(0);
    expect((await record(id)).session).toMatchObject({ network: await networkOfClient(holder, id), guesser: line.network, pausedUntil: line.paused_until });
    // Basic from the holder waits for the pause like the neighbour (curl, or the page after its grant's hour).
    expect((await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=4-' } }, holder)).status).toBe(429);
    // Past the idle time, the pause over for three minutes: the alarm keeps the session (its idle time runs from the
    // pause's end), and the holder, back after the time it was told to wait, downloads the whole file, which closes the
    // link as a delivery does.
    await elapse(id, IDLE_MS + 3 * 60 * 1000);
    expect((await record(id)).session?.lastAt).toBeLessThan(Date.now() - IDLE_MS);
    await alarmIn(id, 60000);
    expect(await runDurableObjectAlarm(env.TRANSFERS.getByName(id))).toBe(true);
    expect((await record(id)).status).toBe('ready');
    const rest = await call(path, { headers: { ...basic(PASSWORD), Range: 'bytes=0-' } }, holder);
    expect(rest.status).toBe(206);
    expect(await bytes(rest)).toEqual(payload);
    await expect.poll(async () => (await record(id)).status).toBe('consumed');
  });
});
