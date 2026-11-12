// Single responsibility: the typed handle's writes past one row — a chain's `updateAll(patch)` and
// `deleteAll()`, `insertAll`/`upsertAll` with or without the rows back, `copyAll` and `updateMany` —
// each forwarded to the repository member that does it, or, for a hand-written repository that
// omits an optional one, to the counterpart every repository has. Split from `query.ts` at its ceiling.

import { overwrittenBy } from './bulk-write';
import { copyColumns } from './copy-plan';
import type { EntityCore } from './entity';
import type { Repo, RepoOptions, UpdateManyRow, UpsertArgs } from './repo';
import { stampedColumns, touch } from './touch';
import type { ColumnMap, Insertable, RowPatch } from './types';
import { updateManyPlan } from './update-many';
import { assertWritableChain, type WriteChain } from './write-where';

/** Asks for a count instead of the rows: no `returning *`, nothing decoded. */
export interface Unreturned {
  readonly returning: false;
}

/** The default, spelled: the rows as stored. `boolean` is neither, so it does not typecheck. */
export interface Returned {
  readonly returning?: true;
}

export interface ChainWrites<Row> {
  /**
   * Every row the chain matches, patched in ONE statement; resolves with how many. The chain's
   * predicates are `updateWhere`'s filter: the same tenancy, soft-delete reach, invariant judging,
   * `onUpdateNow()` stamp, search mirror and `entity.bulk` report. A chain with no predicate is
   * `X_WRITE_UNFILTERED`; `limit()`, `after()` and `search()` are refused — a write has no page.
   */
  updateAll(patch: RowPatch<Row>, options?: RepoOptions): Promise<number>;
  /** Every row the chain matches, removed (or soft-deleted) in one statement; `updateAll`'s guards. */
  deleteAll(options?: RepoOptions): Promise<number>;
}

export const chainWrites = <Source, Row>(
  entity: EntityCore<Source>,
  repo: Repo<Source>,
  chain: WriteChain,
): ChainWrites<Row> => ({
  updateAll: async (patch, options) => {
    assertWritableChain(entity.$name, 'updateAll', chain);
    return repo.updateWhere({}, touch(entity, patch as unknown as RowPatch<Source>), {
      ...options,
      where: chain.where,
    });
  },
  deleteAll: async (options) => {
    assertWritableChain(entity.$name, 'deleteAll', chain);
    return repo.deleteWhere({}, { ...options, where: chain.where });
  },
});

export interface TableBulkWrites<Row, C extends ColumnMap = ColumnMap> {
  /**
   * Many rows, one statement — the bulk write a per-row `insert` loop is the N+1 of, and the line
   * an N+1 warning on a write loop names. Every row is parsed and asserted exactly as `insert`
   * parses one, so declared defaults are filled here and not by the caller. Resolves with the rows
   * as stored, in order; `insertAll([])` writes nothing. A collision is an error — `upsertAll` is
   * the call that tolerates one. `{ returning: false }` resolves with the count instead.
   */
  insertAll(rows: readonly Insertable<C>[], options: RepoOptions & Unreturned): Promise<number>;
  insertAll(
    rows: readonly Insertable<C>[],
    options?: RepoOptions & Returned,
  ): Promise<readonly Row[]>;
  /**
   * `insertAll` that resolves a collision instead of failing on it: `on conflict (…) do update`,
   * or `do nothing` with `onMatch: 'nothing'`. Resolves with the rows this call actually wrote, so
   * a row left alone is absent from the result — which is how a caller counts what it inserted.
   * The conflict target and the primary key are never overwritten: they are how the stored row was
   * found and where it lives. `returning: false` resolves with how many rows it wrote.
   */
  upsertAll(rows: readonly Insertable<C>[], args: UpsertArgs<Row> & Unreturned): Promise<number>;
  upsertAll(
    rows: readonly Insertable<C>[],
    args: UpsertArgs<Row> & Returned,
  ): Promise<readonly Row[]>;
  /**
   * The bulk load: `COPY … FROM STDIN` on Postgres, the rows parsed, sealed, tenant-checked and
   * judged exactly as `insertAll` judges them; resolves with the count. No conflict handling — a
   * duplicate refuses the whole load. In memory and on a custom store it is `insertAll`.
   */
  copyAll(rows: readonly Insertable<C>[], options?: RepoOptions): Promise<number>;
  /**
   * A different patch per row, by id, in one statement per bind-count chunk; resolves with how many
   * rows were written. Every patch names the same columns. An id that is absent, soft-deleted or
   * another tenant's is not written and not counted, as `updateWhere` would not.
   */
  updateMany(rows: readonly UpdateManyRow<Row>[], options?: RepoOptions): Promise<number>;
}

/** `options` without `returning`, which no repository member takes. */
const withoutReturning = <O extends { readonly returning?: boolean }>(
  options: O,
): Omit<O, 'returning'> => {
  const { returning: _returning, ...rest } = options;
  return rest;
};

export const tableBulkWrites = <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
  repo: Repo<Row>,
): TableBulkWrites<Row, C> => {
  const parsed = (rows: readonly Insertable<C>[]): Row[] => rows.map((row) => entity.$parse(row));
  const counted = async (rows: readonly Row[], options: RepoOptions | undefined) =>
    repo.insertAllCount === undefined
      ? (await repo.insertAll(rows, options)).length
      : repo.insertAllCount(rows, options);

  async function insertAll(
    rows: readonly Insertable<C>[],
    options?: RepoOptions & { readonly returning?: boolean },
  ): Promise<number | readonly Row[]> {
    const given = options === undefined ? undefined : withoutReturning(options);
    return options?.returning === false
      ? counted(parsed(rows), given)
      : repo.insertAll(parsed(rows), given);
  }

  // `touch` and not `$parse` alone: an upsert that lands on a stored row IS an update, so an
  // `onUpdateNow()` column has to move exactly as `update(id, patch)` moves it. Asked of the
  // caller's rows BEFORE `$parse` makes every row name every column: otherwise a collision resets
  // each column nobody mentioned to its default.
  async function upsertAll(
    rows: readonly Insertable<C>[],
    args: UpsertArgs<Row> & { readonly returning?: boolean },
  ): Promise<number | readonly Row[]> {
    const plain = withoutReturning(args);
    const overwrites =
      plain.onMatch === 'nothing'
        ? undefined
        : ([
            ...overwrittenBy(entity, rows as readonly RowPatch<Row>[]),
            ...stampedColumns(entity),
          ] as (keyof Row & string)[]);
    const touched = rows.map((row) => touch(entity, entity.$parse(row)));
    const sent = overwrites === undefined ? plain : { ...plain, overwrites };
    if (args.returning !== false) return repo.upsertAll(touched, sent);
    return repo.upsertAllCount === undefined
      ? (await repo.upsertAll(touched, sent)).length
      : repo.upsertAllCount(touched, sent);
  }

  return {
    insertAll: insertAll as TableBulkWrites<Row, C>['insertAll'],
    upsertAll: upsertAll as TableBulkWrites<Row, C>['upsertAll'],
    copyAll: async (rows, options) => {
      const given = parsed(rows);
      if (repo.copyAll !== undefined) return repo.copyAll(given, options);
      // COPY's refusal, kept by the fallback: a load is refused alike whatever the repository.
      copyColumns(entity, given as readonly RowPatch<Row>[]);
      return counted(given, options);
    },
    updateMany: async (rows, options) => {
      const stamped = rows.map(({ id, patch }) => ({ id, patch: touch(entity, patch) }));
      if (repo.updateMany !== undefined) return repo.updateMany(stamped, options);
      // A hand-written repository: the batch judged as every driver judges it (a nullish or
      // repeated id, an uneven column set, an empty patch), then one `updateWhere` per row.
      const plan = updateManyPlan(entity, stamped, options);
      let written = 0;
      for (const { id, patch } of plan.patches) {
        written += await repo.updateWhere({ [plan.key]: id } as RowPatch<Row>, patch, options);
      }
      return written;
    },
  };
};
