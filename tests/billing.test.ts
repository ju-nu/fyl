import { describe, expect, it } from 'vitest';
import { BASE, PRICES, cycleDay, cycleOf, estimate, micros, operationClass, pace, sampleUsage, storageByDay, usageOf, workerErrorsOf, type MeterId, type Price, type Usage } from '../src/billing';

const at = (iso: string) => Date.parse(iso);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const price = (id: MeterId) => PRICES.find(entry => entry.id === id) as Price;
const none = (): Usage => Object.fromEntries(PRICES.map(entry => [entry.id, 0])) as Usage;

describe('billing cycle', () => {
  it('starts on the cycle day at midnight UTC and ends where the next one starts', () => {
    const cycle = cycleOf(at('2026-10-31T00:10:00Z'), 28);
    expect([day(cycle.start), day(cycle.end), cycle.days]).toEqual(['2026-10-28', '2026-11-28', 31]);
    // The first instant of the day belongs to the new cycle, the last one before it to the old one.
    expect(day(cycleOf(at('2026-11-28T00:00:00Z'), 28).start)).toBe('2026-11-28');
    expect(day(cycleOf(at('2026-11-27T23:59:59.999Z'), 28).start)).toBe('2026-10-28');
    // Before the day in its month a date belongs to the cycle that began the month before, across the year too.
    expect([day(cycleOf(at('2027-01-03T12:00:00Z'), 28).start), day(cycleOf(at('2027-01-03T12:00:00Z'), 28).end)]).toEqual(['2026-12-28', '2027-01-28']);
    expect([day(cycleOf(at('2026-12-31T23:00:00Z'), 1).start), cycleOf(at('2026-12-31T23:00:00Z'), 1).days]).toEqual(['2026-12-01', 31]);
  });

  it('clamps days 29 to 31 to the last day of a shorter month', () => {
    // 2027 is no leap year, 2028 is.
    const february = cycleOf(at('2027-03-15T00:00:00Z'), 31);
    expect([day(february.start), day(february.end), february.days]).toEqual(['2027-02-28', '2027-03-31', 31]);
    expect(day(cycleOf(at('2028-03-01T00:00:00Z'), 30).start)).toBe('2028-02-29');
    const april = cycleOf(at('2027-04-30T08:00:00Z'), 31);
    expect([day(april.start), day(april.end), april.days]).toEqual(['2027-04-30', '2027-05-31', 31]);
    expect([day(cycleOf(at('2027-02-10T00:00:00Z'), 29).start), cycleOf(at('2027-02-10T00:00:00Z'), 29).days]).toEqual(['2027-01-29', 30]);
    expect(cycleOf(at('2027-02-28T00:00:00Z'), 29).days).toBe(29);
  });

  it('takes BILLING_CYCLE_DAY only as a day of the month', () => {
    expect(['28', '1', '31', ' 7 ', '07'].map(cycleDay)).toEqual([28, 1, 31, 7, 7]);
    expect(['0', '32', '', '28.5', '-1', 'x', '1e1', undefined].map(cycleDay)).toEqual(Array(8).fill(null));
  });
});

describe('pricing', () => {
  it('charges nothing within the allowance and whole billing units above it, rounded up', () => {
    expect(micros(price('objectRequests'), 1e6)).toEqual({ steps: 0, micros: 0 });
    // Cloudflare's own examples: 1.5 million Durable Object requests cost $0.15, 500,000 GB-s over the allowance $12.50.
    expect(micros(price('objectRequests'), 1.5e6)).toEqual({ steps: 1, micros: 150000 });
    expect(micros(price('objectDuration'), 900000)).toEqual({ steps: 1, micros: 12500000 });
    // R2: 1,000,001 Class A operations are two million, one of them free; 10.1 GB-month bill a whole GB-month.
    expect(micros(price('r2ClassA'), 1000001)).toEqual({ steps: 1, micros: 4500000 });
    expect(micros(price('r2Storage'), 10.1)).toEqual({ steps: 1, micros: 15000 });
    expect(micros(price('r2Storage'), 49.03)).toEqual({ steps: 40, micros: 600000 });
    // Exactly whole units stay whole, whatever floating point makes of them.
    expect(micros(price('r2Storage'), 0.1 + 0.2 + 10.7)).toEqual({ steps: 1, micros: 15000 });
    expect(micros(price('workerRequests'), 12e6)).toEqual({ steps: 2, micros: 600000 });
    expect(micros(price('rowsRead'), 25e9 + 1)).toEqual({ steps: 1, micros: 1000 });
  });

  it('lists the dated prices of docs/COSTS.md', () => {
    expect(BASE).toBe(5);
    expect(PRICES.map(({ id, included, step, price: dollars }) => [id, included, step, dollars])).toEqual([
      ['workerRequests', 10e6, 1e6, 0.30], ['workerCpu', 30e6, 1e6, 0.02], ['r2Storage', 10, 1, 0.015], ['r2ClassA', 1e6, 1e6, 4.50], ['r2ClassB', 10e6, 1e6, 0.36],
      ['objectRequests', 1e6, 1e6, 0.15], ['objectDuration', 400000, 1e6, 12.50], ['rowsRead', 25e9, 1e6, 0.001], ['rowsWritten', 50e6, 1e6, 1.00],
    ]);
  });

  it("puts R2's action types in their class: deletes and aborts free, reads Class B, everything else Class A", () => {
    const classes = (actions: string[]) => actions.map(operationClass);
    expect(classes(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'])).toEqual(['free', 'free', 'free']);
    expect(classes(['HeadObject', 'GetObject', 'HeadBucket', 'GetBucketCors', 'GetBucketLifecycleConfiguration', 'UsageSummary'])).toEqual(Array(6).fill('B'));
    expect(classes(['UploadPart', 'CreateMultipartUpload', 'CompleteMultipartUpload', 'ListMultipartUploads', 'ListObjects', 'ListBuckets', 'PutObject',
      'PutBucketLifecycleConfiguration'])).toEqual(Array(8).fill('A'));
    // Not on the pricing page: a read is Class B, anything else the dearer Class A, never free.
    expect(classes(['GetBucketSippyConfiguration', 'GetBucketNotificationConfiguration', 'PutBucketNotification', 'DeleteBucketCors', ''])).toEqual(['B', 'B', 'A', 'A', 'A']);
  });

  it('adds the base to what each meter costs above its allowance, in exact cents', () => {
    const cycle = cycleOf(at('2026-10-31T00:10:00Z'), 28);
    const usage = { ...none(), objectRequests: 3.2e6, r2Storage: 10.5, workerRequests: 9e6 };
    const answer = estimate(usage, cycle, 28, at('2026-10-31T00:10:00Z'));
    expect(answer).toMatchObject({ sample: false, currency: 'USD', base: 5, aboveAllowance: 0.465, total: 5.465,
      cycle: { day: 28, start: '2026-10-28', end: '2026-11-27', days: 31, elapsedDays: 4 } });
    expect(answer.meters.map(meter => [meter.id, meter.billedSteps, meter.cost])).toEqual([['workerRequests', 0, 0], ['workerCpu', 0, 0], ['r2Storage', 1, 0.015],
      ['r2ClassA', 0, 0], ['r2ClassB', 0, 0], ['objectRequests', 3, 0.45], ['objectDuration', 0, 0], ['rowsRead', 0, 0], ['rowsWritten', 0, 0]]);
    // On pace as the monitor computes it: each meter's usage times 31 / 4 days, priced again, plus the base
    // (workers 69.75M → 60 steps $18, objects 24.8M → 24 steps $3.60, storage 81.375 → 72 steps $1.08).
    expect(answer.pace).toBeCloseTo(5 + 18 + 3.6 + 1.08, 9);
    expect(pace(usage, 31, 4)).toBe(answer.pace);
    expect(pace(none(), 31, 31)).toBe(5);
    expect(estimate(none(), cycle, 28, cycle.end - 1).cycle.elapsedDays).toBe(31);
    expect(estimate(none(), cycle, 28, cycle.start).total).toBe(5);
  });
});

describe('usage from the GraphQL answer', () => {
  const account = {
    workers: [{ sum: { requests: 8232, cpuTimeUs: 31338486 } }],
    storage: [
      { max: { payloadSize: 15967577363, metadataSize: 723 }, dimensions: { date: '2026-10-28', bucketName: 'fyl-at-files' } },
      { max: { payloadSize: 13231677087, metadataSize: 551 }, dimensions: { date: '2026-10-29', bucketName: 'fyl-at-files' } },
      // Another bucket of the account: the allowances are account-wide, so its peak adds to the day's.
      { max: { payloadSize: 2000000000, metadataSize: 0 }, dimensions: { date: '2026-10-29', bucketName: 'other' } },
    ],
    operations: [
      { sum: { requests: 1101 }, dimensions: { actionType: 'UploadPart' } }, { sum: { requests: 170 }, dimensions: { actionType: 'CreateMultipartUpload' } },
      { sum: { requests: 185 }, dimensions: { actionType: 'GetObject' } }, { sum: { requests: 100 }, dimensions: { actionType: 'HeadObject' } },
      { sum: { requests: 144 }, dimensions: { actionType: 'DeleteObject' } }, { sum: { requests: 23 }, dimensions: { actionType: 'AbortMultipartUpload' } },
      { sum: { requests: 4 }, dimensions: { actionType: 'GetBucketSippyConfiguration' } },
    ],
    objects: [{ sum: { requests: 5172 } }],
    periodic: [{ sum: { duration: 99.83685056, rowsRead: 100717, rowsWritten: 14485 } }],
  };

  it('sums each day, its peak over the cycle and the operations by class', () => {
    const usage = usageOf(account, 31) as Usage;
    expect(usage).toMatchObject({ workerRequests: 8232, workerCpu: 31338.486, r2ClassA: 1271, r2ClassB: 289, objectRequests: 5172, objectDuration: 99.83685056,
      rowsRead: 100717, rowsWritten: 14485 });
    // Payload and metadata of each day's peak, in 10⁹ bytes, over the 31 days of the cycle.
    expect(usage.r2Storage).toBeCloseTo((15967577363 + 723 + 13231677087 + 551 + 2000000000) / 1e9 / 31, 9);
  });

  it("lists each day's storage peak for the dashboard, oldest first", () => {
    expect(storageByDay(account)).toEqual([{ date: '2026-10-28', bytes: 15967577363 + 723 }, { date: '2026-10-29', bytes: 13231677087 + 551 + 2000000000 }]);
    expect(storageByDay({ ...account, storage: [...account.storage].reverse() }).map(day => day.date)).toEqual(['2026-10-28', '2026-10-29']);
    expect([storageByDay(null), storageByDay({ storage: null }), storageByDay({ storage: [{ max: { payloadSize: 5 } }] })]).toEqual([[], [], []]);
  });

  it('reads empty datasets as no usage, and a missing one as no answer', () => {
    expect(usageOf({ workers: [], storage: [], operations: [], objects: [], periodic: [] }, 30)).toEqual(none());
    expect(usageOf({ ...account, workers: [{ sum: { requests: -5, cpuTimeUs: 'x' } }] }, 31)).toMatchObject({ workerRequests: 0, workerCpu: 0 });
    for (const name of Object.keys(account)) expect(usageOf({ ...account, [name]: null }, 31), name).toBeNull();
    expect(usageOf(null, 31)).toBeNull();
  });

  it("reads fyl's Worker errors of the last 24 hours by outcome, and nothing when the answer has none", () => {
    const since = at('2026-10-31T00:00:00Z');
    const exceptions = [{ sum: { requests: 4314, errors: 0 }, dimensions: { status: 'success' } }, { sum: { requests: 3, errors: 3 }, dimensions: { status: 'exceededResources' } },
      { sum: { requests: 7, errors: 0 }, dimensions: { status: 'clientDisconnected' } }, { sum: { requests: 'x', errors: -1 }, dimensions: { status: 'internalError' } }];
    expect(workerErrorsOf({ ...account, exceptions }, since)).toEqual({ since: '2026-10-31T00:00:00.000Z', requests: 4324, errors: 3,
      statuses: [{ name: 'clientDisconnected', n: 7 }, { name: 'exceededResources', n: 3 }] });
    expect(workerErrorsOf({ ...account, exceptions: [] }, since)).toEqual({ since: '2026-10-31T00:00:00.000Z', requests: 0, errors: 0, statuses: [] });
    // Without the list (a token or a dataset that doesn't answer it) the dashboard shows nothing rather than zero.
    expect([workerErrorsOf(account, since), workerErrorsOf(null, since), workerErrorsOf({ exceptions: 'x' }, since)]).toEqual([null, null, null]);
    // The estimate never depends on it.
    expect(usageOf(account, 31)).not.toBeNull();
  });

  it('makes up sample usage that grows with the days of the cycle', () => {
    const early = sampleUsage(1, 31), late = sampleUsage(20, 31);
    for (const entry of PRICES) expect(late[entry.id], entry.id).toBeGreaterThan(early[entry.id]);
    expect(estimate(sampleUsage(4, 31), cycleOf(at('2026-10-31T00:10:00Z'), 28), 28, at('2026-10-31T00:10:00Z')).total).toBe(5.75);
  });
});
