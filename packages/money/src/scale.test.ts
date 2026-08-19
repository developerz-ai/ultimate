// Single responsibility: pins what a money value's scale MEANS — that an absent one is the
// currency's own, and that widening to a finer scale is exact. Both are load-bearing: the first
// is why every amount that predates scale still reads correctly, the second is why a comparison
// can answer where storing the widened value would rightly be refused.

import { describe, expect, test } from 'bun:test';
import { money } from './money';
import { assertScale, MAX_MONEY_SCALE, minorAt, moneyScale, toMinor } from './scale';

describe('moneyScale', () => {
  test('a value without a scale carries its currency’s own', () => {
    expect(moneyScale(money(1299, 'EUR'))).toBe(2);
    expect(moneyScale(money(1200, 'JPY'))).toBe(0);
    expect(moneyScale(money(1234, 'KWD'))).toBe(3);
  });

  test('an explicit scale wins, and is what makes a sub-cent amount expressible', () => {
    // The AI cost path's real number: $0.000002, which cents alone rounded up to a whole 1¢.
    expect(moneyScale({ minor: 2, currency: 'USD', scale: 6 })).toBe(6);
  });
});

describe('assertScale', () => {
  test('refuses a scale that names no decimal place with X_MONEY_SCALE_INVALID', () => {
    expect(codeOf(() => assertScale(-1))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => assertScale(2.5))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => assertScale(Number.NaN))).toBe('X_MONEY_SCALE_INVALID');
  });

  test('refuses a scale past 10^15, the last power of ten that is a safe integer', () => {
    expect(codeOf(() => assertScale(MAX_MONEY_SCALE + 1))).toBe('X_MONEY_SCALE_INVALID');
    expect(assertScale(MAX_MONEY_SCALE)).toBe(MAX_MONEY_SCALE);
    expect(assertScale(0)).toBe(0);
  });
});

describe('minorAt', () => {
  test('widens exactly, as a bigint, so a comparison never overflows a double', () => {
    expect(minorAt(money(1299, 'EUR'), 6)).toBe(12_990_000n);
    expect(minorAt({ minor: 2, currency: 'USD', scale: 6 }, 6)).toBe(2n);
    // Past 2^53: the point of the bigint. `money()` would refuse the widened value, a
    // comparison must not.
    expect(minorAt(money(Number.MAX_SAFE_INTEGER, 'USD'), 6)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) * 10_000n,
    );
  });

  test('refuses to narrow — that is a rounding decision, and rescale() owns it', () => {
    expect(codeOf(() => minorAt({ minor: 2, currency: 'USD', scale: 6 }, 2))).toBe(
      'X_MONEY_SCALE_INVALID',
    );
  });
});

describe('toMinor', () => {
  test('names the finest scale that would have fitted, so the fix line is executable', () => {
    // MAX_SAFE_INTEGER micro-dollars, widened once more: too big at scale 6, fine at scale 5.
    const widened = BigInt(Number.MAX_SAFE_INTEGER) * 10n;
    expect(codeOf(() => toMinor(widened, 6, 'USD'))).toBe('X_MONEY_SCALE_INVALID');
    expect(fixOf(() => toMinor(widened, 6, 'USD'))).toContain(
      "rescale(theFinerOperand, 5, 'half-up')",
    );
    // One digit coarser and it is storable, which is what makes 5 the right answer above.
    expect(toMinor(widened / 10n, 5, 'USD')).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('a magnitude no scale can hold says so instead of naming a scale', () => {
    // Past 2^53 at scale 0 already: coarsening cannot help, and offering `rescale(x, 0)` would
    // be a fix line that throws the same error again. One decimal digit past the boundary is the
    // case that matters — the loop must stop AT zero, not walk on to a negative scale.
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) * 10n;
    const fix = fixOf(() => toMinor(tooBig, 0, 'JPY'));
    expect(fix).toContain('too large for any scale');
    expect(fix).not.toContain('rescale');
    // The same on the negative side — magnitude is what decides, not sign.
    expect(fixOf(() => toMinor(-tooBig, 0, 'JPY'))).toContain('too large for any scale');
    // And the boundary itself still fits at scale 0.
    expect(toMinor(BigInt(Number.MAX_SAFE_INTEGER), 0, 'JPY')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

function fixOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { fix?: unknown }).fix);
  }
  return 'no-throw';
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
