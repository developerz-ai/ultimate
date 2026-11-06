// The published figure is the spread of runs, never one run: min and the lower median, failures out.
import { describe, expect, test } from 'bun:test';
import { spreadOf, spreads } from './bench-spread';

describe('unit · bench spread', () => {
  test('min and the lower median of the measured values', () => {
    expect(spreadOf([30, 10, 20, 50, 40])).toEqual({ min: 10, median: 30, n: 5 });
    expect(spreadOf([4, 1, 3, 2])).toEqual({ min: 1, median: 2, n: 4 });
    expect(spreadOf([])).toBeNull();
  });

  test('a run that did not measure a figure is left out of it, and the count says so', () => {
    const runs = [
      { setup: 10, verify: 30 },
      { setup: 20, verify: null },
      { setup: 30, verify: 50 },
    ];
    expect(spreads(runs)).toEqual({
      setup: { min: 10, median: 20, n: 3 },
      verify: { min: 30, median: 30, n: 2 },
    });
    expect(spreads([{ image: null }])).toEqual({ image: null });
  });
});
