/**
 * The exact fraction a scaling factor's decimal spelling names.
 * A rate, a quantity or a percentage arrives as an IEEE-754 double, and `1.005` is held as
 * 1.00499999999999989…; scaling first and rounding after therefore shows the rounding mode a
 * value nobody wrote. The shortest round-trip decimal IS what was written, so its expansion is
 * the exact value every scale in this package is taken against.
 */

import { notRoundable } from './errors';

/** `numerator / denominator`, exactly. `denominator` is always a positive power of ten. */
export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The grammar `Number.prototype.toString` emits for every finite double, exponent included. */
const SPELLING = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export function factorFraction(factor: number): Fraction {
  if (!Number.isFinite(factor)) throw notRoundable(factor);
  const match = SPELLING.exec(String(factor));
  if (match === null) throw notRoundable(factor);
  const [, sign = '', whole = '0', fraction = '', exponent = '0'] = match;

  let numerator = BigInt(`${whole}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  const shift = BigInt(exponent);
  if (shift > 0n) numerator *= 10n ** shift;
  else if (shift < 0n) denominator *= 10n ** -shift;

  return { numerator: sign === '-' ? -numerator : numerator, denominator };
}
