// The unit is the whole point: `@ultimat3/render` reported a 5 MiB route as `5120kb` and
// `@ultimat3/pwa` reported the same bytes as `5mb`, because each package carried its own copy and
// render's had no `mb` branch. Every boundary is pinned here so a third copy cannot start.

import { describe, expect, test } from 'bun:test';
import { formatBytes } from './format-bytes';

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;

describe('unit · formatBytes', () => {
  test('a 5 MiB route reads 5mb, never 5120kb', () => {
    expect(formatBytes(5 * MIB)).toBe('5mb');
  });

  test('each unit boundary picks the larger unit', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, '0b'],
      [1, '1b'],
      [512, '512b'],
      [KIB - 1, '1023b'],
      [KIB, '1kb'],
      [1536, '1.5kb'],
      [MIB - 1, '1mb'],
      [MIB, '1mb'],
      [GIB - 1, '1gb'],
      [GIB, '1gb'],
      [2 * GIB + Math.round(GIB / 2), '2.5gb'],
    ];
    for (const [bytes, expected] of cases) {
      expect(`${String(bytes)} -> ${formatBytes(bytes)}`).toBe(`${String(bytes)} -> ${expected}`);
    }
  });

  test('gb is the last rung: a terabyte stays in gb rather than inventing a unit', () => {
    expect(formatBytes(KIB * GIB)).toBe('1024gb');
  });

  test('a size that is not a size answers 0b, never NaNb or -5b', () => {
    expect(formatBytes(Number.NaN)).toBe('0b');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0b');
    expect(formatBytes(-5)).toBe('0b');
  });

  test('one decimal place, so a cause never carries fifteen digits', () => {
    expect(formatBytes(1234)).toBe('1.2kb');
    expect(formatBytes(1_234_567)).toBe('1.2mb');
  });
});
