import { describe, expect, test } from 'bun:test';
import { DELTA_ARROW_PATH, deltaOf } from './stat-delta';

describe('deltaOf', () => {
  test('a rise is a plus, a fall is a real minus (U+2212), the same width as the plus', () => {
    expect(deltaOf(112, 100)).toEqual({ text: '+12%', trend: 'up' });
    expect(deltaOf(96, 100)).toEqual({ text: '−4%', trend: 'down' });
    expect(deltaOf(96, 100)?.text.charCodeAt(0)).toBe(0x2212);
  });

  test('no change is a flat 0%', () => {
    expect(deltaOf(50, 50)).toEqual({ text: '0%', trend: 'flat' });
  });

  test('rounds to a whole percent — a tile is a glance, not a ledger', () => {
    expect(deltaOf(1004, 1000)?.text).toBe('0%');
    expect(deltaOf(1005, 1000)?.text).toBe('+1%');
  });

  test('a zero or negative baseline yields nothing: a percentage of nothing means nothing', () => {
    expect(deltaOf(10, 0)).toBeUndefined();
    expect(deltaOf(10, -5)).toBeUndefined();
    expect(deltaOf(Number.NaN, 5)).toBeUndefined();
  });

  test('every trend has an arrow path', () => {
    for (const trend of ['up', 'down', 'flat'] as const) {
      expect(DELTA_ARROW_PATH[trend]).toMatch(/^M/);
    }
  });
});
