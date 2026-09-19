import { describe, expect, test } from 'bun:test';
import { meterShare, meterWidth } from './meter-view';

describe('meterShare', () => {
  test('is the share of the maximum, clamped to 0..1', () => {
    expect(meterShare(25, 100)).toBe(0.25);
    expect(meterShare(150, 100)).toBe(1);
    expect(meterShare(-5, 100)).toBe(0);
  });

  test('an empty, zero or non-finite maximum is an empty meter, never a division by zero', () => {
    expect(meterShare(5, 0)).toBe(0);
    expect(meterShare(5, Number.NaN)).toBe(0);
    expect(meterShare(Number.POSITIVE_INFINITY, 10)).toBe(0);
  });
});

describe('meterWidth', () => {
  test('is one decimal on a 100-unit box, so two renders emit the same attribute', () => {
    expect(meterWidth(1 / 3)).toBe('33.3');
    expect(meterWidth(1)).toBe('100.0');
    expect(meterWidth(0)).toBe('0.0');
  });
});
