// Single responsibility: sending an `updateMany`'s statements so the batch is one write, and
// deciding whether its rows come back at all. `pg-update-many-sql.ts` compiles the statements;
// `pg-driver.ts` resolves the connection, attributes the call and hands both over.

import type { SqlFragment } from '@ultimat3/db';
import { type DbClient, withTransaction } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
import { decodeRow, type PhysicalRow } from './pg-row';
import type { UpdateManyPlan } from './update-many';

/** What the batch did: how many rows it updated, and those rows when `returning` asked for them. */
export interface UpdateManyResult<Row> {
  readonly count: number;
  readonly rows: readonly Row[];
}

/**
 * `returning "<table>".*` or a count. The rows are read back when an app-only rule must judge
 * them (the plan already refused a batch past `MAX_ASSERTED_ROWS`), or when the search mirror's
 * sink is open and the batch fits that same bound — each id matches at most one row, so the batch
 * width bounds the rows without the `count(*)` `updateWhere` spends on it. Otherwise a count:
 * nobody reads the rows, and a backfill must not stream its table back into the process.
 */
export const updateManyReturns = <Row>(
  entity: EntityCore<Row>,
  plan: UpdateManyPlan<Row>,
  sinkOpen: boolean,
): boolean =>
  hasJsOnlyInvariant(entity.$invariants) || (sinkOpen && plan.patches.length <= MAX_ASSERTED_ROWS);

/**
 * One statement and no rule to judge is one autocommit statement. Several are one transaction — a
 * SAVEPOINT inside an open one — so a batch failing in its last chunk leaves no earlier chunk
 * stored, as `writeChunks` holds `insertAll`. An app-only rule takes the transaction at any width:
 * the rows are judged after the server stored them, and the refusal has to take them back.
 *
 * `direct` is resolved by the caller first (`X_REPO_CLIENT_PINNED` before anything opens); `pinned`
 * is where the transaction opens when the repository has one.
 */
export const sendUpdateMany = async <Row>(
  entity: EntityCore<Row>,
  statements: readonly SqlFragment[],
  returning: boolean,
  direct: DbClient,
  pinned: DbClient | undefined,
): Promise<UpdateManyResult<Row>> => {
  const judges = hasJsOnlyInvariant(entity.$invariants);
  const send = async (on: DbClient): Promise<UpdateManyResult<Row>> => {
    let count = 0;
    const rows: Row[] = [];
    for (const statement of statements) {
      if (!returning) {
        count += await on.execute(statement);
        continue;
      }
      const stored = await on.query<PhysicalRow>(statement);
      for (const row of stored) rows.push(decodeRow(entity, row));
      count += stored.length;
    }
    if (judges) for (const row of rows) entity.$assert(row);
    return { count, rows };
  };
  if (statements.length <= 1 && !judges) return send(direct);
  return withTransaction(send, pinned === undefined ? {} : { client: pinned });
};
