/**
 * The `Money` value type: an integer count of minor units with its currency attached.
 * There is no float anywhere in this package, and no amount without a currency.
 */

import { isMoneyScale, type MoneyValue } from '@ultimat3/schema';
import { assertCurrency, type CurrencyCode, exponentOf } from './currency';
import { decimalNotNumeric, decimalTooPrecise, moneyNotInteger } from './errors';
import { type RoundingMode, roundRatio } from './rounding';
import { assertScale, commonScale, minorAt, moneyScale } from './scale';

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

/**
 * The only constructor. Validates the currency and rejects fractional minor units.
 *
 * `scale` names how many decimal places `minor` counts when the currency's own are not enough:
 * `money(2, 'USD', 6)` is $0.000002. Omitted — and canonically omitted again when it says nothing
 * the currency does not already say — so a value at the natural scale serializes byte-for-byte as
 * it always has, and there is exactly one encoding of it.
 */
export function money(minor: number, currency: string, scale?: number): Money {
  const code = assertCurrency(currency);
  if (!Number.isSafeInteger(minor)) throw moneyNotInteger(minor, code);
  // `-0` is one amount with two identities: `JSON.stringify` writes `0` while `Object.is` and any
  // keyed `Map` see something else, so a ledger reconciles against a value its own wire format
  // cannot reproduce. Normalised here because this is the one place canonical form is decided.
  const value = minor === 0 ? 0 : minor;
  if (scale === undefined) return { minor: value, currency: code };
  assertScale(scale);
  return scale === exponentOf(code)
    ? { minor: value, currency: code }
    : { minor: value, currency: code, scale };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export interface FromDecimalOptions {
  /** Required to accept a value with more precision than the target scale has. */
  rounding?: RoundingMode;
  /**
   * Decimal places to keep, when the currency's own are not enough:
   * `fromDecimal('0.000002', 'USD', { scale: 6 })`. Omitted, the currency decides, as before.
   */
  scale?: number;
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

  const exponent = options.scale === undefined ? exponentOf(code) : assertScale(options.scale);
  const negative = match[1] === '-';
  const fractionPart = match[3] ?? '';

  let minor: number;
  if (fractionPart.length <= exponent) {
    // Concatenating the digits *is* the minor-unit integer — no multiply, no drift.
    minor = Number(`${integerPart}${fractionPart.padEnd(exponent, '0')}`);
  } else {
    const mode = options.rounding;
    if (mode === undefined) throw decimalTooPrecise(value, code, exponent);
    // The exact fraction the digits spell, never a float: `Number('0.4999999999999999999')` is
    // exactly 0.5, so the float path showed `half-up` a tie the written decimal does not have and
    // billed 101 for an amount that owes 100. Same `roundRatio` multiply/divide/convert use.
    const dropped = fractionPart.slice(exponent);
    minor = roundRatio(
      BigInt(`${integerPart}${fractionPart}`),
      10n ** BigInt(dropped.length),
      mode,
    );
  }

  return money(negative ? -minor : minor, code, options.scale);
}

/** `1299 EUR` → `'12.99'`; `1200 JPY` → `'1200'`; `2 USD @ scale 6` → `'0.000002'`. */
export function toDecimalString(amount: Money): string {
  const exponent = moneyScale(amount);
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
  return amount.minor / 10 ** moneyScale(amount);
}

export function isMoney(value: unknown): value is Money {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { minor?: unknown; currency?: unknown; scale?: unknown };
  if (!Number.isSafeInteger(candidate.minor) || typeof candidate.currency !== 'string')
    return false;
  return candidate.scale === undefined || isMoneyScale(candidate.scale);
}

/**
 * Same currency, same value. Same *value*, not the same encoding: 1299 EUR and 12,990,000 EUR at
 * scale 6 are one amount written two ways, and a ledger that called them different would
 * reconcile against itself.
 */
export function equals(left: Money, right: Money): boolean {
  if (left.currency !== right.currency) return false;
  const scale = commonScale(left, right);
  return minorAt(left, scale) === minorAt(right, scale);
}

/**
 * Stable serialization for logs, JSON columns and the manifest: `EUR 1299`, and `USD 2e-6` for a
 * value whose scale is not the currency's — unchanged for every value that carries none.
 */
export function formatMoneyDebug(amount: Money): string {
  const scale = amount.scale;
  return scale === undefined
    ? `${amount.currency} ${amount.minor}`
    : `${amount.currency} ${amount.minor}e-${scale}`;
}

export function currencyOf(amount: Money): CurrencyCode {
  return amount.currency;
}
