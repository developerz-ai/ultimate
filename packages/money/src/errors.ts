/**
 * The X_* error codes owned by @ultimat3/money.
 * A money bug that throws is a bug you can fix; one that rounds is a bug you ship.
 */

import { registerErrorCodes, UltimateError } from '@ultimat3/core';
import { MAX_MONEY_SCALE } from '@ultimat3/schema';

export const MONEY_ERROR_CODES = [
  'X_MONEY_NOT_INTEGER',
  'X_CURRENCY_UNKNOWN',
  'X_CURRENCY_MISMATCH',
  'X_ALLOCATION_INVALID',
  'X_RATE_MISSING',
  'X_MONEY_SCALE_INVALID',
] as const;

export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];

export const MONEY_ERROR_TITLES: Readonly<Record<MoneyErrorCode, string>> = {
  X_MONEY_NOT_INTEGER: 'a Money.minor value that is not an integer',
  X_CURRENCY_UNKNOWN: 'currency code not in the currency table',
  X_CURRENCY_MISMATCH: 'two Money values in different currencies',
  X_ALLOCATION_INVALID: 'split ratios or part count are unusable',
  X_RATE_MISSING: 'no FX rate for the pair',
  X_MONEY_SCALE_INVALID: 'a Money.scale that is not a usable decimal exponent',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(MONEY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class MoneyError extends UltimateError {
  constructor(init: { code: MoneyErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

export function moneyNotInteger(minor: number, currency: string): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `minor units must be a safe integer, got ${String(minor)} for ${currency}`,
    fix: `use fromDecimal('${Number.isFinite(minor) ? minor : 0}', '${currency}') or round explicitly with multiply(m, factor, 'half-up')`,
  });
}

/**
 * A non-finite input to rounding is upstream float arithmetic that already lost the amount —
 * rounding it would invent a number, so it throws instead.
 */
export function notRoundable(value: number): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `cannot round a non-finite amount: ${String(value)}`,
    fix: 'trace the amount back to its source — a NaN or Infinity here means a division or a float multiply upstream; build amounts with fromDecimal(string, currency)',
  });
}

export function decimalTooPrecise(value: string, currency: string, exponent: number): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `"${value}" has more than ${exponent} fraction digit(s), which is all ${currency} is being counted in`,
    fix: `fromDecimal('${value}', '${currency}', { scale: ${countFractionDigits(value)} }) to keep every digit, or { rounding: 'half-up' } to lose them on purpose`,
  });
}

function countFractionDigits(value: string): number {
  return value.trim().split('.')[1]?.length ?? 0;
}

/** A scale outside 0…MAX_MONEY_SCALE names no decimal place a `minor` could count in. */
export function scaleInvalid(scale: number): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_SCALE_INVALID',
    cause: `a money scale must be a whole number of decimal places between 0 and ${MAX_MONEY_SCALE}, got ${String(scale)}`,
    fix: `use a scale in range — money(minor, currency, 6) for micros, or omit it for the currency's own minor unit`,
  });
}

/** Widening is exact; narrowing is a rounding decision, and `minorAt` does not make those. */
export function scaleNotWidening(from: number, to: number): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_SCALE_INVALID',
    cause: `cannot restate a value at scale ${from} as scale ${to} without dropping digits`,
    fix: `rescale(amount, ${to}, 'half-up') — narrowing needs the mode named at the call`,
  });
}

/**
 * A narrowing that would drop a non-zero digit. Reported as `X_MONEY_NOT_INTEGER` because that is
 * literally what it would produce — a fractional count of minor units — and the same situation
 * `fromDecimal` already answers with that code.
 */
export function rescaleNotExact(
  amount: { readonly minor: number; readonly currency: string },
  from: number,
  to: number,
): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `${amount.currency} ${amount.minor} at scale ${from} is not a whole number of minor units at scale ${to}`,
    fix: `rescale(amount, ${to}, 'half-up') — name the mode, or keep the value at scale ${from}`,
  });
}

export function decimalNotNumeric(value: string, currency: string): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `"${value}" is not a decimal amount — no grouping separators, no exponent notation`,
    fix: `pass a plain decimal string: fromDecimal('12.99', '${currency}')`,
  });
}

export function currencyUnknown(currency: string): MoneyError {
  return new MoneyError({
    code: 'X_CURRENCY_UNKNOWN',
    cause: `"${currency}" is not an ISO-4217 code in the currency table`,
    fix: `x money add-currency ${currency.toUpperCase().slice(0, 3) || 'XXX'} --exponent 2`,
  });
}

export function currencyRequired(context: string): MoneyError {
  return new MoneyError({
    code: 'X_CURRENCY_UNKNOWN',
    cause: `${context}: no currency to infer, and none was passed`,
    fix: "pass the currency explicitly, e.g. sum([], 'EUR')",
  });
}

export function currencyMismatch(left: string, right: string): MoneyError {
  return new MoneyError({
    code: 'X_CURRENCY_MISMATCH',
    cause: `refusing to combine ${left} and ${right} — two currencies are not one number`,
    fix: `convert(rightOperand, '${left}', rate) first, then combine`,
  });
}

export function allocationInvalid(cause: string): MoneyError {
  return new MoneyError({
    code: 'X_ALLOCATION_INVALID',
    cause,
    fix: 'pass a positive integer part count, or ratios that are finite, non-negative and not all zero',
  });
}

export function rateMissing(from: string, to: string): MoneyError {
  return new MoneyError({
    code: 'X_RATE_MISSING',
    cause: `no exchange rate available for ${from}→${to}`,
    fix: 'register a RateProvider that covers this pair — there is no default provider, because a wrong rate is worse than a missing one',
  });
}
