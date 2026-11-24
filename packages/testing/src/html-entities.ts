// Character references back to characters, for the visible text a render test compares with a
// catalog string: every numeric reference, and the named ones copy commonly carries.

/** A `Map`, so a lookup never reaches `Object.prototype` (`bun run proto-index`). */
const NAMED: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['hellip', '…'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['middot', '·'],
  ['bull', '•'],
  ['deg', '°'],
  ['times', '×'],
  ['euro', '€'],
  ['pound', '£'],
  ['yen', '¥'],
  ['cent', '¢'],
  ['sect', '§'],
]);

const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/** What the HTML standard reads in place of a null, a surrogate or a code point past Unicode. */
const REPLACEMENT = '�';

const fromCodePoint = (point: number): string =>
  point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
    ? REPLACEMENT
    : String.fromCodePoint(point);

/**
 * One pass, so a decoded `&` never starts another reference: the text `&amp;lt;` — an author's
 * literal `&lt;` — reads `&lt;`, never `<`. A name outside the table stays as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    REFERENCE,
    (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
      return NAMED.get(name ?? '') ?? whole;
    },
  );
}
