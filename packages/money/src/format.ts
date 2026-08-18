/**
 * `Intl.NumberFormat` at the edge. Fraction digits come from the currency exponent, so
 * JPY renders without decimals and KWD with three, without a per-locale special case.
 */

import { cachedFormatter, canonicalLocale } from '@ultimat3/core';
import { exponentOf } from './currency';
import { type Money, toDecimalNumber } from './money';
import { moneyScale } from './scale';

export interface FormatMoneyOptions {
  /** How the currency appears: `€1,299.00` / `EUR 1,299.00` / `1,299.00 euros`. */
  display?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
  /**
   * Accounting negatives — `(€12.99)` in `en-US`. Passed to `Intl` as `currencySign`, so the
   * locale decides the notation: `de-DE` has no parenthesised form in CLDR and keeps `-1.299,00 €`.
   */
  accounting?: boolean;
  /** Drop `.00` on whole amounts — price lists, never invoices. */
  trimZeroFraction?: boolean;
  /** Force a digit count; defaults to the value's own scale, which is the currency's unless
   * the amount names a finer one. */
  fractionDigits?: number;
  /** `never` disables grouping separators. */
  grouping?: 'auto' | 'never';
}

/**
 * `formatMoney(money(129900,'EUR'), 'de-DE')` → `1.299,00 €`.
 *
 * Delegates to `formatMoneyParts` and joins: a UI styling the symbol off the parts and a label
 * rendering the string must not disagree about where the sign goes. Hand-prefixing `-` here put
 * it outside the symbol (`-€ 1.299,00`) where `nl-NL` puts it inside (`€ -1.299,00`), and
 * `accounting` was applied on this path only.
 */
export function formatMoney(
  amount: Money,
  locale: string,
  options: FormatMoneyOptions = {},
): string {
  return formatMoneyParts(amount, locale, options)
    .map((part) => part.value)
    .join('');
}

/**
 * Parts, for UI that styles the symbol or the decimals differently (a smaller superscript
 * cent, a muted currency code). Never re-split a formatted string with a regex.
 *
 * The signed value goes to `Intl`, so sign placement and the accounting notation are the
 * locale's — the one place either is decided.
 */
export function formatMoneyParts(
  amount: Money,
  locale: string,
  options: FormatMoneyOptions = {},
): Intl.NumberFormatPart[] {
  return formatterFor(amount.currency, locale, options, moneyScale(amount)).formatToParts(
    toDecimalNumber(amount),
  );
}

/** The symbol alone, e.g. for an input prefix: `€`, `¥`, `KD`. */
export function currencySymbol(currency: string, locale: string): string {
  const parts = formatterFor(
    currency,
    locale,
    { display: 'narrowSymbol' },
    exponentOf(currency),
  ).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency;
}

/** Digits only, no symbol — for editable inputs and CSV exports. */
export function formatMoneyDecimal(amount: Money, locale: string): string {
  const digits = moneyScale(amount);
  const tag = canonicalTag(locale);
  // Through the same cache as `formatterFor`, for the same reason: this took the caller's raw
  // locale too, and a second way to build a formatter in one file is a second place to forget.
  return cachedFormatter(
    decimalCache,
    `${tag}|${digits}`,
    () =>
      new Intl.NumberFormat(tag, {
        style: 'decimal',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: false,
      }),
  ).format(toDecimalNumber(amount));
}

/**
 * A tag `Intl` cannot parse falls through unchanged, so the `Intl.NumberFormat` constructor still
 * raises it — this seam decides a cache key, never whether a locale is acceptable.
 */
const canonicalTag = (locale: string): string => canonicalLocale(locale) ?? locale;

const cache = new Map<string, Intl.NumberFormat>();
const decimalCache = new Map<string, Intl.NumberFormat>();

/**
 * `scale` is the amount's own, not the currency's: rendering $0.000002 with two digits shows
 * `$0.00`, which is the sub-cent bug back again, in the one place a human would read it.
 *
 * **Canonically keyed and hard-capped, because `locale` arrives from `Accept-Language`.** Keyed
 * raw into an unbounded `Map`, 20,000 valid-but-distinct tags (`en-US-x-a0` …) retained 55 MB —
 * memory the client chooses. `canonicalLocale` collapses `EN-us` and `en-US` onto one key and
 * `cachedFormatter` caps the rest; neither half is sufficient alone, which is why both come from
 * the one place `@ultimat3/time` reads them from too.
 */
function formatterFor(
  currency: string,
  locale: string,
  options: FormatMoneyOptions,
  exponent: number,
): Intl.NumberFormat {
  const digits =
    options.fractionDigits ?? (options.trimZeroFraction === true ? undefined : exponent);
  const sign = options.accounting === true ? 'accounting' : 'standard';
  const tag = canonicalTag(locale);
  // `exponent` is in the key because it stopped being derivable from `currency` the moment it
  // started coming from the amount's own scale. On the `trimZeroFraction` path `digits` is
  // `undefined`, so without it every scale of one currency shared a formatter: format 12.99 EUR
  // first and 12.990001 EUR then rendered as `12,99 €` — the sub-cent bug back, silently, in the
  // one place a human reads the number.
  const key = [
    tag,
    currency,
    options.display ?? 'symbol',
    digits ?? 'auto',
    exponent,
    options.grouping ?? 'auto',
    sign,
  ].join('|');
  return cachedFormatter(
    cache,
    key,
    () =>
      new Intl.NumberFormat(tag, {
        style: 'currency',
        currency,
        currencyDisplay: options.display ?? 'symbol',
        currencySign: sign,
        ...(digits === undefined
          ? { minimumFractionDigits: 0, maximumFractionDigits: exponent }
          : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
        ...(options.grouping === 'never' ? { useGrouping: false } : {}),
      }),
  );
}
