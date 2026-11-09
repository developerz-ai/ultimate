// The live window: the newest point in, the oldest out past `max`, and a bound that is not a
// whole number refused rather than silently unbounded.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { liveWindow } from './live-window';

describe('liveWindow', () => {
  test('appends, and drops the oldest past max', () => {
    expect(liveWindow([1, 2], 3, { max: 3 })).toEqual([1, 2, 3]);
    expect(liveWindow([1, 2, 3], 4, { max: 3 })).toEqual([2, 3, 4]);
    expect(liveWindow([], 'a', { max: 1 })).toEqual(['a']);
  });

  test('never mutates the series it was handed', () => {
    const series = [1, 2, 3];
    liveWindow(series, 4, { max: 2 });
    expect(series).toEqual([1, 2, 3]);
  });

  test('a non-finite or fractional max is refused, never an unbounded window', () => {
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0]) {
      expect(() => liveWindow([1], 2, { max })).toThrow(UltimateError);
    }
  });
});
