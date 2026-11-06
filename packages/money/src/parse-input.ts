// Single responsibility: an amount a PERSON typed, read in their locale — `1.234,56` in `de-DE`,
// `1,234.56` in `en-US`, Arabic-Indic digits in `ar-EG` — into `Money`, or refused. The separators
// and digits are `Intl`'s, never a table here; an ambiguous or over-precise reading is refused,
// never rounded, and no float is ever made: the digits go on to `fromDecimal` as a string.

import { assertLocale, cachedFormatter, renderCauseValue } from '@ultimat3/core';
import { assertCurrency, exponentOf } from './currency';
import { MoneyError } from './errors';
import type { Money } from './money';
import { fromDecimal } from './money';

export interface ParseAmountOptions {
  readonly currency: string;
  /** The person's locale: whose separators and digits the text is read with. */
  readonly locale: string;
}

interface LocaleNumerals {
  readonly decimal: string;
  readonly group: string;
  readonly minus: string;
  /** Each of the locale's ten digits → its ASCII digit. */
  readonly digits: ReadonlyMap<string, string>;
  /** The locale's own grouping of an integer, in ASCII digits: what a typed group must match. */
  readonly grouped: (integer: string) => string;
}

const formatters = new Map<string, Intl.NumberFormat>();
/** Every formatter through core's bounded cache, keyed on the screened tag: `format.ts`'s rule. */
const formatterOf = (tag: string, kind: string): Intl.NumberFormat =>
  cachedFormatter(formatters, `${tag}|${kind}`, () =>
    kind === 'grouped' || kind === 'plain'
      ? new Intl.NumberFormat(tag, { useGrouping: kind === 'grouped', maximumFractionDigits: 0 })
      : kind === 'parts'
        ? new Intl.NumberFormat(tag)
        : new Intl.NumberFormat(tag, { style: 'currency', currency: kind }),
  );

/** The spaces a group separator may be typed as: a keyboard has no narrow no-break space. */
const SPACES = new Set([' ', ' ', ' ', ' ']);

function numeralsOf(tag: string): LocaleNumerals {
  const parts = formatterOf(tag, 'parts').formatToParts(-1234567.5);
  const part = (type: string, fallback: string): string =>
    parts.find((each) => each.type === type)?.value ?? fallback;
  const plain = formatterOf(tag, 'plain');
  const digits = new Map<string, string>();
  for (let digit = 0; digit <= 9; digit += 1) digits.set(plain.format(digit), String(digit));
  const toAscii = (text: string): string =>
    [...text].map((char) => digits.get(char) ?? char).join('');
  const grouping = formatterOf(tag, 'grouped');
  return {
    decimal: part('decimal', '.'),
    group: part('group', ','),
    minus: part('minusSign', '-'),
    digits,
    // `BigInt` formats an integer of any length exactly: no float between the digits and `Intl`.
    grouped: (integer) => toAscii(grouping.format(BigInt(integer))),
  };
}

const refused = (text: string, locale: string, currency: string, reason: string): MoneyError =>
  new MoneyError({
    code: 'X_MONEY_INPUT_INVALID',
    cause: `the amount typed could not be read as ${currency} in ${locale}: ${reason}`,
    fix: `parseAmount(text, { currency: '${currency}', locale: '${locale}' })   # re-prompt the person for the amount; nothing was rounded or guessed`,
    meta: { locale, currency, length: text.length },
  });

/**
 * `parseAmount('1.234,56', { currency: 'EUR', locale: 'de-DE' })` → 123456 EUR. A currency symbol
 * or code the locale writes is allowed and ignored; a sign is the locale's minus or `-`. Refused
 * (`X_MONEY_INPUT_INVALID`): a character the locale does not use in a number, a group separator out
 * of the locale's own grouping (`1.5` in `de-DE` is not 1.5 and not 15), a second decimal mark, and
 * more fraction digits than the currency has — `1,234` in `de-DE` is 1.234, and EUR has two.
 */
export function parseAmount(text: string, options: ParseAmountOptions): Money {
  const tag = assertLocale(options.locale);
  const code = assertCurrency(options.currency);
  const fail = (reason: string): MoneyError => refused(text, tag, code, reason);
  const numerals = numeralsOf(tag);
  const symbols = formatterOf(tag, code)
    .formatToParts(1)
    .filter((each) => each.type === 'currency')
    .map((each) => each.value);

  let rest = text.trim();
  for (const symbol of [...symbols, code]) rest = rest.replace(symbol, '').trim();
  // Bidi marks travel with a copied right-to-left amount; they are not characters of the number.
  rest = rest.replace(/[‎‏؜]/g, '');
  let negative = false;
  if (rest.startsWith(numerals.minus) || rest.startsWith('-')) {
    negative = true;
    rest = rest.slice(rest.startsWith(numerals.minus) ? numerals.minus.length : 1).trim();
  }
  if (rest === '') throw fail('there are no digits');

  const isGroup = (char: string): boolean =>
    char === numerals.group || (SPACES.has(numerals.group) && SPACES.has(char));
  let integer = '';
  let typedInteger = '';
  let fraction: string | undefined;
  for (const char of rest) {
    const digit = numerals.digits.get(char) ?? (/^[0-9]$/.test(char) ? char : undefined);
    if (digit !== undefined) {
      if (fraction === undefined) {
        integer += digit;
        typedInteger += digit;
      } else fraction += digit;
    } else if (char === numerals.decimal) {
      if (fraction !== undefined) throw fail(`${renderCauseValue(char)} appears twice`);
      fraction = '';
    } else if (isGroup(char)) {
      if (fraction !== undefined) {
        throw fail(`${renderCauseValue(char)} groups digits after the decimal mark`);
      }
      typedInteger += numerals.group;
    } else {
      throw fail(`${renderCauseValue(char)} is not part of a number in ${tag}`);
    }
  }
  if (integer === '' && (fraction === undefined || fraction === '')) {
    throw fail('there are no digits');
  }
  // Grouped as the locale groups, or not grouped at all: anything else is a reading two people
  // would disagree on, and the person is asked again rather than one of them being guessed.
  if (typedInteger !== integer && typedInteger !== numerals.grouped(integer)) {
    throw fail(`${renderCauseValue(numerals.group)} does not group the digits the way ${tag} does`);
  }
  const exponent = exponentOf(code);
  if (fraction !== undefined && fraction.length > exponent) {
    throw fail(`${fraction.length} digits after the decimal mark, and ${code} has ${exponent}`);
  }
  const decimal = `${negative ? '-' : ''}${integer === '' ? '0' : integer}${
    fraction === undefined || fraction === '' ? '' : `.${fraction}`
  }`;
  return fromDecimal(decimal, code);
}
