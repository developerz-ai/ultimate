/**
 * The ISO-4217 minor-unit exponent table. Every scale in the package derives from here —
 * a hardcoded `/ 100` is a bug in JPY (0 digits) and in KWD (3 digits).
 * As of 2026-07.
 */

import { currencyUnknown } from './errors';

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

export const CURRENCIES: readonly CurrencyInfo[] = TABLE;

export function isValidCurrency(currency: string): boolean {
  return BY_CODE.has(currency);
}

/** Loud lookup: an unknown code is a data bug, not a formatting quirk. */
export function currencyInfo(currency: string): CurrencyInfo {
  const info = BY_CODE.get(currency);
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

export function currencyCodes(): CurrencyCode[] {
  return TABLE.map((info) => info.code);
}
