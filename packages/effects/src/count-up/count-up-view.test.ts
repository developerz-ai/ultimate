import { describe, expect, test } from 'bun:test';
import { fromMinor } from '@ultimat3/money';
import { EffectsInvalidValueError } from '../errors';
import { countFormatter, countFrame, countMs, countScalar } from './count-up-view';

describe('countFrame', () => {
  test('starts at from, ends exactly at to, rises monotonically', () => {
    expect(countFrame(0, 100, 0, 1000)).toBe(0);
    expect(countFrame(0, 100, 1000, 1000)).toBe(100);
    expect(countFrame(0, 100, 5000, 1000)).toBe(100);
    let last = -1;
    for (let t = 0; t <= 1000; t += 100) {
      const v = countFrame(0, 100, t, 1000);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });

  test('zero duration is the final value at once', () => {
    expect(countFrame(0, 7, 0, 0)).toBe(7);
  });
});

describe('countFormatter', () => {
  test('a number follows the locale', () => {
    expect(countFormatter(1, 'en-US')(1234567)).toBe('1,234,567');
    expect(countFormatter(1, 'de-DE')(1234567)).toBe('1.234.567');
  });

  test('options pass through', () => {
    expect(countFormatter(1, 'en-US', { maximumFractionDigits: 1 })(2.345)).toBe('2.3');
  });

  test('Money tweens minor units and formats with the currency exponent', () => {
    const target = fromMinor(129900, 'USD');
    expect(countScalar(target)).toBe(129900);
    const format = countFormatter(target, 'en-US');
    expect(format(129900)).toBe('$1,299.00');
    expect(format(50.4)).toBe('$0.50');
    expect(countFormatter(fromMinor(1200, 'JPY'), 'en-US')(1200).replace(/\s/g, '')).toBe('¥1,200');
  });
});

describe('countMs', () => {
  test('refuses negatives and NaN', () => {
    expect(() => countMs(-1)).toThrow(EffectsInvalidValueError);
    expect(() => countMs(Number.NaN)).toThrow(EffectsInvalidValueError);
    expect(countMs(0)).toBe(0);
  });
});
