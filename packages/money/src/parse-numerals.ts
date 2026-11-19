// Single responsibility: what a locale writes around and inside an amount, read off `Intl` — the
// CURRENCY format's separators and grouping, the plain-number ones, the digits, the minus signs,
// the code and every symbol, and whether accounting wraps a negative in parentheses. No table here.

import { cachedFormatter } from '@ultimat3/core';

/** One way a locale separates an amount: its decimal mark, its group mark, its grouping. */
export interface SeparatorSet {
  readonly decimal: string;
  readonly group: string;
  /** The integer grouped this way, in ASCII digits: what a typed group must match. */
  readonly grouped: (integer: string) => string;
}

export interface AmountNotation {
  /** The currency forms' sets first, the plain number's last; none conflicting with an earlier one. */
  readonly sets: readonly SeparatorSet[];
  readonly minus: readonly string[];
  /** Each of the locale's ten digits → its ASCII digit. */
  readonly digits: ReadonlyMap<string, string>;
  /** The code and every symbol, longest first, so `ZAR` goes before the `R` inside it. */
  readonly marks: readonly string[];
  /** The locale's accounting form writes a negative as `(…)`. */
  readonly parenthesised: boolean;
}

/** The spaces a group separator may be typed as: a keyboard has no narrow no-break space. */
export const SPACES = new Set([' ', '\u00A0', '\u202F', '\u2009']);
const sameMark = (a: string, b: string): boolean => a === b || (SPACES.has(a) && SPACES.has(b));

const formatters = new Map<string, Intl.NumberFormat>();
/** Every formatter through core's bounded cache, keyed on the screened tag: `format.ts`'s rule. */
const formatterOf = (tag: string, kind: string, options: Intl.NumberFormatOptions) =>
  cachedFormatter(formatters, `${tag}|${kind}`, () => new Intl.NumberFormat(tag, options));

const currencyOptions = (code: string, extra: Intl.NumberFormatOptions) =>
  ({ style: 'currency', currency: code, ...extra }) as const;

function setOf(
  parts: Intl.NumberFormatPart[],
  whole: Intl.NumberFormat,
  toAscii: (text: string) => string,
): SeparatorSet {
  const part = (type: string, fallback: string): string =>
    parts.find((each) => each.type === type)?.value ?? fallback;
  const group = part('group', ',');
  return {
    decimal: part('decimal', '.'),
    group,
    // `BigInt` formats an integer of any length exactly: no float between the digits and `Intl`.
    // Only the integer and group parts: a currency formatter also writes the symbol and spaces.
    grouped: (integer) =>
      toAscii(
        whole
          .formatToParts(BigInt(integer))
          .filter((each) => each.type === 'integer' || each.type === 'group')
          .map((each) => (each.type === 'group' ? group : each.value))
          .join(''),
      ),
  };
}

/** Every way `formatMoney` may write an amount: each display, standard and accounting sign. */
const FORMS = (['symbol', 'code', 'narrowSymbol'] as const).flatMap((display) =>
  (['standard', 'accounting'] as const).map((sign) => ({ display, sign })),
);

const notations = new Map<string, AmountNotation>();
/** Built once per (screened tag, code), bounded like a formatter: it holds ~15 of them. */
export const notationOf = (tag: string, code: string): AmountNotation =>
  cachedFormatter(notations, `${tag}|${code}`, () => buildNotation(tag, code));

function buildNotation(tag: string, code: string): AmountNotation {
  const sample = -1234567.5;
  const plainDigits = formatterOf(tag, 'plain', { useGrouping: false, maximumFractionDigits: 0 });
  const digits = new Map<string, string>();
  for (let digit = 0; digit <= 9; digit += 1) digits.set(plainDigits.format(digit), String(digit));
  const toAscii = (text: string): string =>
    [...text].map((char) => digits.get(char) ?? char).join('');

  // The currency forms first, in `formatMoney`'s default order, the plain number last. `en-IN`
  // groups `(₹1,234,567.50)` the Western way and `-₹12,34,567.50` the Indian way: each form
  // brings its own grouping, found by `property-money.test.ts`.
  const candidates: { parts: Intl.NumberFormatPart[]; set: SeparatorSet }[] = [];
  for (const { display, sign } of FORMS) {
    const form = { currencyDisplay: display, currencySign: sign };
    const key = `${display}|${sign}|${code}`;
    // Two fraction digits whatever the currency's: JPY writes none, and a decimal mark read off a
    // sample without one fell back to `.` — `pt-BR`'s group mark.
    const sampleOptions = { ...form, minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const parts = formatterOf(tag, key, currencyOptions(code, sampleOptions)).formatToParts(sample);
    const whole = formatterOf(
      tag,
      `whole|${key}`,
      // `useGrouping: true` is ALWAYS group: `es`/`pl` print `1234,56` (CLDR minimum grouping 2) but
      // a person types `1.234,56`, and the ungrouped spelling is accepted anyway.
      currencyOptions(code, {
        ...form,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
        useGrouping: true,
      }),
    );
    candidates.push({ parts, set: setOf(parts, whole, toAscii) });
  }
  const plainParts = formatterOf(tag, 'parts', {}).formatToParts(sample);
  const grouping = formatterOf(tag, 'grouped', { maximumFractionDigits: 0, useGrouping: true });
  candidates.push({ parts: plainParts, set: setOf(plainParts, grouping, toAscii) });

  // Where one set's group mark is another's decimal mark (`en-DE`: `1.234,56` plain, `€1,234.56`
  // currency), reading both would make one text two amounts. The earlier set wins — the currency
  // format, what every price on the page shows — so `parseAmount(formatMoney(m))` stays `m`, and
  // the later one is never consulted. Sets that agree on both marks never read a text two ways.
  const sets: SeparatorSet[] = [];
  const probe = '123456789';
  for (const { set } of candidates) {
    const conflicts = sets.some(
      (kept) => sameMark(kept.group, set.decimal) || sameMark(kept.decimal, set.group),
    );
    const repeats = sets.some(
      (kept) =>
        kept.decimal === set.decimal &&
        sameMark(kept.group, set.group) &&
        kept.grouped(probe) === set.grouped(probe),
    );
    if (!conflicts && !repeats) sets.push(set);
  }

  const marks = new Set<string>([code]);
  const minus = new Set<string>(['-']);
  let parenthesised = false;
  for (const { parts } of candidates) {
    for (const each of parts) {
      if (each.type === 'currency') {
        // And its compatibility form: `ja-JP` writes the full-width ￥, a keyboard types ¥.
        marks.add(each.value).add(each.value.normalize('NFKC'));
      } else if (each.type === 'minusSign') minus.add(each.value);
      else if (each.type === 'literal' && each.value.includes('(')) parenthesised = true;
    }
  }
  return {
    sets,
    minus: [...minus],
    digits,
    marks: [...marks].sort((a, b) => b.length - a.length),
    parenthesised,
  };
}

export const isGroupOf = (set: SeparatorSet, char: string): boolean => sameMark(set.group, char);
