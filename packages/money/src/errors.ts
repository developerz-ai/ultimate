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
  'X_CURRENCY_INVALID',
  'X_CURRENCY_REDEFINED',
  'X_ALLOCATION_INVALID',
  'X_RATE_MISSING',
  'X_MONEY_SCALE_INVALID',
] as const;

export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];

export const MONEY_ERROR_TITLES: Readonly<Record<MoneyErrorCode, string>> = {
  X_MONEY_NOT_INTEGER: 'a Money.minor value that is not an integer',
  X_CURRENCY_UNKNOWN: 'currency code not in the currency table',
  X_CURRENCY_MISMATCH: 'two Money values in different currencies',
  X_CURRENCY_INVALID: 'a registerCurrency declaration that cannot become a currency',
  X_CURRENCY_REDEFINED: 'one currency code registered twice with different meanings',
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
  const digits = countFractionDigits(value);
  // Past MAX_MONEY_SCALE no scale keeps every digit, so the offer is withdrawn rather than
  // clamped: `{ scale: 19 }` was a fix line that answered X_MONEY_SCALE_INVALID, and an
  // instruction that throws is not one.
  const keepThemAll =
    digits <= MAX_MONEY_SCALE
      ? `fromDecimal('${value}', '${currency}', { scale: ${digits} }) to keep every digit, or `
      : '';
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `"${value}" has more than ${exponent} fraction digit(s), which is all ${currency} is being counted in`,
    fix: `${keepThemAll}pass { rounding: 'half-up' } to fromDecimal to lose the extra digits on purpose`,
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

/**
 * A widened value that no longer fits a safe integer. Reported under `X_MONEY_SCALE_INVALID`
 * rather than `X_MONEY_NOT_INTEGER` because the caller never wrote a fractional minor — the scale
 * the operation had to meet at is what does not fit, and that code's fix line
 * (`fromDecimal('90071992547409900000', …)`) throws again. Same code as the other scale faults, so
 * the reader lands on the page about scales, which is where the answer is.
 */
export function scaleOverflow(
  scale: number,
  currency: string,
  fits: number | undefined,
): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_SCALE_INVALID',
    cause: `this ${currency} amount needs more digits at scale ${scale} than a safe integer holds`,
    fix:
      fits === undefined
        ? `the amount is too large for any scale — split it, or carry it as two ${currency} values`
        : `rescale(theFinerOperand, ${fits}, 'half-up') before combining — scale ${fits} is the finest that fits`,
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
  const upper = currency.toUpperCase().slice(0, 3) || 'XXX';
  // Two arrivals, one code, so the fix names both doors. The lookup is exact and case-sensitive,
  // which is what makes 'usd' the common one; the other is a currency the shipped ISO rows do not
  // carry, and since 1.2.0 that is a call the app makes rather than a fork of this package.
  return new MoneyError({
    code: 'X_CURRENCY_UNKNOWN',
    cause: `"${currency}" is not a currency this process knows — not in the shipped ISO-4217 rows, and not registered by the app`,
    fix: `pass a code currencyCodes() lists, uppercased — assertCurrency('${upper}') — or declare it once at boot: registerCurrency({ code: '${upper}', exponent: 2, name: '${upper}' })`,
  });
}

/**
 * A `registerCurrency` declaration that could not become a currency. Never echoes the rejected
 * value back into the `fix:` — `decimalTooPrecise` shipped that shape once, and an instruction
 * that raises the error it is answering is not an instruction.
 */
export function currencyDeclarationInvalid(reason: string, exampleCode: string): MoneyError {
  return new MoneyError({
    code: 'X_CURRENCY_INVALID',
    cause: reason,
    fix: `registerCurrency({ code: '${exampleCode}', exponent: 2, name: '${exampleCode}' }) — three A–Z letters, a whole exponent from 0 to ${MAX_MONEY_SCALE}, and a non-empty name`,
  });
}

/**
 * One code, one declaration. The exponent is the dangerous half: it decides what a stored `minor`
 * counts, so accepting a second one silently reinterprets every amount already written in that
 * currency by a power of ten. The name matters for a smaller reason that is still a bug —
 * `currencyInfo(code).name` is rendered, and two registrations would make it depend on import
 * order.
 */
export function currencyRedefined(
  code: string,
  existing: { readonly exponent: number; readonly name: string },
  attempted: { readonly exponent: number; readonly name: string },
): MoneyError {
  return new MoneyError({
    code: 'X_CURRENCY_REDEFINED',
    cause: `${code} is already registered as "${existing.name}" with exponent ${existing.exponent}; refusing to redefine it as "${attempted.name}" with exponent ${attempted.exponent}`,
    fix: `keep one registerCurrency({ code: '${code}', exponent: ${existing.exponent}, name: '${existing.name}' }) call and delete the other — to change a live exponent you must migrate every stored ${code} amount, because each one shifts by a power of ten`,
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
