// CountUp's maths and formatting. The final value is what the server renders, through the same
// formatter every frame uses, so frame N of the tween and the static text can never disagree
// about grouping, decimals or where a currency symbol sits.

import { formatMoney, fromMinor, type Money } from '@ultimat3/money';
import { EffectsInvalidValueError } from '../errors';

export const COUNT_UP_BACKEND = 'static';
export const COUNT_UP_DEFAULT_MS = 1000;

export type CountTarget = number | Money;

export const isMoneyTarget = (target: CountTarget): target is Money => typeof target !== 'number';

/** The number the tween interpolates: the value itself, or a Money's integer minor units. */
export function countScalar(target: CountTarget): number {
  return isMoneyTarget(target) ? target.minor : target;
}

export function countMs(requested: number | undefined): number {
  if (requested === undefined) return COUNT_UP_DEFAULT_MS;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new EffectsInvalidValueError({
      cause: `CountUp ms must be a finite number >= 0, got ${String(requested)}.`,
      fix: `<CountUp value={1200} ms={${COUNT_UP_DEFAULT_MS}} />   // ms >= 0; 0 shows the final value at once, or omit ms`,
    });
  }
  return requested;
}

/** A formatter for one target: Money through `formatMoney`, a number through `Intl.NumberFormat`. */
export function countFormatter(
  target: CountTarget,
  locale: string,
  options?: Intl.NumberFormatOptions,
): (scalar: number) => string {
  if (isMoneyTarget(target)) {
    const { currency } = target;
    return (scalar) => formatMoney(fromMinor(Math.round(scalar), currency), locale);
  }
  const format = new Intl.NumberFormat(locale, options);
  // `Intl` shows up to three fraction digits, so 788.4 would flash by on the way to 1,000: an
  // integer target with no fraction options counts in whole numbers.
  const whole =
    Number.isInteger(target) &&
    options?.minimumFractionDigits === undefined &&
    options?.maximumFractionDigits === undefined;
  return (scalar) => format.format(whole ? Math.round(scalar) : scalar);
}

/** Ease-out cubic position between `from` and `to`; exactly `to` once `elapsed >= ms`. */
export function countFrame(from: number, to: number, elapsed: number, ms: number): number {
  if (ms <= 0 || elapsed >= ms) return to;
  const t = Math.max(elapsed, 0) / ms;
  return from + (to - from) * (1 - (1 - t) ** 3);
}
