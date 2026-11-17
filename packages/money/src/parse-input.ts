// Single responsibility: an amount a PERSON typed, read in their locale — `1.234,56` in `de-DE`,
// `1,234.56` in `en-US`, Arabic-Indic digits in `ar-EG`, anything `formatMoney` shows — into
// `Money`, or refused. The notation is `Intl`'s (`parse-numerals.ts`); an ambiguous or
// over-precise reading is refused, never rounded, and the digits go on to `fromDecimal` as a string.

import { assertLocale, renderCauseValue } from '@ultimat3/core';
import { assertCurrency, exponentOf } from './currency';
import { MoneyError } from './errors';
import type { Money } from './money';
import { fromDecimal } from './money';
import type { AmountNotation, SeparatorSet } from './parse-numerals';
import { isGroupOf, notationOf } from './parse-numerals';

export interface ParseAmountOptions {
  readonly currency: string;
  /** The person's locale: whose separators and digits the text is read with. */
  readonly locale: string;
}

const refused = (text: unknown, locale: string, currency: string, reason: string): MoneyError =>
  new MoneyError({
    code: 'X_MONEY_INPUT_INVALID',
    cause: `the amount typed could not be read as ${currency} in ${locale}: ${reason}`,
    fix: `parseAmount(text, { currency: '${currency}', locale: '${locale}' })   # re-prompt the person for the amount; nothing was rounded or guessed`,
    meta: { locale, currency, length: typeof text === 'string' ? text.length : 0 },
  });

/** The unsigned digits, read with ONE separator set: the reason it cannot be, or the decimal. */
function readWith(rest: string, set: SeparatorSet, notation: AmountNotation, tag: string) {
  let integer = '';
  let typedInteger = '';
  let fraction: string | undefined;
  for (const char of rest) {
    const digit = notation.digits.get(char) ?? (/^[0-9]$/.test(char) ? char : undefined);
    if (digit !== undefined) {
      if (fraction === undefined) {
        integer += digit;
        typedInteger += digit;
      } else fraction += digit;
    } else if (char === set.decimal) {
      if (fraction !== undefined) return { reason: `${renderCauseValue(char)} appears twice` };
      fraction = '';
    } else if (isGroupOf(set, char)) {
      if (fraction !== undefined) {
        return { reason: `${renderCauseValue(char)} groups digits after the decimal mark` };
      }
      typedInteger += set.group;
    } else {
      return { reason: `${renderCauseValue(char)} is not part of a number in ${tag}` };
    }
  }
  if (integer === '' && (fraction === undefined || fraction === '')) {
    return { reason: 'there are no digits' };
  }
  // Grouped as the locale groups, or not grouped at all: anything else is a reading two people
  // would disagree on, and the person is asked again rather than one of them being guessed.
  if (typedInteger !== integer && typedInteger !== set.grouped(integer)) {
    return {
      reason: `${renderCauseValue(set.group)} does not group the digits the way ${tag} does`,
    };
  }
  return { integer: integer === '' ? '0' : integer, fraction: fraction ?? '' };
}

/**
 * `parseAmount('1.234,56', { currency: 'EUR', locale: 'de-DE' })` → 123456 EUR. Reads the
 * currency format's separators and grouping (what `formatMoney` shows) and the plain-number ones;
 * the code, the symbol and the narrow symbol are ignored; a sign is a locale minus, `-`, or the
 * locale's accounting parentheses. Refused (`X_MONEY_INPUT_INVALID`): a character the locale does
 * not use in a number, a group separator out of the locale's own grouping (`1.5` in `de-DE` is not
 * 1.5 and not 15), a second decimal mark, and more fraction digits than the currency has.
 */
export function parseAmount(text: string, options: ParseAmountOptions): Money {
  const tag = assertLocale(options.locale);
  const code = assertCurrency(options.currency);
  const fail = (reason: string): MoneyError => refused(text, tag, code, reason);
  // The signature says `string`; a JSON body does not read it, and `.trim()` on a number was a
  // bare TypeError — a 500 for an amount the person can simply be asked for again.
  if (typeof text !== 'string') throw fail(`${renderCauseValue(text)} is not text`);
  const notation = notationOf(tag, code);

  // Bidi marks travel with a copied right-to-left amount; they are not characters of the number.
  // Stripped FIRST: `ar-EG` closes BHD's symbol with U+200F, and a trim before the strip leaves the
  // no-break space the mark shielded inside the number (found by `property-money.test.ts`).
  let rest = text.replace(/[‎‏؜]/g, '').trim();
  let negative = false;
  if (notation.parenthesised && rest.startsWith('(') && rest.endsWith(')')) {
    negative = true;
    rest = rest.slice(1, -1).trim();
  }
  // Longest first: `en-ZA` writes ZAR's symbol `R`, and stripping it first left `ZA` behind.
  for (const mark of notation.marks) rest = rest.replace(mark, '').trim();
  const minus = notation.minus.find((sign) => rest.startsWith(sign));
  if (minus !== undefined) {
    if (negative) throw fail(`${renderCauseValue(minus)} is a second sign inside the parentheses`);
    negative = true;
    rest = rest.slice(minus.length).trim();
  }
  if (rest === '') throw fail('there are no digits');

  // Either set may read the text; `notationOf` keeps both only where they cannot disagree, so the
  // first reading is the only one. The currency set's refusal is the one named.
  const readings = notation.sets.map((set) => readWith(rest, set, notation, tag));
  const read = readings.find((each) => each.integer !== undefined) ?? readings[0];
  if (read === undefined || read.integer === undefined) throw fail(read?.reason ?? 'no reading');
  const exponent = exponentOf(code);
  if (read.fraction.length > exponent) {
    throw fail(
      `${read.fraction.length} digits after the decimal mark, and ${code} has ${exponent}`,
    );
  }
  const decimal = `${negative ? '-' : ''}${read.integer}${read.fraction === '' ? '' : `.${read.fraction}`}`;
  return fromDecimal(decimal, code);
}
