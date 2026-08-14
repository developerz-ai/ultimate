// Single responsibility: cut a SQL script into the statements a driver sends one at a time.
// One send is one statement — the extended protocol answers `cannot insert multiple commands into
// a prepared statement`, which is every PGlite send and every parameterised Bun.SQL one — and `;`
// separates only outside a literal, a quoted identifier, a dollar-quoted body and a comment.
// A generated migration contains all four, so a naive `split(';')` is not a smaller version of
// this: it is a different, wrong answer.

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/** Past a `--` comment, including the newline that ends it. */
function skipLineComment(script: string, index: number): number {
  const newline = script.indexOf('\n', index);
  return newline === -1 ? script.length : newline + 1;
}

/**
 * Past a block comment. Postgres **nests** them, so the depth is counted rather than matched to
 * the first terminator — a commented-out block that itself contains a comment closes once, and
 * every `;` after that point would otherwise be read as data.
 */
function skipBlockComment(script: string, index: number): number {
  let depth = 0;
  let at = index;
  while (at < script.length) {
    const char = script[at];
    const next = script[at + 1];
    if (char === '/' && next === '*') {
      depth += 1;
      at += 2;
      continue;
    }
    if (char === '*' && next === '/') {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
      continue;
    }
    at += 1;
  }
  return script.length;
}

/**
 * Past a run closing on `quote`, where a doubled quote is an escaped one — `'it''s'` and
 * `"a""b"` are each one token. `escapes` is the `E''` dialect, the only one where a backslash
 * escapes the character after it; a standard-conforming string carries it as data.
 */
function skipQuoted(script: string, index: number, quote: string, escapes: boolean): number {
  let at = index + 1;
  while (at < script.length) {
    const char = script[at];
    if (escapes && char === '\\') {
      at += 2;
      continue;
    }
    if (char === quote) {
      if (script[at + 1] === quote) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
  return script.length;
}

/**
 * The `$tag$` opening a dollar-quoted body at `index`, or `null`. A tag is an identifier or
 * empty, which is what keeps a bound parameter out: `$1` cannot open a body, so `where "id" = $1`
 * never swallows the rest of the script.
 */
function dollarTagAt(script: string, index: number): string | null {
  if (script[index] !== '$') return null;
  let at = index + 1;
  while (at < script.length) {
    const char = script[at] ?? '';
    const valid = at === index + 1 ? IDENTIFIER_START.test(char) : IDENTIFIER_PART.test(char);
    if (!valid) break;
    at += 1;
  }
  return script[at] === '$' ? script.slice(index, at + 1) : null;
}

/** Past the body `tag` opened, up to and including the matching close. */
function skipDollarBody(script: string, index: number, tag: string): number {
  const close = script.indexOf(tag, index + tag.length);
  return close === -1 ? script.length : close + tag.length;
}

/**
 * Whether the `'` at `index` opens an `E''` string. The prefix is a whole token, so a trailing
 * `e` on an identifier does not turn the literal beside it into an escape string.
 */
function escapesAt(script: string, index: number): boolean {
  const prefix = script[index - 1];
  if (prefix !== 'E' && prefix !== 'e') return false;
  const before = script[index - 2];
  return before === undefined || !IDENTIFIER_PART.test(before);
}

/**
 * The statements of `script`, in order, each without its separator.
 *
 * A chunk holding only whitespace and comments is **not** a statement and is dropped: an empty
 * `up`, or one whose tail is the `-- backfill …, then: …;` note `generateMigration` emits, would
 * otherwise reach the driver as an empty query. A literal or body left unterminated is returned
 * as it stands rather than refused here — Postgres names that syntax error precisely, and a
 * second SQL parser competing with it would only report the same fault in worse words.
 */
export function statementsOf(script: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  // Set by anything that is not whitespace and not inside a comment: what makes a chunk a
  // statement rather than a note between two of them.
  let content = false;

  const cut = (end: number): void => {
    const text = content ? script.slice(start, end).trim() : '';
    if (text.length > 0) statements.push(text);
    content = false;
  };

  while (index < script.length) {
    const char = script[index] ?? '';
    if (char === '-' && script[index + 1] === '-') {
      index = skipLineComment(script, index);
      continue;
    }
    if (char === '/' && script[index + 1] === '*') {
      index = skipBlockComment(script, index);
      continue;
    }
    if (char === ';') {
      cut(index);
      start = index + 1;
      index += 1;
      continue;
    }
    if (!WHITESPACE.test(char)) content = true;
    if (char === "'" || char === '"') {
      index = skipQuoted(script, index, char, char === "'" && escapesAt(script, index));
      continue;
    }
    const tag = dollarTagAt(script, index);
    index = tag === null ? index + 1 : skipDollarBody(script, index, tag);
  }
  cut(script.length);
  return statements;
}
