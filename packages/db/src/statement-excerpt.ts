// Single responsibility: one SQL statement as one capped line, for an error to print. Its own
// module because two rails now report statements — `destructive.ts` and `ungeneratable.ts` — and a
// second copy of "what does a reported statement look like" is two answers to one question.

/** The excerpt's ceiling, and where a longer one is cut to make room for `...`. */
const MAX_CHARS = 120;
const CUT_AT = 117;

/** `\s` as the regex reads it, one UTF-16 unit at a time. Non-global, so it carries no state. */
const SPACE = /\s/;

/**
 * Where the statement starts once the comments PRECEDING it are skipped. A scan, not a regex:
 * `^(?:\s*(?:--…|/\*…\*\/)\s*)+` has two adjacent `\s*` across repetitions, which CodeQL flags as
 * polynomial backtracking (js/polynomial-redos). Each step here advances, so it is one pass.
 */
const bodyStart = (statement: string): number => {
  let at = 0;
  for (;;) {
    let from = at;
    while (from < statement.length && SPACE.test(statement.charAt(from))) from += 1;
    if (statement.startsWith('--', from)) {
      const end = statement.indexOf('\n', from);
      at = end === -1 ? statement.length : end;
      continue;
    }
    if (statement.startsWith('/*', from)) {
      const end = statement.indexOf('*/', from + 2);
      // Unclosed: not a comment, so the statement starts here, as the regex left it.
      if (end === -1) return at;
      at = end + 2;
      continue;
    }
    return at;
  }
};

/**
 * Only the comments *preceding* the statement come off, the ones `statementsOf` carries in from the
 * file header or from the `-- backfill …` note above it; the SQL itself stays verbatim.
 *
 * Blanking is for **deciding**, never for reporting: `stripSqlNoise` empties quoted identifiers, so
 * a report built from it says `drop table ""`, which names nothing an author can act on.
 *
 * Whitespace runs collapse to one space, leading and trailing ones go, and reading stops at the
 * 121st character kept: past it the answer is already the 117-character cut.
 */
export function statementExcerpt(statement: string): string {
  let line = '';
  let pendingSpace = false;
  for (let at = bodyStart(statement); at < statement.length; at += 1) {
    const char = statement.charAt(at);
    if (SPACE.test(char)) {
      pendingSpace = line.length > 0;
      continue;
    }
    if (pendingSpace) line += ' ';
    pendingSpace = false;
    line += char;
    if (line.length > MAX_CHARS) return `${line.slice(0, CUT_AT)}...`;
  }
  return line;
}
