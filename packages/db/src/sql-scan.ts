// Single responsibility: name the span of SQL text starting at one offset — a comment, a literal,
// a quoted identifier, a dollar-quoted body, or none of them. One scanner, because a splitter that
// disagreed with a guard about where a literal ends is a `;` sent as data or a `delete` read as
// prose, and the two answers must be the same answer.

const IDENTIFIER_START = /[A-Za-z_]/;
export const IDENTIFIER_PART = /[A-Za-z0-9_]/;
/** `$` is legal in an identifier after the first character — `a$b` is one name, not three. */
const IDENTIFIER_TAIL = /[A-Za-z0-9_$]/;

export type NoiseKind = 'line-comment' | 'block-comment' | 'string' | 'identifier' | 'dollar-body';

/** A span that is not code: what it is, and the offset just past it. */
export interface NoiseSpan {
  readonly kind: NoiseKind;
  readonly end: number;
}

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
 * Whether the `$` at `index` continues an identifier instead of opening a delimiter.
 *
 * The run before it is walked to its start rather than one character being read, because the
 * answer is what that run *began* as: `foo$tag$` is the single identifier Postgres reads it as
 * (`$` is legal after the first character), while `$1$tag$` is a bound parameter followed by a
 * real delimiter — a run opening with a digit or a `$` cannot be an identifier at all.
 */
function insideIdentifier(script: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && IDENTIFIER_TAIL.test(script[at] ?? '')) at -= 1;
  const first = script[at + 1];
  return at + 1 < index && first !== undefined && IDENTIFIER_START.test(first);
}

/**
 * The `$tag$` opening a dollar-quoted body at `index`, or `null`. A tag is an identifier or
 * empty, which is what keeps a bound parameter out: `$1` cannot open a body, so `where "id" = $1`
 * never swallows the rest of the script.
 *
 * A delimiter also needs separating from the identifier before it, or `select foo$tag$; select
 * 2;` is one statement to us and two to the server — which answers `cannot insert multiple
 * commands into a prepared statement`.
 */
export function dollarTagAt(script: string, index: number): string | null {
  if (script[index] !== '$') return null;
  if (insideIdentifier(script, index)) return null;
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
 * The non-code span starting at `index`, or `null` when `index` is code.
 *
 * Source order is the whole point: a caller that asked "is there a comment anywhere" before
 * "where do the literals end" reads the `--` in `select '--'; delete from posts` as a comment and
 * erases a live statement. Walking forward one span at a time cannot make that mistake, because
 * by the time the `--` is reached it is already inside the literal that was scanned first.
 *
 * A span left unterminated ends at the end of the text rather than being refused: Postgres names
 * that syntax error precisely, and a second SQL parser competing with it would only report the
 * same fault in worse words.
 */
export function noiseAt(script: string, index: number): NoiseSpan | null {
  const char = script[index];
  if (char === '-' && script[index + 1] === '-') {
    return { kind: 'line-comment', end: skipLineComment(script, index) };
  }
  if (char === '/' && script[index + 1] === '*') {
    return { kind: 'block-comment', end: skipBlockComment(script, index) };
  }
  if (char === "'") {
    return { kind: 'string', end: skipQuoted(script, index, char, escapesAt(script, index)) };
  }
  if (char === '"') {
    return { kind: 'identifier', end: skipQuoted(script, index, char, false) };
  }
  const tag = dollarTagAt(script, index);
  return tag === null ? null : { kind: 'dollar-body', end: skipDollarBody(script, index, tag) };
}
