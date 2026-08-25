// Single responsibility: one SQL statement as one capped line, for an error to print. Its own
// module because two rails now report statements — `destructive.ts` and `ungeneratable.ts` — and a
// second copy of "what does a reported statement look like" is two answers to one question.

/**
 * Only the comments *preceding* the statement come off, the ones `statementsOf` carries in from the
 * file header or from the `-- backfill …` note above it; the SQL itself stays verbatim.
 *
 * Blanking is for **deciding**, never for reporting: `stripSqlNoise` empties quoted identifiers, so
 * a report built from it says `drop table ""`, which names nothing an author can act on.
 */
export function statementExcerpt(statement: string): string {
  const line = statement
    .replace(/^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
