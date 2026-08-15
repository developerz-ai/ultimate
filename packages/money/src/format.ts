/**
 * `Intl.NumberFormat` at the edge. Fraction digits come from the currency exponent, so
 * JPY renders without decimals and KWD with three, without a per-locale special case.
 */

import { exponentOf } from './currency';
import { type Money, toDecimalNumber } from './money';

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
  /** Force a digit count; defaults to the currency's minor-unit exponent. */
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
  return formatterFor(amount.currency, locale, options).formatToParts(toDecimalNumber(amount));
}

/** The symbol alone, e.g. for an input prefix: `€`, `¥`, `KD`. */
export function currencySymbol(currency: string, locale: string): string {
  const parts = formatterFor(currency, locale, { display: 'narrowSymbol' }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency;
}

/** Digits only, no symbol — for editable inputs and CSV exports. */
export function formatMoneyDecimal(amount: Money, locale: string): string {
  const digits = exponentOf(amount.currency);
  return new Intl.NumberFormat(locale, {
    style: 'decimal',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(toDecimalNumber(amount));
}

const cache = new Map<string, Intl.NumberFormat>();

function formatterFor(
  currency: string,
  locale: string,
  options: FormatMoneyOptions,
): Intl.NumberFormat {
  const exponent = exponentOf(currency);
  const digits =
    options.fractionDigits ?? (options.trimZeroFraction === true ? undefined : exponent);
  const sign = options.accounting === true ? 'accounting' : 'standard';
  const key = [
    locale,
    currency,
    options.display ?? 'symbol',
    digits ?? 'auto',
    options.grouping ?? 'auto',
    sign,
  ].join('|');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: options.display ?? 'symbol',
    currencySign: sign,
    ...(digits === undefined
      ? { minimumFractionDigits: 0, maximumFractionDigits: exponent }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    ...(options.grouping === 'never' ? { useGrouping: false } : {}),
  });
  cache.set(key, formatter);
  return formatter;
}
