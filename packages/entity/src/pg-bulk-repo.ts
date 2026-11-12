// Single responsibility: the Postgres driver's row-batch writes — `insert`, `insertAll`,
// `upsertAll`, their count-only forms, `copyAll` and `updateMany`. Split from `pg-driver.ts` at its
// ceiling. One judging loop for every insert form, so a row refused by one is refused by all of
// them; what differs is only what crosses back (`returning *`, a count, or COPY's row count).

import type { DbClient } from '@ultimat3/db';
import { conflictKeys, insertColumns, statementColumns, upsertPlan } from './bulk-write';
import { countChunks, writeChunks } from './bulk-write-send';
import { narrowRow } from './columns';
import { copyColumns } from './copy-plan';
import type { EntityCore } from './entity';
import { copyRows } from './pg-copy';
import { bindValues } from './pg-row';
import { updateManyStatements } from './pg-update-many-sql';
import type { ConflictTarget } from './pg-write-sql';
import type { Repo, UpsertArgs } from './repo';
import { writtenRowsSink } from './search-written-rows';
import { assertRowTenant } from './tenancy';
import type { RowPatch, RowWrite } from './types';
import { updateManyPlan } from './update-many';
import { sendUpdateMany, updateManyReturns } from './update-many-send';

/** What `postgresRepo` already holds and these writes send through. */
export interface PgWriteContext<Row> {
  readonly entity: EntityCore<Row>;
  /** The connection for this call — the open transaction, the pinned client, or the pool. */
  readonly client: () => DbClient;
  /** The repository's pinned client, where a transaction it needs is opened. */
  readonly pinned: DbClient | undefined;
  readonly attributed: <T>(op: string, send: () => Promise<T>) => Promise<T>;
  /** `pg-driver.ts`'s `writing`: preloads dropped, history actor stamped, the write tagged. */
  readonly writing: <T>(send: () => Promise<T>) => Promise<T>;
}

export type PgBulkWrites<Row> = Required<
  Pick<
    Repo<Row>,
    | 'insert'
    | 'insertAll'
    | 'upsertAll'
    | 'insertAllCount'
    | 'upsertAllCount'
    | 'copyAll'
    | 'updateMany'
  >
>;

export const postgresBulkWrites = <Row>(context: PgWriteContext<Row>): PgBulkWrites<Row> => {
  const { entity, client, pinned, attributed, writing } = context;

  /** Where a batch stops being wide — before `upsertPlan` or a bind reads a row (`narrowRow`). */
  const narrowed = (batch: readonly RowWrite<Row>[]): readonly Row[] =>
    batch.map((row) => narrowRow<Row>(entity.$columns, row));

  /**
   * The whole batch judged before any statement exists, tenant and invariants together, in one
   * loop and for one reason: Postgres refuses a statement as one, so a row this actor may not
   * write must stop the rows beside it too. `memoryRepo`'s `write` runs the same pair — an insert
   * builds no read plan, so this is the only place its tenant is checked. Then bound.
   */
  const judged = (op: string, batch: readonly Row[]): readonly ReadonlyMap<string, unknown>[] => {
    for (const row of batch) {
      assertRowTenant(entity.$name, entity.$tenantColumn, op, row);
      entity.$assert(row);
    }
    return batch.map((row) => bindValues(entity, row));
  };

  /**
   * The one insert path, for one row or ten thousand: the batch's own column list, split into as
   * many statements as Postgres's bind count allows. `insert(row)` comes through here too, so
   * there is no second builder for the two to drift apart in. All or nothing however many
   * statements it takes (`bulk-write-send.ts`). Attributed to the call that asked — the op.
   */
  const writeRows = async (
    op: string,
    batch: readonly Row[],
    conflict: ConflictTarget | undefined,
  ): Promise<readonly Row[]> => {
    if (batch.length === 0) return [];
    const bound = judged(op, batch);
    const shape = { columns: statementColumns(entity, batch), conflict };
    return attributed(op, () => writing(() => writeChunks(entity, bound, shape, client(), pinned)));
  };

  /** `writeRows` with no `returning *`: the same statements, a count back and nothing decoded. */
  const countRows = async (
    op: string,
    batch: readonly Row[],
    conflict: ConflictTarget | undefined,
  ): Promise<number> => {
    if (batch.length === 0) return 0;
    const bound = judged(op, batch);
    const shape = { columns: statementColumns(entity, batch), conflict, returning: false };
    return attributed(op, () => writing(() => countChunks(entity, bound, shape, client(), pinned)));
  };

  /** The conflict target an upsert batch resolves against, refused where the drivers would differ. */
  const upserting = (rows: readonly Row[], args: UpsertArgs<Row>): ConflictTarget => {
    const { onConflict, onMatch = 'update', overwrites } = args;
    const plan = upsertPlan(entity, rows, onConflict, onMatch, overwrites);
    // A batch repeating a conflict target is `21000` in Postgres and a silent overwrite in memory.
    conflictKeys(entity, plan, rows);
    return { columns: insertColumns(entity, plan.on), set: insertColumns(entity, plan.set) };
  };

  return {
    async insert(values) {
      const row = narrowRow<Row>(entity.$columns, values);
      const [written] = await writeRows('insert', [row], undefined);
      // `returning *` is the row Postgres stored, defaults included. The fallback is the NARROWED
      // row: handing the caller's back would answer with a `bigint` minor unit.
      return written ?? row;
    },

    insertAll: async (batch) => writeRows('insertAll', narrowed(batch), undefined),

    async upsertAll(batch, args) {
      const rows = narrowed(batch);
      return writeRows('upsertAll', rows, upserting(rows, args));
    },

    insertAllCount: async (batch) => countRows('insertAll', narrowed(batch), undefined),

    async upsertAllCount(batch, args) {
      const rows = narrowed(batch);
      return countRows('upsertAll', rows, upserting(rows, args));
    },

    /**
     * `COPY … FROM STDIN`: judged as `insertAll` judges, every row naming the same columns because
     * COPY has no per-row `default` (`copy-plan.ts`). A client that cannot stream COPY — PGlite, a
     * transaction wrapper, row security installed — sends the count-only inserts instead.
     */
    async copyAll(batch) {
      const rows = narrowed(batch);
      if (rows.length === 0) return 0;
      const properties = copyColumns(entity, rows as readonly RowPatch<Row>[]);
      const bound = judged('copyAll', rows);
      const columns = insertColumns(entity, properties);
      return attributed('copyAll', () =>
        writing(() => copyRows(entity, bound, columns, client(), pinned)),
      );
    },

    /**
     * One `update … from (values …)` per bind-count chunk. Rows come back only when something
     * still needs them: a JS-only invariant judging them, or the search mirror asking.
     */
    async updateMany(rows, options) {
      const plan = updateManyPlan(entity, rows, options);
      if (plan.patches.length === 0) return 0;
      const sink = writtenRowsSink();
      const returning = updateManyReturns(entity, plan, sink !== undefined);
      const statements = updateManyStatements(entity, plan, returning);
      const { count, rows: written } = await attributed('updateMany', () =>
        writing(() => sendUpdateMany(entity, statements, returning, client(), pinned)),
      );
      if (sink !== undefined && returning) sink(written);
      return count;
    },
  };
};
