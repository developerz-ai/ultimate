/**
 * Integer arithmetic that refuses to mix currencies.
 * `add(usd, eur)` is not a rounding problem, it is a wrong answer — so it throws.
 */

import { allocationInvalid, currencyMismatch, currencyRequired } from './errors';
import { type Money, money } from './money';
import { DEFAULT_ROUNDING, type RoundingMode, roundToInteger } from './rounding';

/** Throws `X_CURRENCY_MISMATCH` unless both operands carry the same currency. */
export function assertSameCurrency(left: Money, right: Money): string {
  if (left.currency !== right.currency) throw currencyMismatch(left.currency, right.currency);
  return left.currency;
}

export function add(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  return money(left.minor + right.minor, currency);
}

export function subtract(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  return money(left.minor - right.minor, currency);
}

/** Every addend must share one currency; an empty list needs an explicit currency. */
export function sum(amounts: readonly Money[], currency?: string): Money {
  const base = amounts[0]?.currency ?? currency;
  if (base === undefined) throw currencyRequired('sum([])');
  return amounts.reduce((total, amount) => add(total, amount), money(0, base));
}

/**
 * Scale by a plain number (a tax rate, a quantity, a percentage). The result is rounded
 * to whole minor units with an explicit mode — the default is stated, not implied.
 */
export function multiply(
  amount: Money,
  factor: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  return money(roundToInteger(amount.minor * factor, mode), amount.currency);
}

/**
 * Divide into a single share. Use `allocate` when the whole must be preserved —
 * `divide` alone loses the remainder by design.
 */
export function divide(
  amount: Money,
  divisor: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (divisor === 0) {
    throw allocationInvalid('cannot divide money by zero — use allocate() to split a total');
  }
  return money(roundToInteger(amount.minor / divisor, mode), amount.currency);
}

export function negate(amount: Money): Money {
  return money(-amount.minor, amount.currency);
}

export function absolute(amount: Money): Money {
  return money(Math.abs(amount.minor), amount.currency);
}

/** `-1 | 0 | 1`, comparable currencies only. */
export function compare(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.minor < right.minor) return -1;
  return left.minor > right.minor ? 1 : 0;
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
