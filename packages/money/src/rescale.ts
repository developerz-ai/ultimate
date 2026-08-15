/**
 * Moving a money value between decimal scales.
 * Widening is exact and free. Narrowing throws away digits, so it happens only when the caller
 * names the rounding mode — the same bar `fromDecimal` sets for excess precision.
 */

import { rescaleNotExact } from './errors';
import { type Money, money } from './money';
import { type RoundingMode, roundRatio } from './rounding';
import { assertScale, minorAt, moneyScale, toMinor } from './scale';

/**
 * `rescale(money(80, 'USD'), 8)` → 80,000,000 hundred-millionths, the granularity a per-token
 * price needs. `rescale(m, 2, 'half-up')` brings it back to cents, having named who pays for the
 * digits that go.
 */
export function rescale(amount: Money, scale: number, mode?: RoundingMode): Money {
  assertScale(scale);
  const from = moneyScale(amount);
  if (scale >= from) {
    return money(toMinor(minorAt(amount, scale), scale, amount.currency), amount.currency, scale);
  }

  const divisor = 10n ** BigInt(from - scale);
  const numerator = BigInt(amount.minor);
  // An exact narrowing needs no mode: nothing is being decided, so nothing has to be declared.
  if (mode === undefined && numerator % divisor !== 0n) {
    throw rescaleNotExact(amount, from, scale);
  }
  return money(roundRatio(numerator, divisor, mode), amount.currency, scale);
}
