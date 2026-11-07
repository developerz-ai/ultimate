// The process meter store: a draw counts only inside the limit, a later period resets the count, an
// earlier one (a lagging replica) adds to the current, and one period's warning is claimed once.

import { describe, expect, test } from 'bun:test';
import { memoryMeterStore } from './meter-memory';

const DAY = 86_400_000;
const key = { subject: 'org:o1', meter: 'calls', period: 'day@UTC' } as const;
const draw = (limit: number, periodStartMs = 0) => ({ ...key, periodStartMs, limit });

describe('memoryMeterStore', () => {
  test('counts up to the limit and refuses the next draw without counting it', async () => {
    const store = memoryMeterStore();
    const seen = [];
    for (let i = 0; i < 4; i += 1) seen.push(await store.draw(draw(3)));
    expect(seen.map((result) => [result.allowed, result.used])).toEqual([
      [true, 1],
      [true, 2],
      [true, 3],
      [false, 3],
    ]);
  });

  test('N parallel draws at the edge admit exactly the limit', async () => {
    const store = memoryMeterStore();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.draw(draw(7))));
    expect(results.filter((result) => result.allowed)).toHaveLength(7);
  });

  test('a limit of 0 refuses every draw', async () => {
    expect((await memoryMeterStore().draw(draw(0))).allowed).toBe(false);
  });

  test('a later period starts from zero; an earlier one adds to the current', async () => {
    const store = memoryMeterStore();
    await store.draw(draw(2, DAY));
    await store.draw(draw(2, DAY));
    expect((await store.draw(draw(2, DAY))).allowed).toBe(false);
    // A replica a period behind cannot reset today's count by drawing against yesterday.
    expect((await store.draw(draw(2, 0))).allowed).toBe(false);
    expect(await store.draw(draw(2, 2 * DAY))).toEqual({ allowed: true, used: 1, warned: false });
  });

  test('a raised limit applies at once, to the count already spent', async () => {
    const store = memoryMeterStore();
    await store.draw(draw(1));
    expect((await store.draw(draw(1))).allowed).toBe(false);
    expect(await store.draw(draw(5))).toEqual({ allowed: true, used: 2, warned: false });
  });

  test('subjects and meters are separate counters', async () => {
    const store = memoryMeterStore();
    await store.draw(draw(1));
    expect((await store.draw({ ...draw(1), subject: 'org:o2' })).allowed).toBe(true);
    expect((await store.draw({ ...draw(1), meter: 'exports' })).allowed).toBe(true);
    expect((await store.draw({ ...draw(1), period: 'month@UTC' })).allowed).toBe(true);
  });

  test("a period's warning is claimed once, released for a retry, and reset by the next period", async () => {
    const store = memoryMeterStore();
    await store.draw(draw(9));
    const claims = await Promise.all([store.claimWarning(key, 0), store.claimWarning(key, 0)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.draw(draw(9))).warned).toBe(true);
    await store.releaseWarning(key, 0);
    expect(await store.claimWarning(key, 0)).toBe(true);
    // A claim for a period the counter is not in is no claim at all.
    expect(await store.claimWarning(key, DAY)).toBe(false);
    expect((await store.draw(draw(9, DAY))).warned).toBe(false);
  });

  test('the bound evicts the oldest period first, and refuses a non-finite bound', async () => {
    const store = memoryMeterStore({ maxKeys: 2 });
    await store.draw({ ...draw(1, 0), subject: 'old' });
    await store.draw({ ...draw(1, DAY), subject: 'kept' });
    await store.draw({ ...draw(1, DAY), subject: 'new' });
    expect((await store.draw({ ...draw(1, DAY), subject: 'kept' })).allowed).toBe(false);
    expect((await store.draw({ ...draw(1, 0), subject: 'old' })).allowed).toBe(true);
    expect(() => memoryMeterStore({ maxKeys: Number.NaN })).toThrow();
  });

  // The oldest START is a live month counter, while an hour counter that already ended is worth
  // nothing: evicting by start alone forgave the month's usage and re-admitted org:a past its limit.
  test('a counter whose period ended goes before a live one that started earlier', async () => {
    const HOUR = 3_600_000;
    const MONTH_START = Date.UTC(2026, 10, 1);
    const store = memoryMeterStore({ maxKeys: 2 });
    const month = { subject: 'org:a', meter: 'calls', period: 'month@UTC', limit: 1 };
    const hour = (subject: string, at: number) => ({
      subject,
      meter: 'calls',
      period: 'hour@UTC',
      periodStartMs: MONTH_START + at * HOUR,
      limit: 1,
    });
    await store.draw({ ...month, periodStartMs: MONTH_START });
    await store.draw(hour('org:b', 5));
    await store.draw(hour('org:c', 9));
    expect((await store.draw({ ...month, periodStartMs: MONTH_START })).allowed).toBe(false);
  });
});
