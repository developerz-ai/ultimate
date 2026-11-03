// Single responsibility: sending a batch's chunks so the batch is one write. `bulk-write.ts` decides
// what the chunks are; this decides what holds them together, split from `pg-driver.ts`, which
// resolves the connection and hands it over.

import { type DbClient, withTransaction } from '@ultimat3/db';
import { insertChunks } from './bulk-write';
import type { EntityCore } from './entity';
import { hasJsOnlyInvariant } from './invariants';
import { decodeRow, type PhysicalRow } from './pg-row';
import { type InsertShape, insertStatement } from './pg-write-sql';

/**
 * One chunk is one autocommit statement, atomic by itself, with no `BEGIN`. Several are one
 * transaction — a SAVEPOINT inside an open one — or a batch failing in its last chunk would leave
 * the earlier ones stored, and a job retrying it would meet its own partial write. The memory
 * driver leaves nothing, and the two mean one thing.
 *
 * `direct` is resolved by the CALLER first, so a pinned repository inside a transaction opened on
 * another client is refused (`X_REPO_CLIENT_PINNED`) before anything opens, and `pinned` is where
 * the transaction opens when the repository has one, as in `judgedWrite`.
 *
 * An updating upsert with an app-only rule takes a transaction at any width: what a collision
 * stored is the incoming row merged into the stored one, and only `returning *` shows that row. The
 * memory driver judges the same merge in `write`, so without this the rule held only there.
 */
export const writeChunks = async <Row>(
  entity: EntityCore<Row>,
  bound: readonly ReadonlyMap<string, unknown>[],
  shape: InsertShape,
  direct: DbClient,
  pinned: DbClient | undefined,
): Promise<readonly Row[]> => {
  const chunks = insertChunks(bound, shape.columns.length);
  const judges =
    shape.conflict !== undefined &&
    shape.conflict.set.length > 0 &&
    hasJsOnlyInvariant(entity.$invariants);
  const send = async (on: DbClient): Promise<readonly Row[]> => {
    const written: Row[] = [];
    for (const chunk of chunks) {
      const stored = await on.query<PhysicalRow>(insertStatement(entity, chunk, shape));
      for (const row of stored) written.push(decodeRow(entity, row));
    }
    if (judges) for (const row of written) entity.$assert(row);
    return written;
  };
  if (chunks.length === 1 && !judges) return send(direct);
  return withTransaction(send, pinned === undefined ? {} : { client: pinned });
};
