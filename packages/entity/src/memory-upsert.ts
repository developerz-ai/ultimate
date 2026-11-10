// Single responsibility: the memory driver's `upsertAll` — which incoming row collides with which
// stored one, and what a collision overwrites — so a test over memory resolves a conflict exactly
// as `insert … on conflict` does. Split from `memory-repo.ts` for its line ceiling.

import { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
import type { EntityCore } from './entity';
import { undoingBatch } from './memory-batch';
import type { RepoOptions, UpsertArgs } from './repo';
import { advanceVersion } from './search-index-version';
import { assertRowTenant } from './tenancy';
import type { RowWrite } from './types';

const field = (row: unknown, property: string): unknown =>
  typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[property] : undefined;

/** What the upsert needs of the repository it belongs to: its rows and its one write. */
export interface MemoryUpsertScope<Row> {
  readonly entity: EntityCore<Row>;
  readonly rows: { values(): Iterable<Row> };
  write(
    given: RowWrite<Row>,
    options: RepoOptions | undefined,
    operation: string,
    from?: string,
  ): Row;
  storeKey(row: unknown): string;
  judgeReferences(row: Row, batch?: readonly Row[]): void;
}

/** `batch` is already narrowed: the rows as they would be stored. */
export const memoryUpsertAll = <Row>(
  { entity, rows, write, storeKey, judgeReferences }: MemoryUpsertScope<Row>,
  batch: readonly Row[],
  args: UpsertArgs<Row>,
): readonly Row[] => {
  // The INCOMING rows, judged before any of them is matched: under `onMatch: 'nothing'` a
  // colliding row is skipped and never reaches `write()`, so checking only what lands would
  // let a row naming another tenant through whenever it happened to collide. The caller narrowed
  // them, for the reason its `insertAll` does, and before `conflictKeyOf` reads a target too.
  // Plan first, then rows: the order `postgresRepo` refuses in, so one bad call has one code.
  const { onConflict, onMatch = 'update', overwrites } = args;
  const plan = upsertPlan(entity, batch, onConflict, onMatch, overwrites);
  const keys = conflictKeys(entity, plan, batch);
  for (const row of batch) {
    assertRowTenant(entity.$name, entity.$tenantColumn, 'upsertAll', row);
    entity.$assert(row);
  }
  // The stored rows under the same key, so "does this collide" is the question the unique
  // index answers in Postgres and not a scan per row. A soft-deleted row still occupies its
  // key here, because the index it would collide with there is not partial either — and a row
  // whose target holds a null occupies none, because the index is `NULLS DISTINCT`.
  const stored = new Map<string, Row>();
  for (const row of rows.values()) {
    const key = conflictKeyOf(entity, plan.on, row);
    if (key !== undefined) stored.set(key, row);
  }
  // A row that lands is judged before any of them does: the statement refuses as one. One left
  // alone by `do nothing` wrote nothing, so its reference is checked by nobody on either driver.
  for (const [position, row] of batch.entries()) {
    const key = keys[position];
    const collides = key !== undefined && stored.has(key);
    if (!collides || plan.set.length > 0) judgeReferences(row, batch);
  }
  const written: Row[] = [];
  // A row colliding on ANOTHER unique takes the rows before it with it, as the statement does.
  undoingBatch(args.tx, (tx) => {
    for (const [position, row] of batch.entries()) {
      const key = keys[position];
      const existing = key === undefined ? undefined : stored.get(key);
      // `do nothing` writes no row, and `returning *` therefore names none: a skipped row is
      // absent from the result rather than present and unchanged.
      if (existing !== undefined && plan.set.length === 0) continue;
      // A collision's version moves past the stored one, as an update's does (`advanceVersion`).
      const merged =
        existing === undefined
          ? row
          : advanceVersion(
              entity,
              existing,
              Object.assign(
                {},
                existing,
                Object.fromEntries(plan.set.map((property) => [property, field(row, property)])),
              ),
              (property) => plan.set.includes(property),
            );
      // `UpsertArgs extends RepoOptions`, so the args ARE the options — one bag, and a `tx`
      // passed to an upsert registers its undo exactly as it does for every other write here.
      const result = write(
        merged,
        { tx },
        'upsertAll',
        existing === undefined ? undefined : storeKey(existing),
      );
      // Filed as it lands, so a later row of the same batch collides with an earlier one exactly
      // as it would with a row the request stored a moment before it.
      if (key !== undefined) stored.set(key, result);
      written.push(result);
    }
  });
  return written;
};
