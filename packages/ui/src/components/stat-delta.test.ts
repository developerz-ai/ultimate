import { describe, expect, test } from 'bun:test';
import { DELTA_ARROW_PATH, deltaMood, deltaOf } from './stat-delta';

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

  test('from zero, the signed difference: a percentage of nothing means nothing', () => {
    // The probe: `deltaOf(5, 0)` was undefined — a tile that went from nothing to five said nothing.
    expect(deltaOf(5, 0)).toEqual({ text: '+5', trend: 'up' });
    expect(deltaOf(0, 0)).toEqual({ text: '0', trend: 'flat' });
    expect(deltaOf(10, -5)).toEqual({ text: '+15', trend: 'up' });
    expect(deltaOf(-3, 0)?.text).toBe('−3');
    expect(deltaOf(Number.NaN, 5)).toBeUndefined();
  });

  test('under absoluteBelow, the difference — 2 → 5 is +3, never +150%', () => {
    expect(deltaOf(5, 2)).toEqual({ text: '+150%', trend: 'up' });
    expect(deltaOf(5, 2, { absoluteBelow: 10 })).toEqual({ text: '+3', trend: 'up' });
    expect(deltaOf(120, 100, { absoluteBelow: 10 })?.text).toBe('+20%');
    expect(deltaOf(1.5, 2, { absoluteBelow: 10, format: (n) => `${n} ms` })?.text).toBe('−0.5 ms');
  });

  test('a difference that formats as zero is flat, as a percentage that rounds to 0% is', () => {
    // The probe: 2 → 2.001 read "+0", trend up — a green arrow for a change the chip says is none.
    expect(deltaOf(2.001, 2, { absoluteBelow: 10 })).toEqual({ text: '0', trend: 'flat' });
    expect(deltaOf(1.999, 2, { absoluteBelow: 10 })).toEqual({ text: '0', trend: 'flat' });
    expect(deltaOf(0.004, 0)).toEqual({ text: '0', trend: 'flat' });
    // A caller's formatter decides what zero reads as: its own text, flat.
    expect(deltaOf(2.001, 2, { absoluteBelow: 10, format: (n) => `${Math.round(n)} ms` })).toEqual({
      text: '0 ms',
      trend: 'flat',
    });
    // ...and a finer formatter keeps a difference the default's two places would have hidden.
    expect(deltaOf(2.001, 2, { absoluteBelow: 10, format: (n) => n.toFixed(3) })).toEqual({
      text: '+0.001',
      trend: 'up',
    });
    expect(deltaOf(2, 2, { absoluteBelow: 10, format: (n) => `${n} ms` })).toEqual({
      text: '0 ms',
      trend: 'flat',
    });
  });

  test('every trend has an arrow path', () => {
    for (const trend of ['up', 'down', 'flat'] as const) {
      expect(DELTA_ARROW_PATH[trend]).toMatch(/^M/);
    }
  });
});

describe('deltaMood', () => {
  test('an error rate rising is bad when down is good — never green', () => {
    // The probe: deltaOf(120, 100) is `up`, and `up` painted success whatever was measured.
    const trend = deltaOf(120, 100)?.trend ?? 'flat';
    expect(deltaMood(trend, 'down')).toBe('bad');
    expect(deltaMood(trend, 'up')).toBe('good');
    expect(deltaMood(trend, 'none')).toBe('neutral');
    expect(deltaMood('flat', 'up')).toBe('neutral');
  });
});
