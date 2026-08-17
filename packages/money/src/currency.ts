/**
 * The minor-unit exponent table: the ISO-4217 rows Ultimate ships, plus the rows an app registers.
 * Every scale in the package derives from here — a hardcoded `/ 100` is a bug in JPY (0 digits)
 * and in KWD (3 digits). As of 2026-08.
 */

import { renderCauseValue } from '@ultimat3/core';
import { isCurrencyCode, isMoneyScale, MAX_MONEY_SCALE } from '@ultimat3/schema';
import { currencyDeclarationInvalid, currencyRedefined, currencyUnknown } from './errors';

/** Uppercase ISO-4217 alphabetic code. */
export type CurrencyCode = string;

export interface CurrencyInfo {
  code: CurrencyCode;
  /** Number of decimal digits in the minor unit: USD 2, JPY 0, KWD 3. */
  exponent: number;
  name: string;
}

const TABLE: readonly CurrencyInfo[] = [
  { code: 'AED', exponent: 2, name: 'UAE Dirham' },
  { code: 'ARS', exponent: 2, name: 'Argentine Peso' },
  { code: 'AUD', exponent: 2, name: 'Australian Dollar' },
  { code: 'BGN', exponent: 2, name: 'Bulgarian Lev' },
  { code: 'BHD', exponent: 3, name: 'Bahraini Dinar' },
  { code: 'BRL', exponent: 2, name: 'Brazilian Real' },
  { code: 'CAD', exponent: 2, name: 'Canadian Dollar' },
  { code: 'CHF', exponent: 2, name: 'Swiss Franc' },
  { code: 'CLP', exponent: 0, name: 'Chilean Peso' },
  { code: 'CNY', exponent: 2, name: 'Yuan Renminbi' },
  { code: 'COP', exponent: 2, name: 'Colombian Peso' },
  { code: 'CZK', exponent: 2, name: 'Czech Koruna' },
  { code: 'DKK', exponent: 2, name: 'Danish Krone' },
  { code: 'EGP', exponent: 2, name: 'Egyptian Pound' },
  { code: 'EUR', exponent: 2, name: 'Euro' },
  { code: 'GBP', exponent: 2, name: 'Pound Sterling' },
  { code: 'HKD', exponent: 2, name: 'Hong Kong Dollar' },
  { code: 'HUF', exponent: 2, name: 'Forint' },
  { code: 'IDR', exponent: 2, name: 'Rupiah' },
  { code: 'ILS', exponent: 2, name: 'New Israeli Sheqel' },
  { code: 'INR', exponent: 2, name: 'Indian Rupee' },
  { code: 'ISK', exponent: 0, name: 'Iceland Krona' },
  { code: 'JOD', exponent: 3, name: 'Jordanian Dinar' },
  { code: 'JPY', exponent: 0, name: 'Yen' },
  { code: 'KES', exponent: 2, name: 'Kenyan Shilling' },
  { code: 'KRW', exponent: 0, name: 'Won' },
  { code: 'KWD', exponent: 3, name: 'Kuwaiti Dinar' },
  { code: 'MAD', exponent: 2, name: 'Moroccan Dirham' },
  { code: 'MXN', exponent: 2, name: 'Mexican Peso' },
  { code: 'MYR', exponent: 2, name: 'Malaysian Ringgit' },
  { code: 'NGN', exponent: 2, name: 'Naira' },
  { code: 'NOK', exponent: 2, name: 'Norwegian Krone' },
  { code: 'NZD', exponent: 2, name: 'New Zealand Dollar' },
  { code: 'OMR', exponent: 3, name: 'Rial Omani' },
  { code: 'PEN', exponent: 2, name: 'Sol' },
  { code: 'PHP', exponent: 2, name: 'Philippine Peso' },
  { code: 'PKR', exponent: 2, name: 'Pakistan Rupee' },
  { code: 'PLN', exponent: 2, name: 'Zloty' },
  { code: 'RON', exponent: 2, name: 'Romanian Leu' },
  { code: 'RSD', exponent: 2, name: 'Serbian Dinar' },
  { code: 'SAR', exponent: 2, name: 'Saudi Riyal' },
  { code: 'SEK', exponent: 2, name: 'Swedish Krona' },
  { code: 'SGD', exponent: 2, name: 'Singapore Dollar' },
  { code: 'THB', exponent: 2, name: 'Baht' },
  { code: 'TND', exponent: 3, name: 'Tunisian Dinar' },
  { code: 'TRY', exponent: 2, name: 'Turkish Lira' },
  { code: 'TWD', exponent: 2, name: 'New Taiwan Dollar' },
  { code: 'UAH', exponent: 2, name: 'Hryvnia' },
  { code: 'USD', exponent: 2, name: 'US Dollar' },
  { code: 'UYU', exponent: 2, name: 'Peso Uruguayo' },
  { code: 'VND', exponent: 0, name: 'Dong' },
  { code: 'XOF', exponent: 0, name: 'CFA Franc BCEAO' },
  { code: 'ZAR', exponent: 2, name: 'Rand' },
];

const BY_CODE: ReadonlyMap<string, CurrencyInfo> = new Map(
  TABLE.map((info) => [info.code, info] as const),
);

/**
 * What the app added. Separate from `BY_CODE` so a shipped ISO row can never be overwritten and
 * `CURRENCIES` keeps meaning exactly what it meant: the constant this package ships.
 */
const REGISTERED = new Map<string, CurrencyInfo>();

/**
 * The ISO-4217 rows Ultimate ships — a constant, the same in every process.
 *
 * Not the same question as `currencyCodes()`, which answers for *this* process and includes
 * whatever the app registered. That is why one is a value and the other is a call.
 */
export const CURRENCIES: readonly CurrencyInfo[] = TABLE;

/**
 * Declare a currency the shipped ISO rows do not carry — a local currency, a scrip, a loyalty
 * point, a token. Call it once, at boot, before any amount in that currency is built.
 *
 * The 53 shipped rows are a *convention* — one useful subset of ISO-4217 — and axiom 8 says an app
 * encodes its own by calling a function, never by forking the package. The rest of the framework
 * already agreed: `@ultimat3/schema`'s `moneySchema`, the published OpenAPI contract and
 * `@ultimat3/entity`'s `char(3)` CHECK all accept any `^[A-Z]{3}$`, so an app could take an
 * unregistered code over HTTP and store it, and only arithmetic would refuse it afterwards.
 *
 * Returns the row now in force, so the identical second call is a no-op rather than a crash — a
 * module imported twice must not take the process down.
 */
export function registerCurrency(info: CurrencyInfo): CurrencyInfo {
  const { code, exponent, name } = info;
  // `isCurrencyCode`, imported for the same reason `isMoneyScale` below is: this is the bound
  // `moneySchema`, the published OpenAPI `pattern` and `@ultimat3/entity`'s CHECK all apply, and a
  // registration accepting a code any of them refuses would put a row in a table the app cannot
  // read back. It also carries the `typeof` half, so an untyped caller's symbol is a refusal here
  // rather than a `TypeError` from `.test()`. Not taste either:
  // `Intl.NumberFormat({ style: 'currency', currency })` throws a `RangeError` on anything else,
  // so a registration that skipped the shape would format nothing.
  if (!isCurrencyCode(code)) {
    throw currencyDeclarationInvalid(
      // `renderCauseValue`, not `String(code)`: the signature says `string` but nothing stops an
      // untyped caller passing a symbol, and `String()` raises on one — the validator would then
      // throw a TypeError instead of the coded refusal it exists to produce.
      `a currency code must be three uppercase letters, got ${renderCauseValue(code)}`,
      'XBT',
    );
  }
  // `isMoneyScale`, imported rather than restated: an exponent past MAX_MONEY_SCALE names a
  // decimal place `minor` could not count in, and one bound with two declarations is one bound
  // that drifts. It also rejects a non-integer, so a 2.5 cannot round itself into the table.
  if (!isMoneyScale(exponent)) {
    throw currencyDeclarationInvalid(
      `${code} needs a whole number of decimal places between 0 and ${MAX_MONEY_SCALE} — an exponent decides what a stored minor counts, so there is no safe default`,
      code,
    );
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw currencyDeclarationInvalid(`${code} needs a non-empty name`, code);
  }

  const existing = BY_CODE.get(code) ?? REGISTERED.get(code);
  if (existing !== undefined) {
    if (existing.exponent === exponent && existing.name === name) return existing;
    throw currencyRedefined(code, existing, { exponent, name });
  }

  const row: CurrencyInfo = Object.freeze({ code, exponent, name });
  REGISTERED.set(code, row);
  return row;
}

export function isValidCurrency(currency: string): boolean {
  return BY_CODE.has(currency) || REGISTERED.has(currency);
}

/** Loud lookup: an unknown code is a data bug, not a formatting quirk. */
export function currencyInfo(currency: string): CurrencyInfo {
  const info = BY_CODE.get(currency) ?? REGISTERED.get(currency);
  if (info === undefined) throw currencyUnknown(currency);
  return info;
}

export function assertCurrency(currency: string): CurrencyCode {
  return currencyInfo(currency).code;
}

/** Decimal digits in the minor unit. */
export function exponentOf(currency: string): number {
  return currencyInfo(currency).exponent;
}

/** Minor units per major unit: 100 for EUR, 1 for JPY, 1000 for KWD. */
export function scaleOf(currency: string): number {
  return 10 ** exponentOf(currency);
}

/**
 * Every code this process accepts — the shipped rows plus whatever the app registered. Sorted, so
 * two processes with the same registrations print the same list.
 *
 * This is the one enumeration `X_CURRENCY_UNKNOWN`'s fix line points at, so it has to include the
 * registered rows: a fix that named a list the accepted code is missing from would be the same
 * dead end that error used to hand back.
 */
export function currencyCodes(): CurrencyCode[] {
  return [...TABLE.map((info) => info.code), ...REGISTERED.keys()].sort();
}
