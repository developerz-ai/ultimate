// The two rules that decide WHEN a shot may be taken, proved with no browser and no clock: the
// predicate that says a page has finished hydrating, and the bounded loop that waits for it.

import { describe, expect, test } from 'bun:test';
import { islandsSettled, settleIslands } from './shot-settle';
import type { IslandCount } from './shot-verdict';

describe('unit · when the settle window may stop', () => {
  const count = (over: Partial<IslandCount>): IslandCount => ({
    declared: 2,
    booted: 2,
    mounted: 2,
    failed: 0,
    byStrategy: { idle: 2 },
    failures: [],
    ...over,
  });

  // `booted` means `import()` was CALLED. Waiting for `mounted + failed` to reach it is the only
  // way the verdict is read after the outcome exists rather than before it.
  test('every booted island has settled, or it has not', () => {
    expect(islandsSettled(count({ mounted: 2, failed: 0 }))).toBe(true);
    expect(islandsSettled(count({ mounted: 1, failed: 1 }))).toBe(true);
    expect(islandsSettled(count({ mounted: 1, failed: 0 }))).toBe(false);
  });

  // A `visible` island nothing scrolled to never boots, and a page with none is settled at once —
  // neither may hold the window open for the whole extra budget.
  test('an island that never booted is not something to wait for', () => {
    expect(islandsSettled(count({ declared: 4, booted: 0, mounted: 0 }))).toBe(true);
  });

  // `null` is "the page answered no probe". Polling cannot change that, and treating it as
  // unsettled would spend the whole window on every driver with no JS engine.
  test('a page that answered no probe is not waited on', () => {
    expect(islandsSettled(null)).toBe(true);
  });
});

describe('unit · the probe is read until the page settles', () => {
  const count = (over: Partial<IslandCount>): IslandCount => ({
    declared: 2,
    booted: 2,
    mounted: 0,
    failed: 0,
    byStrategy: { idle: 2 },
    failures: [],
    ...over,
  });

  const polling = (answers: readonly (IslandCount | null)[]) => {
    const slept: number[] = [];
    let index = 0;
    return {
      slept,
      probes: () => index,
      probe: (): Promise<IslandCount | null> => {
        const answer = answers[Math.min(index, answers.length - 1)] ?? null;
        index += 1;
        return Promise.resolve(answer);
      },
      sleep: (ms: number): Promise<void> => {
        slept.push(ms);
        return Promise.resolve();
      },
    };
  };

  /**
   * The defect this replaces: `DEFAULT_SETTLE_MS` is the deadline at which the runtime CALLS
   * `import()`, so a single read at that instant sees `mounted: 0` on a page that mounts
   * perfectly — the verdict was taken one tick before the outcome existed.
   */
  test('the probe is re-read until every booted island has settled', async () => {
    const driver = polling([
      count({ mounted: 0 }),
      count({ mounted: 1 }),
      count({ mounted: 2 }),
      count({ mounted: 2 }),
    ]);
    const answer = await settleIslands(driver.probe, {
      windowMs: 1_000,
      pollMs: 100,
      sleep: driver.sleep,
    });
    expect(answer?.mounted).toBe(2);
    expect([driver.probes(), driver.slept.length]).toEqual([3, 2]);
  });

  // Bounded, because a mount that never settles must still produce a picture and a verdict.
  test('a mount that never settles ends the window and reports what it saw', async () => {
    const driver = polling([count({ mounted: 0 })]);
    const answer = await settleIslands(driver.probe, {
      windowMs: 250,
      pollMs: 100,
      sleep: driver.sleep,
    });
    expect(answer?.mounted).toBe(0);
    expect(driver.slept).toEqual([100, 100, 50]);
  });

  test('an already settled page and an unprobeable one both cost one read', async () => {
    for (const answers of [[count({ mounted: 2 })], [null]]) {
      const driver = polling(answers);
      await settleIslands(driver.probe, { windowMs: 1_000, pollMs: 100, sleep: driver.sleep });
      expect([driver.probes(), driver.slept.length]).toEqual([1, 0]);
    }
  });

  // A probe that fails once must not erase a count already taken: `null` is "not counted", and
  // overwriting a real answer with it would report an island-free page.
  test('a transient probe failure keeps the last real count', async () => {
    const driver = polling([count({ mounted: 1 }), null]);
    const answer = await settleIslands(driver.probe, {
      windowMs: 200,
      pollMs: 100,
      sleep: driver.sleep,
    });
    expect(answer?.mounted).toBe(1);
  });
});
