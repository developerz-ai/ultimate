import { describe, expect, test } from 'bun:test';
import { add, compare, divide, isZero, max, multiply, negate, subtract, sum } from './arithmetic';
import { money } from './money';
import { rescale } from './rescale';

describe('cross-currency safety', () => {
  test('add refuses two currencies with X_CURRENCY_MISMATCH', () => {
    const usd = money(1000, 'USD');
    const eur = money(1000, 'EUR');
    expect(codeOf(() => add(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => subtract(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => compare(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => max(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    // The mismatch error must name both sides so the fix is obvious.
    expect(causeOf(() => add(usd, eur))).toContain('USD');
    expect(causeOf(() => add(usd, eur))).toContain('EUR');
  });

  test('sum over a mixed list throws instead of producing a plausible number', () => {
    const amounts = [money(100, 'USD'), money(200, 'USD'), money(300, 'JPY')];
    expect(codeOf(() => sum(amounts))).toBe('X_CURRENCY_MISMATCH');
    expect(sum([money(100, 'USD'), money(200, 'USD')])).toEqual({
      minor: 300,
      currency: 'USD',
    });
    expect(sum([], 'JPY')).toEqual({ minor: 0, currency: 'JPY' });
    expect(codeOf(() => sum([]))).toBe('X_CURRENCY_UNKNOWN');
  });

  // M1. The file header is "Integer arithmetic that REFUSES to mix currencies", and every other
  // entry point does. `sum` took the explicit currency as a FALLBACK for an empty list and then
  // ignored it entirely once a first addend existed: `sum([money(1, 'EUR')], 'USD')` answered
  // `{ minor: 1, currency: 'EUR' }` — a caller who stated USD and got EUR back, with no refusal.
  test('sum refuses an explicit currency the first addend contradicts', () => {
    expect(codeOf(() => sum([money(1, 'EUR')], 'USD'))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => sum([money(1, 'EUR'), money(2, 'EUR')], 'USD'))).toBe(
      'X_CURRENCY_MISMATCH',
    );
  });

  test('sum keeps every shape that already worked', () => {
    // Agreement is not a mismatch, an absent currency is still inferred, and an empty list still
    // takes the declared one.
    expect(sum([money(1, 'EUR')], 'EUR')).toEqual({ minor: 1, currency: 'EUR' });
    expect(sum([money(1, 'EUR')])).toEqual({ minor: 1, currency: 'EUR' });
    expect(sum([], 'USD')).toEqual({ minor: 0, currency: 'USD' });
  });
});

describe('integer arithmetic', () => {
  test('add and subtract stay exact', () => {
    expect(add(money(10, 'USD'), money(20, 'USD')).minor).toBe(30);
    expect(subtract(money(10, 'USD'), money(20, 'USD')).minor).toBe(-10);
    expect(isZero(subtract(money(10, 'USD'), money(10, 'USD')))).toBe(true);
    expect(negate(money(10, 'USD')).minor).toBe(-10);
  });

  test('multiply rounds with the mode the caller names', () => {
    const price = money(1999, 'USD'); // $19.99
    // 19% VAT: 1999 * 0.19 = 379.81 minor units
    expect(multiply(price, 0.19, 'half-up').minor).toBe(380);
    expect(multiply(price, 0.19, 'down').minor).toBe(379);
    // exact .5 is where modes disagree: 1005 * 0.5 = 502.5
    expect(multiply(money(1005, 'USD'), 0.5, 'half-up').minor).toBe(503);
    expect(multiply(money(1005, 'USD'), 0.5, 'half-even').minor).toBe(502);
    expect(multiply(money(-1005, 'USD'), 0.5, 'half-up').minor).toBe(-503);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}

describe('scaling is exact, not an IEEE-754 product', () => {
  // `100 * 1.005` is 100.49999999999999, so multiplying first hid the exact 100.5 from `half-up`
  // and a 0.5% fee on €1.00 was billed as nothing.
  test('multiply rounds the value written, not the value the double holds', () => {
    expect(multiply(money(100, 'EUR'), 1.005)).toEqual({ minor: 101, currency: 'EUR' });
    expect(multiply(money(100, 'EUR'), 1.005, 'down')).toEqual({ minor: 100, currency: 'EUR' });
    expect(multiply(money(100, 'EUR'), 1.005, 'half-even')).toEqual({
      minor: 100,
      currency: 'EUR',
    });
  });

  test('multiply stays symmetric around zero at the exact half', () => {
    expect(multiply(money(-100, 'EUR'), 1.005)).toEqual({ minor: -101, currency: 'EUR' });
    expect(multiply(money(-100, 'EUR'), 1.005, 'down')).toEqual({ minor: -100, currency: 'EUR' });
  });

  test('a factor in exponent notation carries its own decimal expansion', () => {
    expect(multiply(money(1_000_000, 'EUR'), 1e-4)).toEqual({ minor: 100, currency: 'EUR' });
    expect(multiply(money(2, 'EUR'), 2.5e2)).toEqual({ minor: 500, currency: 'EUR' });
  });

  test('divide rounds the exact quotient', () => {
    expect(divide(money(1000, 'EUR'), 3)).toEqual({ minor: 333, currency: 'EUR' });
    expect(divide(money(1, 'EUR'), 2)).toEqual({ minor: 1, currency: 'EUR' });
    expect(divide(money(1, 'EUR'), 2, 'half-even')).toEqual({ minor: 0, currency: 'EUR' });
    expect(divide(money(-1, 'EUR'), 2)).toEqual({ minor: -1, currency: 'EUR' });
    // Scaling by 0.1 and dividing by 10 are the same question and must not answer differently.
    expect(divide(money(105, 'EUR'), 10)).toEqual(multiply(money(105, 'EUR'), 0.1));
  });

  test('an amount scaled past the safe-integer range is refused, never approximated', () => {
    expect(codeOf(() => multiply(money(1_000_000_000, 'EUR'), 1e9))).toBe('X_MONEY_NOT_INTEGER');
  });
});

describe('mixed scales', () => {
  test('add and subtract normalise to the finer scale, losing nothing', () => {
    // 1¢ + $0.000002 is not 1¢, and it is not two decisions either.
    expect(add(money(1, 'USD'), money(2, 'USD', 6))).toEqual({
      minor: 10_002,
      currency: 'USD',
      scale: 6,
    });
    expect(subtract(money(1, 'USD'), money(2, 'USD', 6))).toEqual({
      minor: 9998,
      currency: 'USD',
      scale: 6,
    });
    expect(sum([money(2, 'USD', 6), money(1, 'USD')])).toEqual({
      minor: 10_002,
      currency: 'USD',
      scale: 6,
    });
  });

  test('a common scale that will not fit reports a scale error, with a fix that runs', () => {
    const huge = money(Number.MAX_SAFE_INTEGER, 'USD');
    const fine = money(1, 'USD', 6);
    // Not X_MONEY_NOT_INTEGER: nobody wrote a fractional minor. The widening is what does not
    // fit, and `fromDecimal('90071992547409900000', 'USD')` — the old fix — throws again.
    expect(codeOf(() => add(huge, fine))).toBe('X_MONEY_SCALE_INVALID');
    expect(causeOf(() => add(huge, fine))).toContain('scale 6');
    const fix = fixOf(() => add(huge, fine));
    expect(fix).toContain('rescale');
    expect(fix).toContain('2');
    // Following it works, which is the whole point of an executable fix line.
    expect(add(huge, rescale(fine, 2, 'half-up'))).toEqual({
      minor: Number.MAX_SAFE_INTEGER,
      currency: 'USD',
    });
  });

  test('two currencies still refuse each other, whatever their scales', () => {
    expect(codeOf(() => add(money(2, 'USD', 6), money(1, 'EUR')))).toBe('X_CURRENCY_MISMATCH');
  });

  test('compare reads the value, so a finer encoding is not automatically larger', () => {
    expect(compare(money(1, 'USD'), money(10_000, 'USD', 6))).toBe(0);
    expect(compare(money(1, 'USD'), money(10_001, 'USD', 6))).toBe(-1);
    expect(compare(money(1, 'USD'), money(9999, 'USD', 6))).toBe(1);
    // A comparison must not throw where the widened value would leave the safe-integer range.
    expect(compare(money(Number.MAX_SAFE_INTEGER, 'USD'), money(1, 'USD', 6))).toBe(1);
    expect(max(money(1, 'USD'), money(10_001, 'USD', 6))).toEqual({
      minor: 10_001,
      currency: 'USD',
      scale: 6,
    });
  });

  test('multiply, divide, negate and absolute keep the scale they were handed', () => {
    expect(multiply(money(2, 'USD', 6), 3)).toEqual({ minor: 6, currency: 'USD', scale: 6 });
    expect(divide(money(10, 'USD', 6), 4)).toEqual({ minor: 3, currency: 'USD', scale: 6 });
    expect(negate(money(2, 'USD', 6))).toEqual({ minor: -2, currency: 'USD', scale: 6 });
    expect(isZero(money(0, 'USD', 6))).toBe(true);
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
