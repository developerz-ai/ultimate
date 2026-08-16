/**
 * Explicit rounding modes. Tax, interest and VAT rules each name a mode in law;
 * whichever one `Math.round` happens to implement is not an answer.
 */

import { invariant } from '@ultimat3/core';
import { notRoundable } from './errors';

export type RoundingMode =
  /** 0.5 away from zero — the commercial default most invoicing rules specify. */
  | 'half-up'
  /** 0.5 to the nearest even — banker's rounding, ISO 80000-1, avoids upward drift. */
  | 'half-even'
  /** Truncate toward zero — never overcharge. */
  | 'down'
  /** Away from zero — never undercharge. */
  | 'up';

export const ROUNDING_MODES: readonly RoundingMode[] = ['half-up', 'half-even', 'down', 'up'];

export const DEFAULT_ROUNDING: RoundingMode = 'half-up';

/** Round a fractional minor-unit amount to an integer number of minor units. */
export function roundToInteger(value: number, mode: RoundingMode = DEFAULT_ROUNDING): number {
  if (!Number.isFinite(value)) throw notRoundable(value);
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const fraction = magnitude - floor;

  switch (mode) {
    case 'down':
      return signed(sign, floor);
    case 'up':
      return signed(sign, fraction > 0 ? floor + 1 : floor);
    case 'half-up':
      return signed(sign, fraction >= 0.5 ? floor + 1 : floor);
    case 'half-even': {
      if (fraction > 0.5) return signed(sign, floor + 1);
      if (fraction < 0.5) return signed(sign, floor);
      return signed(sign, floor % 2 === 0 ? floor : floor + 1);
    }
  }
}

/**
 * `sign * magnitude`, except that a magnitude of zero stays `0`. `-1 * 0` is `-0`, which
 * `JSON.stringify` writes as `0` while `Object.is` and any keyed `Map` see a different value —
 * so a refund rounding to nothing produced an amount its own wire format cannot reproduce.
 */
function signed(sign: number, magnitude: number): number {
  return magnitude === 0 ? 0 : sign * magnitude;
}

/**
 * Round the exact rational `numerator / denominator` with the same four modes.
 *
 * The float path above can only judge a value IEEE-754 has already moved: `100 * 1.005` is
 * 100.49999999999999, so `half-up` answers 100 where the exact 100.5 owes 101 — a 0.5% fee on
 * €1.00 charged as nothing. A scale therefore reaches a mode as a fraction, never as a product.
 */
export function roundRatio(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = DEFAULT_ROUNDING,
): number {
  invariant(
    denominator !== 0n,
    'X_INVARIANT',
    'cannot round a ratio whose denominator is zero',
    'roundRatio(numerator, 1n, mode)   # a zero denominator names no value; divide(amount, 0) is refused before it reaches here, so this is a caller building the fraction itself',
  );
  // One sign, carried out front, so each mode sees a magnitude exactly as `roundToInteger` does.
  const negative = numerator < 0n !== denominator < 0n;
  const top = numerator < 0n ? -numerator : numerator;
  const bottom = denominator < 0n ? -denominator : denominator;
  const whole = top / bottom;
  const remainder = top % bottom;
  // `remainder / bottom` vs `1/2` without leaving the integers: compare `2 * remainder` to `bottom`.
  const twice = remainder * 2n;

  let rounded: bigint;
  switch (mode) {
    case 'down':
      rounded = whole;
      break;
    case 'up':
      rounded = remainder > 0n ? whole + 1n : whole;
      break;
    case 'half-up':
      rounded = twice >= bottom ? whole + 1n : whole;
      break;
    case 'half-even':
      if (twice > bottom) rounded = whole + 1n;
      else if (twice < bottom) rounded = whole;
      else rounded = whole % 2n === 0n ? whole : whole + 1n;
      break;
  }
  // Past 2^53 the `Number` is already approximate, which `money()` refuses as X_MONEY_NOT_INTEGER.
  return Number(negative ? -rounded : rounded);
}

/**
 * Round to `digits` decimal places, used when converting a decimal string whose
 * precision exceeds the currency's minor unit.
 */
export function roundToDigits(
  value: number,
  digits: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): number {
  const factor = 10 ** digits;
  return roundToInteger(value * factor, mode) / factor;
}
