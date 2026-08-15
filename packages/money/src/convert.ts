/**
 * Currency conversion with the rate as an explicit argument.
 * There is no default rate provider: a wrong exchange rate is worse than a missing one,
 * and every converted amount records which rate produced it.
 */

import { assertCurrency, exponentOf } from './currency';
import { rateMissing } from './errors';
import { type Fraction, factorFraction } from './factor';
import { type Money, money } from './money';
import { DEFAULT_ROUNDING, type RoundingMode, roundRatio } from './rounding';

export interface ExchangeRate {
  from: string;
  to: string;
  /** Major units of `to` per one major unit of `from`. */
  rate: number;
  /**
   * The exact value `rate` approximates, for a provider that knows one. `rate` is the number the
   * audit trail records and a human reads; a reciprocal cannot be both. `1 / 0.92` is the double
   * 1.0869565217391304, whose decimal spelling is NOT 25/23 — so scaling by it loses a minor unit
   * on a large amount, and the table that named `USD/EUR = 0.92` never wrote that number at all.
   * Omit it and `convert` expands `rate`'s own decimal spelling, which is exact for a direct rate.
   */
  ratio?: Fraction;
  /** When the rate was observed — part of the audit trail, not decoration. */
  at: Date;
  /** Where it came from: `ecb`, `openexchange`, `manual:invoice-4711`. */
  source?: string;
}

/** A converted amount carries its provenance so a finance audit can reproduce it. */
export interface ConvertedMoney {
  amount: Money;
  /** The untouched original — never overwrite what the customer was charged. */
  source: Money;
  rate: number;
  at: string;
  provider?: string;
}

export interface ConvertOptions {
  rounding?: RoundingMode;
}

/**
 * `convert(money(1000,'USD'), 'EUR', { rate: 0.92, ... })`.
 * Scales across differing minor-unit exponents (USD 2 → JPY 0) instead of assuming both
 * sides have cents.
 */
export function convert(
  amount: Money,
  to: string,
  rate: ExchangeRate,
  options: ConvertOptions = {},
): ConvertedMoney {
  const target = assertCurrency(to);
  if (rate.from !== amount.currency || rate.to !== target) {
    throw rateMissing(amount.currency, target);
  }
  if (!Number.isFinite(rate.rate) || rate.rate <= 0) {
    throw rateMissing(amount.currency, target);
  }
  if (rate.ratio !== undefined && (rate.ratio.numerator <= 0n || rate.ratio.denominator <= 0n)) {
    throw rateMissing(amount.currency, target);
  }

  // Exact, not a float product: `minor * rate * scale` shows the rounding mode a value IEEE-754
  // has already moved, and a converted invoice line is off by a minor unit with nothing to trace.
  // The provider's own fraction wins when it has one — see `ExchangeRate.ratio`.
  const fraction = rate.ratio ?? factorFraction(rate.rate);
  const exponent = exponentOf(target) - exponentOf(amount.currency);
  let numerator = BigInt(amount.minor) * fraction.numerator;
  let denominator = fraction.denominator;
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  else if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  const converted = roundRatio(numerator, denominator, options.rounding ?? DEFAULT_ROUNDING);

  return {
    amount: money(converted, target),
    source: amount,
    rate: rate.rate,
    at: rate.at.toISOString(),
    ...(rate.source === undefined ? {} : { provider: rate.source }),
  };
}

/** Rate lookup. Implemented by the app — the framework ships no live provider. */
export interface RateProvider {
  readonly name: string;
  /** `at` requests a historical rate; providers that cannot honour it must return undefined. */
  rateFor(from: string, to: string, at?: Date): Promise<ExchangeRate | undefined>;
}

/** Convert through a provider; a missing pair throws `X_RATE_MISSING`, never guesses 1.0. */
export async function convertWith(
  provider: RateProvider,
  amount: Money,
  to: string,
  options: ConvertOptions & { at?: Date } = {},
): Promise<ConvertedMoney> {
  const target = assertCurrency(to);
  if (amount.currency === target) {
    const at = (options.at ?? new Date(0)).toISOString();
    return { amount, source: amount, rate: 1, at, provider: 'identity' };
  }
  const rate = await provider.rateFor(amount.currency, target, options.at);
  if (rate === undefined) throw rateMissing(amount.currency, target);
  return {
    ...convert(amount, target, rate, options),
    provider: rate.source ?? provider.name,
  };
}

/**
 * The exact fraction a table entry names, or `undefined` for a number that is not a usable rate.
 * `convert` refuses those on `rate.rate` with `X_RATE_MISSING`; expanding them here first would
 * answer `X_NOT_ROUNDABLE` for the same mistake.
 */
function exactRate(value: number): Fraction | undefined {
  return Number.isFinite(value) && value > 0 ? factorFraction(value) : undefined;
}

/**
 * Fixed-table provider for tests, seeds and manual invoice rates.
 * Keys are `FROM/TO`; the inverse is derived so a table needs one direction only.
 *
 * A table holds ONE observation, so a `wanted` instant other than its own is a rate this
 * provider does not have — `undefined`, per `RateProvider`. Answering with today's number
 * stamped `at: today` repriced a historical invoice against a rate nobody asked for and wrote a
 * date into the audit trail that contradicted the request.
 */
export function fixedRateProvider(
  rates: Readonly<Record<string, number>>,
  at: Date,
  name = 'fixed',
): RateProvider {
  return {
    name,
    async rateFor(from: string, to: string, wanted?: Date): Promise<ExchangeRate | undefined> {
      if (wanted !== undefined && wanted.getTime() !== at.getTime()) return undefined;
      const direct = rates[`${from}/${to}`];
      if (direct !== undefined) {
        const ratio = exactRate(direct);
        return {
          from,
          to,
          rate: direct,
          at,
          source: name,
          ...(ratio === undefined ? {} : { ratio }),
        };
      }
      const inverse = rates[`${to}/${from}`];
      if (inverse !== undefined && inverse !== 0) {
        // Swapped, never divided. A table holding `USD/EUR: 0.92` names 23/25, so the EUR/USD
        // direction is exactly 25/23 — where `1 / 0.92` is a double whose own decimal spelling
        // rounds a large amount one minor unit low. `rate` keeps the readable approximation.
        const named = exactRate(inverse);
        const ratio =
          named === undefined
            ? undefined
            : { numerator: named.denominator, denominator: named.numerator };
        return {
          from,
          to,
          rate: 1 / inverse,
          at,
          source: name,
          ...(ratio === undefined ? {} : { ratio }),
        };
      }
      return undefined;
    },
  };
}
