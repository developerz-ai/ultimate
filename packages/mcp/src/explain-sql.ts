// `db.explain`'s statement: the caller's SELECT, screened by `db.query`'s own layer 3, then wrapped
// in the one EXPLAIN this tool sends. The caller never writes `EXPLAIN` or `ANALYZE` itself — the
// wrapper is built here, so `ANALYZE` exists only in text this file produced, around a statement
// the read-only parse already passed, inside the host's `BEGIN READ ONLY` transaction.

import { McpQueryRejectedError } from './errors';
import { assertReadOnlyQuery } from './readonly-sql';

/** The two leaders `db.explain` plans. `explain`, `show`, `table` and `values` are `db.query`'s. */
const PLAN_LEADERS: ReadonlySet<string> = new Set(['select', 'with']);

const LEADER = /^[a-z_]+/;

/** Named in `db.explain`'s `guards`, beside `db.query`'s `parse:single-read`. */
export const EXPLAIN_GUARD = 'parse:select-only';

/**
 * Throw unless `sql` is ONE `SELECT` or `WITH … SELECT`, and answer the EXPLAIN that plans it.
 *
 * Every refusal `db.query` makes is made first and verbatim — a second statement after `;`, a
 * data-modifying CTE (`WITH d AS (DELETE …) SELECT …`), a locking clause, a banned call — because
 * `ANALYZE` executes the plan, and a statement this tool executes is held to the read-only bar.
 * The leader check runs first, so `explain analyze …` is told to drop its own EXPLAIN rather than
 * handed `db.query`'s write refusal for the word `analyze`. It reads the verbatim text, so a
 * statement that opens with a comment is refused rather than stripped — the SELECT comes first.
 */
export function explainStatement(sql: string, analyze: boolean): string {
  const leader = LEADER.exec(sql.trimStart().toLowerCase())?.[0] ?? '';
  if (!PLAN_LEADERS.has(leader)) {
    throw new McpQueryRejectedError({
      cause: `db.explain plans one SELECT or WITH … SELECT, and the statement begins with "${leader === '' ? sql.trimStart().slice(0, 2) : leader}"`,
      fix: 'db.explain({ sql: "select id from posts where author_id = 1", analyze: true })   # send the bare SELECT; db.explain writes the EXPLAIN',
    });
  }
  const statement = assertReadOnlyQuery(sql);
  // `BUFFERS` only beside `ANALYZE`: without execution there are no buffers to count, and the
  // option alone is refused by the Postgres versions PGlite tracks.
  const options = analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
  return `EXPLAIN (${options}) ${statement}`;
}

/**
 * The plan out of EXPLAIN's single `QUERY PLAN` cell. A driver hands `json` back parsed or as
 * text depending on its type parsers, so both are read; anything else is returned as it came,
 * never guessed into a shape.
 */
export function planOf(cell: unknown): unknown {
  if (typeof cell !== 'string') return cell;
  try {
    return JSON.parse(cell) as unknown;
  } catch {
    return cell;
  }
}
