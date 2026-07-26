/**
 * Explicit rounding modes. Tax, interest and VAT rules each name a mode in law;
 * whichever one `Math.round` happens to implement is not an answer.
 */

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
      return sign * floor;
    case 'up':
      return sign * (fraction > 0 ? floor + 1 : floor);
    case 'half-up':
      return sign * (fraction >= 0.5 ? floor + 1 : floor);
    case 'half-even': {
      if (fraction > 0.5) return sign * (floor + 1);
      if (fraction < 0.5) return sign * floor;
      return sign * (floor % 2 === 0 ? floor : floor + 1);
    }
  }
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
