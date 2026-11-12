// Single responsibility: sending an `updateMany`'s statements so the batch is one write, and
// deciding whether its rows come back at all. `pg-update-many-sql.ts` compiles the statements;
// `pg-driver.ts` resolves the connection, attributes the call and hands both over.

import type { SqlFragment } from '@ultimat3/db';
import { type DbClient, withTransaction } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
import { decodeRow, type PhysicalRow } from './pg-row';
import { updateManyPresence } from './pg-update-many-sql';
import type { UpdateManyPlan } from './update-many';
import { versionOf } from './version-lock';
import { entityStaleBatch } from './version-lock-errors';

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
  /** The batch, for a declared lock's stale check (`version-lock.ts`). Unversioned: unused. */
  plan?: UpdateManyPlan<Row>,
): Promise<UpdateManyResult<Row>> => {
  const judges = hasJsOnlyInvariant(entity.$invariants);
  const lock = plan === undefined ? null : versionOf(entity);
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
    if (lock !== null && plan !== undefined && count < plan.patches.length) {
      await refuseStale(entity, plan, lock, count, on);
    }
    return { count, rows };
  };
  if (statements.length <= 1 && !judges && lock === null) return send(direct);
  return withTransaction(send, pinned === undefined ? {} : { client: pinned });
};

/**
 * Fewer rows written than the batch named: either rows that are gone or out of scope — not written
 * and not counted, as without a lock — or rows present at another version. The second refuses the
 * batch, and the transaction it runs in takes back the rows already written.
 */
const refuseStale = async <Row>(
  entity: EntityCore<Row>,
  plan: UpdateManyPlan<Row>,
  lock: string,
  written: number,
  on: DbClient,
): Promise<void> => {
  let present = 0;
  for (const statement of updateManyPresence(entity, plan)) {
    const [row] = await on.query<{ readonly n: number }>(statement);
    present += Number(row?.n ?? 0);
  }
  if (present > written) {
    throw entityStaleBatch(entity.$name, lock, present - written, plan.patches.length);
  }
};
