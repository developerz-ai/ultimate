/**
 * The X_* error codes owned by @ultimat3/money.
 * A money bug that throws is a bug you can fix; one that rounds is a bug you ship.
 */

import { registerErrorCodes, renderFixLiteral, UltimateError } from '@ultimat3/core';
import { isCurrencyCode, MAX_MONEY_SCALE } from '@ultimat3/schema';

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

/**
 * A currency code fit to stand in a `fix:` — the caller's when it already is one, `XXX` otherwise.
 * Two rules at once, and every factory below that names a code goes through it.
 *
 * A fix is PASTED AND RUN, so a code carrying a quote closes the literal it sits in and the
 * instruction becomes a syntax error — `assertCurrency('O'Reilly')` — which is worse than no fix,
 * because it looks runnable. And a malformed code echoed back would name a call that raises the
 * error it is answering, the rule `currencyDeclarationInvalid` below already states. Every one of
 * these factories is exported, so the argument is whatever an app passed, not only what this
 * package throws. `bun run error-render` cannot see the class: these parameters are typed
 * `string`, not `unknown`.
 */
function codeExample(currency: string): string {
  // Uppercased and cut to three because the lookup is case-sensitive, so 'usd' is the common
  // arrival and 'USD' answers it. The `typeof` guard is what keeps an untyped caller's symbol from
  // throwing out of `.toUpperCase()` inside an error factory.
  const upper = typeof currency === 'string' ? currency.toUpperCase().slice(0, 3) : '';
  return isCurrencyCode(upper) ? upper : 'XXX';
}

/** The same code as source. Safe to interpolate: `codeExample` answers `^[A-Z]{3}$`, nothing else. */
function codeLiteral(currency: string): string {
  return `'${codeExample(currency)}'`;
}

export function moneyNotInteger(minor: number, currency: string): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_NOT_INTEGER',
    cause: `minor units must be a safe integer, got ${String(minor)} for ${currency}`,
    fix: `use fromDecimal('${Number.isFinite(minor) ? minor : 0}', ${codeLiteral(currency)}) or round explicitly with multiply(m, factor, 'half-up')`,
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
      ? // `renderFixLiteral`, not `'${value}'`: the amount is a caller's string, and `fromDecimal`
        // trims before it parses — so a value ending in a newline reached the fix line and put a
        // raw line break inside a single-quoted literal, which no reader can paste.
        `fromDecimal(${renderFixLiteral(value.trim(), "'12.9999'")}, ${codeLiteral(currency)}, { scale: ${digits} }) to keep every digit, or `
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

/**
 * A `roundToDigits` digit count that names no decimal place. Reported as `X_MONEY_SCALE_INVALID`
 * because a digit count IS a scale — `10 ** 1.5` is not a power of ten, and `BigInt(1.5)` is a
 * bare `RangeError` out of a function whose every other refusal is coded.
 */
export function digitsInvalid(digits: number): MoneyError {
  return new MoneyError({
    code: 'X_MONEY_SCALE_INVALID',
    cause: `a digit count must be a whole number between -${MAX_MONEY_SCALE} and ${MAX_MONEY_SCALE}, got ${String(digits)}`,
    fix: "pass an integer digit count — roundToDigits(value, 2, 'half-up') for two decimal places",
  });
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
        ? `the amount is too large for any scale — split it, or carry it as two ${codeExample(currency)} values`
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
    fix: `pass a plain decimal string: fromDecimal('12.99', ${codeLiteral(currency)})`,
  });
}

export function currencyUnknown(currency: string): MoneyError {
  const example = codeLiteral(currency);
  // Two arrivals, one code, so the fix names both doors. The lookup is exact and case-sensitive,
  // which is what makes 'usd' the common one; the other is a currency the shipped ISO rows do not
  // carry, and since 1.2.0 that is a call the app makes rather than a fork of this package.
  return new MoneyError({
    code: 'X_CURRENCY_UNKNOWN',
    cause: `"${currency}" is not a currency this process knows — not in the shipped ISO-4217 rows, and not registered by the app`,
    fix: `pass a code currencyCodes() lists, uppercased — assertCurrency(${example}) — or declare it once at boot: registerCurrency({ code: ${example}, exponent: 2, name: ${example} })`,
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
    fix: `registerCurrency({ code: ${codeLiteral(exampleCode)}, exponent: 2, name: ${codeLiteral(exampleCode)} }) — three A–Z letters, a whole exponent from 0 to ${MAX_MONEY_SCALE}, and a non-empty name`,
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
    // `renderFixLiteral` on the name and nowhere else: a name is free text by design — `O'Reilly
    // Points` is a currency an app may legitimately register — and it is the one value here that
    // cannot be gated into a safe shape, so it is escaped instead.
    fix: `keep one registerCurrency({ code: ${codeLiteral(code)}, exponent: ${existing.exponent}, name: ${renderFixLiteral(existing.name, "'the name already registered'")} }) call and delete the other — to change a live exponent you must migrate every stored ${codeExample(code)} amount, because each one shifts by a power of ten`,
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
    fix: `convert(rightOperand, ${codeLiteral(left)}, rate) first, then combine`,
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
