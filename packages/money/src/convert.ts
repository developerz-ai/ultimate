/**
 * Currency conversion with the rate as an explicit argument.
 * There is no default rate provider: a wrong exchange rate is worse than a missing one,
 * and every converted amount records which rate produced it.
 */

import { assertCurrency, exponentOf } from './currency';
import { rateMissing } from './errors';
import { type Money, money } from './money';
import { DEFAULT_ROUNDING, type RoundingMode, roundToInteger } from './rounding';

export interface ExchangeRate {
  from: string;
  to: string;
  /** Major units of `to` per one major unit of `from`. */
  rate: number;
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

  const scale = 10 ** (exponentOf(target) - exponentOf(amount.currency));
  const converted = roundToInteger(
    amount.minor * rate.rate * scale,
    options.rounding ?? DEFAULT_ROUNDING,
  );

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
 * Fixed-table provider for tests, seeds and manual invoice rates.
 * Keys are `FROM/TO`; the inverse is derived so a table needs one direction only.
 */
export function fixedRateProvider(
  rates: Readonly<Record<string, number>>,
  at: Date,
  name = 'fixed',
): RateProvider {
  return {
    name,
    async rateFor(from: string, to: string): Promise<ExchangeRate | undefined> {
      const direct = rates[`${from}/${to}`];
      if (direct !== undefined) return { from, to, rate: direct, at, source: name };
      const inverse = rates[`${to}/${from}`];
      if (inverse !== undefined && inverse !== 0) {
        return { from, to, rate: 1 / inverse, at, source: name };
      }
      return undefined;
    },
  };
}
