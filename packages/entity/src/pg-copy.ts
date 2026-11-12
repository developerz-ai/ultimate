// Single responsibility: `copyAll`'s send on Postgres — `COPY … FROM STDIN` in chunks of at most
// `MAX_ROWS_PER_COPY` when the client can stream one, the count-only insert when it cannot. The batch arrives judged
// and bound (`pg-bulk-repo.ts`); what is decided here is only which wire carries it, so the rows
// stored are the same either way.

import {
  canCopyIn,
  type DbClient,
  identifier,
  join,
  type SqlFragment,
  sql,
  withTransaction,
} from '@ultimat3/db';
import { countChunks } from './bulk-write-send';
import type { EntityCore } from './entity';
import { allColumns } from './pg-row';

/**
 * The statement a copy streams into. Identifiers only — the entity's own table and columns — and
 * no value: COPY binds nothing, which `copyIn` refuses before any send.
 */
export const copyStatement = <Row>(
  entity: EntityCore<Row>,
  columns: readonly string[],
): SqlFragment =>
  sql`copy ${identifier(entity.$table)} (${join(columns.map(identifier))}) from stdin`;

/** Each bound row as its cells in `columns`' order — lazily, so 100k rows are never a second array. */
function* cellsOf(
  bound: readonly ReadonlyMap<string, unknown>[],
  columns: readonly string[],
): Generator<readonly unknown[]> {
  for (const row of bound) yield columns.map((column) => row.get(column));
}

/**
 * Rows per COPY statement. One statement must stay inside the role's `statement_timeout` and the
 * pool's unanswered-statement sweep, which a single COPY of an unbounded batch does not: measured
 * 2026-11-11 on loopback Postgres 17 at load 20+, a 50,000-row, 12-column COPY took 0.3-0.6 s.
 */
export const MAX_ROWS_PER_COPY = 50_000;

/**
 * Rows stored. Each chunk is one COPY; several are one transaction — a SAVEPOINT inside an open
 * one — exactly as `countChunks` holds several inserts, so the batch is all or nothing. Inside a
 * caller's transaction `direct` is that transaction's own client, and its pin copies.
 *
 * The insert is taken instead, and stores the same rows, when COPY would not mean the same thing:
 * a client with no copy stream (PGlite, a fake), row security armed (`canCopyIn`: Postgres refuses
 * COPY FROM under RLS), a row that does not bind every listed column (only a cell can spell
 * `default`), or no column named at all (`copy t () from stdin` is a syntax error; an insert
 * writes `default` in every cell).
 */
export const copyRows = async <Row>(
  entity: EntityCore<Row>,
  bound: readonly ReadonlyMap<string, unknown>[],
  columns: readonly string[],
  direct: DbClient,
  pinned: DbClient | undefined,
): Promise<number> => {
  if (bound.length === 0) return 0;
  const complete = columns.length > 0 && bound.every((row) => columns.every((c) => row.has(c)));
  if (!complete || !canCopyIn(direct)) {
    // No column named is `statementColumns`' case too: every column listed, every cell `default`.
    const listed = columns.length > 0 ? columns : allColumns(entity);
    return countChunks(entity, bound, { columns: listed, returning: false }, direct, pinned);
  }
  const target = copyStatement(entity, columns);
  if (bound.length <= MAX_ROWS_PER_COPY) return direct.copyIn(target, cellsOf(bound, columns));
  const chunks: (readonly ReadonlyMap<string, unknown>[])[] = [];
  for (let from = 0; from < bound.length; from += MAX_ROWS_PER_COPY) {
    chunks.push(bound.slice(from, from + MAX_ROWS_PER_COPY));
  }
  return withTransaction(
    async (tx) => {
      let count = 0;
      for (const chunk of chunks) {
        count += canCopyIn(tx)
          ? await tx.copyIn(target, cellsOf(chunk, columns))
          : await countChunks(entity, chunk, { columns, returning: false }, tx, undefined);
      }
      return count;
    },
    pinned === undefined ? {} : { client: pinned },
  );
};
