/**
 * Integer arithmetic that refuses to mix currencies.
 * `add(usd, eur)` is not a rounding problem, it is a wrong answer — so it throws.
 */

import { allocationInvalid, currencyMismatch, currencyRequired } from './errors';
import { factorFraction } from './factor';
import { type Money, money } from './money';
import { DEFAULT_ROUNDING, type RoundingMode, roundRatio } from './rounding';
import { commonScale, minorAt, toMinor } from './scale';

/** Throws `X_CURRENCY_MISMATCH` unless both operands carry the same currency. */
export function assertSameCurrency(left: Money, right: Money): string {
  if (left.currency !== right.currency) throw currencyMismatch(left.currency, right.currency);
  return left.currency;
}

/**
 * Two operands meet at the finer of their scales, which is exact for both — the coarser one is
 * widened, never the finer one rounded, so adding a sub-cent fee to a cent cannot lose the fee.
 */
export function add(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  const scale = commonScale(left, right);
  return money(
    toMinor(minorAt(left, scale) + minorAt(right, scale), scale, currency),
    currency,
    scale,
  );
}

export function subtract(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  const scale = commonScale(left, right);
  return money(
    toMinor(minorAt(left, scale) - minorAt(right, scale), scale, currency),
    currency,
    scale,
  );
}

/**
 * Every addend must share one currency; an empty list needs an explicit currency.
 *
 * A stated currency the first addend contradicts is `X_CURRENCY_MISMATCH`, not a silent win for
 * the list: `sum([money(1, 'EUR')], 'USD')` used to answer `{ minor: 1, currency: 'EUR' }`, so a
 * caller who wrote down USD received EUR and nothing refused — the exact failure this file's
 * header exists to rule out, in the one entry point that treated its currency as a fallback rather
 * than as an assertion.
 */
export function sum(amounts: readonly Money[], currency?: string): Money {
  const first = amounts[0]?.currency;
  if (first !== undefined && currency !== undefined && first !== currency) {
    throw currencyMismatch(currency, first);
  }
  const base = first ?? currency;
  if (base === undefined) throw currencyRequired('sum([])');
  return amounts.reduce((total, amount) => add(total, amount), money(0, base));
}

/**
 * Scale by a plain number (a tax rate, a quantity, a percentage). The result is rounded
 * to whole minor units with an explicit mode — the default is stated, not implied.
 *
 * The scale is taken as the exact fraction `factor`'s decimal spelling names, never as a float
 * product: `100 * 1.005` is 100.49999999999999, so multiplying first hid the exact 100.5 from
 * `half-up` and billed a 0.5% fee on €1.00 as nothing.
 */
export function multiply(
  amount: Money,
  factor: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  const ratio = factorFraction(factor);
  // Scale-preserving: a fee on a micro-priced amount stays a micro-priced amount.
  return money(
    roundRatio(BigInt(amount.minor) * ratio.numerator, ratio.denominator, mode),
    amount.currency,
    amount.scale,
  );
}

/**
 * Divide into a single share. Use `allocate` when the whole must be preserved —
 * `divide` alone loses the remainder by design. Exact for the same reason `multiply` is:
 * dividing by `d` is scaling by the reciprocal of the fraction `d` names.
 */
export function divide(
  amount: Money,
  divisor: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (divisor === 0) {
    throw allocationInvalid('cannot divide money by zero — use allocate() to split a total');
  }
  const ratio = factorFraction(divisor);
  return money(
    roundRatio(BigInt(amount.minor) * ratio.denominator, ratio.numerator, mode),
    amount.currency,
    amount.scale,
  );
}

export function negate(amount: Money): Money {
  return money(-amount.minor, amount.currency, amount.scale);
}

export function absolute(amount: Money): Money {
  return money(Math.abs(amount.minor), amount.currency, amount.scale);
}

/**
 * `-1 | 0 | 1`, comparable currencies only — and comparing the value, not the encoding, so a
 * finer scale is not automatically the larger number. Widened as bigints on purpose: a comparison
 * must answer where storing the widened value would rightly be refused.
 */
export function compare(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  const scale = commonScale(left, right);
  const leftMinor = minorAt(left, scale);
  const rightMinor = minorAt(right, scale);
  if (leftMinor < rightMinor) return -1;
  return leftMinor > rightMinor ? 1 : 0;
}

export function isZero(amount: Money): boolean {
  return amount.minor === 0;
}

export function isNegative(amount: Money): boolean {
  return amount.minor < 0;
}

export function isPositive(amount: Money): boolean {
  return amount.minor > 0;
}

export function greaterThan(left: Money, right: Money): boolean {
  return compare(left, right) === 1;
}

export function lessThan(left: Money, right: Money): boolean {
  return compare(left, right) === -1;
}

export function min(left: Money, right: Money): Money {
  return compare(left, right) <= 0 ? left : right;
}

export function max(left: Money, right: Money): Money {
  return compare(left, right) >= 0 ? left : right;
}
