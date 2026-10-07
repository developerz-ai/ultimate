/**
 * `Intl.NumberFormat` at the edge. Fraction digits come from the currency exponent, so
 * JPY renders without decimals and KWD with three, without a per-locale special case.
 */

import { assertLocale, cachedFormatter } from '@ultimat3/core';
import { exponentOf } from './currency';
import { fractionDigitsInvalid } from './errors';
import { type Money, toDecimalString } from './money';
import { moneyScale } from './scale';

export interface FormatMoneyOptions {
  /** How the currency appears: `€1,299.00` / `EUR 1,299.00` / `1,299.00 euros`. */
  display?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
  /**
   * Accounting negatives — `(€12.99)` in `en-US`. Passed to `Intl` as `currencySign`, so the
   * locale decides the notation: `de-DE` has no parenthesised form in CLDR and keeps `-1.299,00 €`.
   */
  accounting?: boolean;
  /**
   * Drop `.00` on whole amounts — price lists, never invoices. A fractional amount keeps every
   * digit: 1250 cents is `$12.50`, never `$12.5`.
   */
  trimZeroFraction?: boolean;
  /** Force a digit count, 0…`MAX_FRACTION_DIGITS` (`X_MONEY_SCALE_INVALID` otherwise); defaults
   * to the value's own scale, which is the currency's unless the amount names a finer one. */
  fractionDigits?: number;
  /** `never` disables grouping separators. */
  grouping?: 'auto' | 'never';
}

/**
 * `formatMoney(fromMinor(129900,'EUR'), 'de-DE')` → `1.299,00 €`.
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
    exactDecimal(amount),
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
  const tag = assertLocale(locale);
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
  ).format(exactDecimal(amount));
}

/**
 * The amount as the decimal STRING `Intl` accepts (Intl.NumberFormat v3), never a float: dividing
 * `9007199254740991` minor units by `10 ** 6` in floating point lands on `…740992` before any
 * formatter sees it, so the largest amount a `Money` can hold rendered a digit it does not have.
 * The cast is the one `toDecimalString` earns: it only ever writes `-?\d+(\.\d+)?`.
 */
const exactDecimal = (amount: Money): `${number}` => toDecimalString(amount) as `${number}`;

/** `Intl.NumberFormat`'s own ceiling on a fraction digit count. */
export const MAX_FRACTION_DIGITS = 100;

/**
 * `Intl` refuses a digit count outside 0…100, a fraction and `NaN` with a bare `RangeError`,
 * several frames from the call that named it. A digit count IS a scale, so it is refused as one.
 */
function assertFractionDigits(digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_FRACTION_DIGITS) {
    throw fractionDigitsInvalid(digits, MAX_FRACTION_DIGITS);
  }
  return digits;
}

const cache = new Map<string, Intl.NumberFormat>();
const decimalCache = new Map<string, Intl.NumberFormat>();

/**
 * `scale` is the amount's own, not the currency's: rendering $0.000002 with two digits shows
 * `$0.00`, which is the sub-cent bug back again, in the one place a human would read it.
 *
 * **Screened, canonically keyed and hard-capped, because `locale` arrives from
 * `Accept-Language`.** Keyed raw into an unbounded `Map`, 20,000 valid-but-distinct tags
 * (`en-US-x-a0` …) retained 55 MB — memory the client chooses. `assertLocale` collapses `EN-us`
 * and `en-US` onto one key and `cachedFormatter` caps the rest; neither half is sufficient alone,
 * which is why both come from the one place `@ultimat3/time` reads them from too.
 *
 * It also REFUSES a tag `Intl` cannot parse (`X_LOCALE_INVALID`) instead of handing it on. Passing
 * it through was argued as "this seam decides a cache key, never whether a locale is acceptable",
 * which is true of the cache and was never an argument for the throw that followed: the
 * `Intl.NumberFormat` constructor then raised a bare, uncoded `RangeError` at a caller holding a
 * request header.
 */
function formatterFor(
  currency: string,
  locale: string,
  options: FormatMoneyOptions,
  exponent: number,
): Intl.NumberFormat {
  // `=== undefined`, never `??`: `??` coalesces on `null` too, so an untyped caller's blanked
  // option took the default instead of the refusal beside it.
  const digits =
    options.fractionDigits === undefined ? exponent : assertFractionDigits(options.fractionDigits);
  const trim = options.trimZeroFraction === true;
  const sign = options.accounting === true ? 'accounting' : 'standard';
  const tag = assertLocale(locale);
  // `trim` is in the key because it no longer changes `digits`: a trimmed and an untrimmed
  // formatter at one digit count are two formatters, and sharing an entry rendered whichever was
  // built first.
  const key = [
    tag,
    currency,
    options.display ?? 'symbol',
    digits,
    trim ? 'trim' : 'keep',
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
        // min = max, always: the digit count is the value's scale and never a range. Trimming is
        // `stripIfInteger` — drop the fraction of a WHOLE amount — because `minimumFractionDigits:
        // 0` trimmed every trailing zero and rendered 1250 cents as `$12.5`.
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        ...(trim ? { trailingZeroDisplay: 'stripIfInteger' as const } : {}),
        ...(options.grouping === 'never' ? { useGrouping: false } : {}),
      }),
  );
}
