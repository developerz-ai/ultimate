// Character references in a compiled island template, decoded once — what a browser's parser does
// before an island reads `textContent` or `getAttribute`.

const NAMED = Object.freeze<Record<string, string>>({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT = '\uFFFD';

/** The five named entities Solid's escaper writes, and numeric references; an unknown name as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? (NAMED[name] as string) : whole;
    const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex as string, 16);
    // What the HTML parser does with a reference no character answers to: U+FFFD, never `\0` or a
    // lone surrogate.
    const invalid = point === 0 || point > MAX_CODE_POINT || (point >= 0xd800 && point <= 0xdfff);
    return invalid ? REPLACEMENT : String.fromCodePoint(point);
  });
}
