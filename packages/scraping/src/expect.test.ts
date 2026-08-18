import { describe, expect, test } from 'bun:test';
import { guardYield, MIN_BASELINE_RUNS, median, memoryYieldHistory, yieldProblem } from './expect';

/** The thrown value, as a code. `.rejects.toBeUltimateError` is not wired for async matchers. */
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

const check = (
  rows: number,
  history: readonly number[],
  expectation: Parameters<typeof yieldProblem>[0]['expect'],
) => yieldProblem({ scrape: 'orders', rows, expect: expectation, history });

describe('unit · the silent-green alarm', () => {
  test('a run under minRows is refused, and a run at it is not', () => {
    expect(check(0, [], { minRows: 1 })?.code).toBe('X_SCRAPE_YIELD_COLLAPSED');
    expect(check(1, [], { minRows: 1 })).toBeUndefined();
  });

  test('minRows: 0 is a DECLARED zero and passes — the field distinguishes it from silence', () => {
    expect(check(0, [], { minRows: 0 })).toBeUndefined();
  });

  test('a collapse against the trailing median is refused', () => {
    // Median of [100, 110, 90, 105] is 102.5; maxDrop 0.5 allows 51.25.
    expect(check(40, [100, 110, 90, 105], { maxDrop: 0.5 })?.code).toBe('X_SCRAPE_YIELD_COLLAPSED');
    expect(check(60, [100, 110, 90, 105], { maxDrop: 0.5 })).toBeUndefined();
  });

  test('one outlier run cannot arm the alarm — the baseline is a median, not a mean', () => {
    // A mean of [10, 10, 10, 12_000] is 3007 and would refuse every ordinary day after the
    // backfill. The median is 11.
    expect(check(10, [10, 10, 10, 12_000], { maxDrop: 0.5 })).toBeUndefined();
  });

  test('below MIN_BASELINE_RUNS samples there is no baseline, so maxDrop cannot fire', () => {
    const history = Array.from({ length: MIN_BASELINE_RUNS - 1 }, () => 100);
    expect(check(1, history, { maxDrop: 0.5 })).toBeUndefined();
  });

  test('median of an even and an odd list', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe('unit · the baseline never follows a collapse down', () => {
  test('a refused run is NOT recorded, so the alarm cannot silence itself', async () => {
    const history = memoryYieldHistory({ orders: [100, 100, 100] });
    for (let run = 0; run < 3; run += 1) {
      expect(
        await codeOf(guardYield({ scrape: 'orders', rows: 2, expect: { maxDrop: 0.5 }, history })),
      ).toBe('X_SCRAPE_YIELD_COLLAPSED');
    }
    // Had the collapses been recorded, the median would now be 2 and this fourth broken run would
    // pass — the alarm quietly re-baselined onto its own failure.
    expect(
      await codeOf(guardYield({ scrape: 'orders', rows: 2, expect: { maxDrop: 0.5 }, history })),
    ).toBe('X_SCRAPE_YIELD_COLLAPSED');
    expect(await history.recent('orders', 10)).toEqual([100, 100, 100]);
  });

  test('a run that passed IS recorded', async () => {
    const history = memoryYieldHistory({ orders: [100, 100, 100] });
    await guardYield({ scrape: 'orders', rows: 99, expect: { maxDrop: 0.5 }, history });
    expect(await history.recent('orders', 10)).toEqual([100, 100, 100, 99]);
  });

  test('no expect declared is no alarm and no history written', async () => {
    const history = memoryYieldHistory({});
    await guardYield({ scrape: 'orders', rows: 0, expect: undefined, history });
    expect(await history.recent('orders', 10)).toEqual([]);
  });
});
