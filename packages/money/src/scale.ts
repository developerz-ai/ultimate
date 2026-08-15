/**
 * What decimal place a money value's `minor` counts, and which scales are legal.
 * A value naming none counts the currency's own minor unit — the shape every amount already had,
 * which is why nothing that predates this file has to change to keep meaning what it meant.
 */

import { isMoneyScale, MAX_MONEY_SCALE } from '@ultimat3/schema';
import { exponentOf } from './currency';
import { scaleInvalid, scaleNotWidening, scaleOverflow } from './errors';
import type { Money } from './money';

export { MAX_MONEY_SCALE };

/**
 * The decimal exponent this value's `minor` counts in — its own, or the currency's.
 *
 * Not to be confused with `scaleOf(currency)`, which is the multiplier `10 ** exponentOf(currency)`.
 * This one is a count of digits, like `exponentOf`.
 */
export function moneyScale(amount: Money): number {
  return amount.scale ?? exponentOf(amount.currency);
}

/** A scale that names no decimal place is a data bug, not a formatting preference. */
export function assertScale(scale: number): number {
  if (!isMoneyScale(scale)) throw scaleInvalid(scale);
  return scale;
}

/**
 * `amount.minor` restated at `scale`, exactly, as a bigint.
 *
 * A bigint because widening is what a comparison does first, and a comparison must not throw:
 * `MAX_SAFE_INTEGER` cents restated in micros is past 2^53, which `money()` rightly refuses to
 * *store* and which says nothing about whether it is larger than the value beside it.
 *
 * Widening only. Narrowing drops digits, and which digits go is a decision with a mode attached —
 * `rescale()` owns that, out loud.
 */
export function minorAt(amount: Money, scale: number): bigint {
  assertScale(scale);
  const from = moneyScale(amount);
  if (scale < from) throw scaleNotWidening(from, scale);
  return BigInt(amount.minor) * 10n ** BigInt(scale - from);
}

/** The finer of two scales: where two values have to meet before they can be one number. */
export function commonScale(left: Money, right: Money): number {
  return Math.max(moneyScale(left), moneyScale(right));
}

/**
 * A widened bigint back to a storable `minor`, or a scale error naming the finest scale that
 * would fit. The one place that conversion happens, because `Number(widened)` alone reached
 * `money()` as a plain out-of-range amount — reported as a fractional minor nobody wrote, with a
 * `fromDecimal` fix line that throws the same error again.
 */
export function toMinor(widened: bigint, scale: number, currency: string): number {
  const minor = Number(widened);
  if (Number.isSafeInteger(minor)) return minor;
  throw scaleOverflow(scale, currency, finestFitting(widened, scale));
}

/** How coarse the scale has to get before the magnitude fits; `undefined` if it never does. */
function finestFitting(widened: bigint, scale: number): number | undefined {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  let magnitude = widened < 0n ? -widened : widened;
  for (let fitted = scale; fitted >= 0; fitted -= 1) {
    if (magnitude <= limit) return fitted;
    magnitude /= 10n;
  }
  return undefined;
}
