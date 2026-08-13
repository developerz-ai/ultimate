/**
 * The `Money` value type: an integer count of minor units with its currency attached.
 * There is no float anywhere in this package, and no amount without a currency.
 */

import type { MoneyValue } from '@ultimat3/schema';
import { assertCurrency, type CurrencyCode, exponentOf, scaleOf } from './currency';
import { decimalNotNumeric, decimalTooPrecise, moneyNotInteger } from './errors';
import { type RoundingMode, roundToInteger } from './rounding';

/**
 * `{ minor: 129900, currency: 'EUR' }` is €1,299.00. Instances are immutable, and now enforced
 * rather than asked for: both fields are `readonly`.
 *
 * An **alias**, never a restatement. `@ultimat3/schema`'s `MoneyValue` is the framework's one
 * declaration (tier 0, so every package may reach it) and `@ultimat3/entity`'s `MoneyValue` is
 * the same alias — a second structural copy is what let `minor` drift to `bigint` in the entity
 * layer, so a row it decoded satisfied neither `t.money` nor `JSON.stringify`.
 */
export type Money = MoneyValue;

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** The only constructor. Validates the currency and rejects fractional minor units. */
export function money(minor: number, currency: string): Money {
  const code = assertCurrency(currency);
  if (!Number.isSafeInteger(minor)) throw moneyNotInteger(minor, code);
  return { minor, currency: code };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export interface FromDecimalOptions {
  /** Required to accept a value with more precision than the currency has. */
  rounding?: RoundingMode;
}

/**
 * Parse a decimal **string** — never a float. `fromDecimal(12.99, 'EUR')` would already
 * have lost the value before this function saw it, so the signature refuses it.
 * `'12.99'` → 1299 EUR · `'1200'` → 1200 JPY · `'1.234'` → 1234 KWD.
 */
export function fromDecimal(
  value: string,
  currency: string,
  options: FromDecimalOptions = {},
): Money {
  const code = assertCurrency(currency);
  const match = DECIMAL.exec(value.trim());
  const integerPart = match?.[2];
  if (match === null || integerPart === undefined) {
    throw decimalNotNumeric(value, code);
  }

  const exponent = exponentOf(code);
  const negative = match[1] === '-';
  const fractionPart = match[3] ?? '';

  let minor: number;
  if (fractionPart.length <= exponent) {
    // Concatenating the digits *is* the minor-unit integer — no multiply, no drift.
    minor = Number(`${integerPart}${fractionPart.padEnd(exponent, '0')}`);
  } else {
    const mode = options.rounding;
    if (mode === undefined) throw decimalTooPrecise(value, code, exponent);
    const kept = Number(`${integerPart}${fractionPart.slice(0, exponent)}`);
    const remainder = Number(`0.${fractionPart.slice(exponent)}`);
    minor = roundToInteger(kept + remainder, mode);
  }

  if (!Number.isSafeInteger(minor)) throw moneyNotInteger(minor, code);
  return { minor: negative ? -minor : minor, currency: code };
}

/** `1299 EUR` → `'12.99'`; `1200 JPY` → `'1200'`; `1234 KWD` → `'1.234'`. */
export function toDecimalString(amount: Money): string {
  const exponent = exponentOf(amount.currency);
  const sign = amount.minor < 0 ? '-' : '';
  const digits = Math.abs(amount.minor)
    .toString()
    .padStart(exponent + 1, '0');
  if (exponent === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, digits.length - exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Major units as a float. **Format-time only** — the one place a division by the
 * currency scale is legitimate, because `Intl.NumberFormat` takes a number.
 */
export function toDecimalNumber(amount: Money): number {
  return amount.minor / scaleOf(amount.currency);
}

export function isMoney(value: unknown): value is Money {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { minor?: unknown; currency?: unknown };
  return Number.isSafeInteger(candidate.minor) && typeof candidate.currency === 'string';
}

/** Same currency, same minor units. */
export function equals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}

/** Stable serialization for logs, JSON columns and the manifest: `EUR 1299`. */
export function formatMoneyDebug(amount: Money): string {
  return `${amount.currency} ${amount.minor}`;
}

export function currencyOf(amount: Money): CurrencyCode {
  return amount.currency;
}
