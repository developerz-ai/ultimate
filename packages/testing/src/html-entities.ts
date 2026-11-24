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

/**
 * The names the HTML standard also reads WITHOUT a semicolon in text (its legacy list), among
 * those the table holds: `&amp` renders `&`, `&copy2026` renders `©2026`.
 */
const LEGACY = [
  'amp',
  'lt',
  'gt',
  'quot',
  'nbsp',
  'copy',
  'reg',
  'laquo',
  'raquo',
  'middot',
  'deg',
  'times',
  'pound',
  'yen',
  'cent',
  'sect',
] as const;

/** A numeric reference's semicolon is optional, as a browser reads it; a named one's is not. */
const REFERENCE = /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*)(;?))/g;

/**
 * `&#128;`–`&#159;` name the windows-1252 characters there, not C1 controls: the HTML standard's
 * numeric reference table, which is what a browser renders (`&#128;` is `€`).
 */
const WINDOWS_1252: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

/** What the HTML standard reads in place of a null, a surrogate or a code point past Unicode. */
const REPLACEMENT = '�';

const fromCodePoint = (point: number): string =>
  point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
    ? REPLACEMENT
    : String.fromCodePoint(WINDOWS_1252.get(point) ?? point);

/** `&name` with no semicolon: the longest legacy name it starts with, the rest kept as text. */
function legacyPrefix(whole: string, name: string): string {
  let longest = '';
  for (const legacy of LEGACY) {
    if (name.startsWith(legacy) && legacy.length > longest.length) longest = legacy;
  }
  if (longest === '') return whole;
  return (NAMED.get(longest) ?? '') + name.slice(longest.length);
}

/**
 * One pass, so a decoded `&` never starts another reference: the text `&amp;lt;` — an author's
 * literal `&lt;` — reads `&lt;`, never `<`. A name outside the table stays as written, and so does
 * a semicolon-less name outside the legacy list.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    REFERENCE,
    (
      whole,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
      semicolon: string | undefined,
    ) => {
      if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
      if (semicolon === '') return legacyPrefix(whole, name ?? '');
      return NAMED.get(name ?? '') ?? whole;
    },
  );
}
