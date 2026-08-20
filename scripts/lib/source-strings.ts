// Where a TypeScript source evaluates a string literal. One tiny scanner, because the two things a
// text rule over source gets wrong are both solved by knowing what is a token and what is not:
//
//   - a citation inside a COMMENT is prose about a command, not a use of one;
//   - a citation inside ANOTHER string is a fixture's source text, not this file's own value —
//     `await write('a.ts', "throw new E({ fix: 'x db status' });")` writes a file whose fix is
//     deliberately broken, and reading the inner literal as this test's own claim is how a rule
//     ends up needing a filename allowlist to excuse the tests that test it.
//
// Not a parser: it tracks comments, quotes and escapes and nothing else. That is exactly enough to
// answer "is this offset code, and is this literal a top-level one", and no more.

export interface SourceString {
  /** Offset of the opening quote. */
  readonly at: number;
  readonly quote: "'" | '"' | '`';
  /** The literal's contents, unescaped only for `\\` and the quote itself. */
  readonly value: string;
  /** Everything on this literal's line before it — what a caller matches `fix:` against. */
  readonly prefix: string;
  /** 1-based. */
  readonly line: number;
}

const QUOTES = new Set(["'", '"', '`']);

/**
 * Whether an offset is INSIDE a string literal rather than in code. The other half of the same
 * question `sourceStrings` answers, and the reason it is here: a text rule over test sources reads
 * its own fixtures otherwise — a checker's unit test spells the bad shape as a string on purpose,
 * and flagging it is the rule reporting a finding on the test that proves it works.
 */
export const insideString = (strings: readonly SourceString[], at: number): boolean =>
  strings.some((literal) => at > literal.at && at < literal.at + literal.value.length + 2);

/**
 * Every string literal the code itself evaluates, in order. Nested literals are not returned by
 * construction: the scanner consumes a literal whole, so characters inside it are never re-read as
 * code. A template's `${…}` is not descended into for the same reason a parser is not written here
 * — a citation is asserted as a plain literal in every case this repo has, and guessing at
 * interpolation would report findings on strings nobody wrote.
 */
export function sourceStrings(source: string): readonly SourceString[] {
  const out: SourceString[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\n') {
      line += 1;
      index += 1;
      lineStart = index;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += source.slice(index, stop).split('\n').length - 1;
      lineStart = source.lastIndexOf('\n', stop) + 1;
      index = stop;
      continue;
    }
    if (!QUOTES.has(char)) {
      index += 1;
      continue;
    }
    const quote = char as SourceString['quote'];
    const prefix = source.slice(lineStart, index);
    const openedAt = index;
    const openedOn = line;
    let value = '';
    index += 1;
    while (index < source.length) {
      const inner = source[index] ?? '';
      if (inner === '\\') {
        value += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (inner === quote) {
        index += 1;
        break;
      }
      if (inner === '\n') line += 1;
      value += inner;
      index += 1;
    }
    out.push({ at: openedAt, quote, value, prefix, line: openedOn });
    lineStart = source.lastIndexOf('\n', index - 1) + 1;
  }
  return out;
}
