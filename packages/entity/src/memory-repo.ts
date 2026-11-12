// Single responsibility: the in-memory driver. Same `Repo` contract as `postgresRepo`, the same
// plans, the same cursor — the only difference is where the rows are, which is the point: a test
// that passes here means something about Postgres.
//
// Split from `repo.ts` when that file passed the 500-line ceiling. What stays there is the
// CONTRACT — `Repo`, `FindManyArgs`, `Transactor` (the page is core's `Page`) — which `postgresRepo`
// implements too and which nothing about storing rows in a `Map` belongs in.

import { pageOf } from '@ultimat3/core';
import { refuseAbandoned } from '@ultimat3/db';
import { appendOnlyRepo } from './append-only';
import { keyOf } from './batch-read';
import { entityNow } from './clock';
import { narrowRow } from './columns';
import { copyColumns } from './copy-plan';
import { cursorFor, kindOf, valueAt } from './cursor';
import { projectRow } from './driver-rows';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { invariantViolated, notFound } from './errors';
import { assertedRowsTooMany, hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
import { lockKeyInput } from './lock-key';
import { memoryAggregates } from './memory-aggregates';
import { undoingBatch } from './memory-batch';
import { memoryJournal } from './memory-journal';
import { memoryLifecycle } from './memory-lifecycle';
import { memoryLocks } from './memory-lock';
import { compareByKind, matchesPredicate } from './memory-match';
import { observedMemoryRepo } from './memory-observed';
import { type MemoryTables, sameTenantJudge } from './memory-same-tenant';
import { afterCursor } from './memory-seek';
import { StoredRows, uniqueIndex, uniqueViolation } from './memory-unique';
import { judgeUpdate, mergedRow } from './memory-update';
import { memoryUpsertAll } from './memory-upsert';
import { assertPageBytes } from './page-bytes';
import { idPlan, readPlan, singleKeyOf } from './plan';
import type { FindManyArgs, MemoryRepo, RepoOptions } from './repo';
import { rowKey } from './row-key';
import { sealedFields } from './sealed';
import { sealedRepo } from './sealed-repo';
import { deletionStamp } from './search-index-version';
import { writtenRowsSink } from './search-written-rows';
import type { QueryPlan } from './tenancy';
import { assertRowTenant } from './tenancy';
import type { RowPatch, RowWrite } from './types';
import { judgeUpdateMany, updateManyPlan } from './update-many';
import { updateWherePlan, writeWherePlan } from './write-where';

const field = (row: unknown, property: string): unknown =>
  typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[property] : undefined;

/**
 * The default driver: correct semantics, no database. `x dev` uses it before the first
 * migration and tests use it everywhere. Postgres is the production driver and implements
 * this same interface.
 */
export const memoryRepo = <Row>(
  entity: EntityCore<Row>,
  seed: readonly Row[] = [],
  /** The driver's other tables, for a same-tenant reference. Alone, this repository sees itself. */
  tables: MemoryTables = new Map(),
): MemoryRepo<Row> => {
  /** A stored row's key — `row-key.ts`, the one spelling both drivers use. */
  const storeKey = (row: unknown): string => rowKey(entity, row);
  /** The same key, from the id a caller named rather than from a row it has in hand. */
  const idStoreKey = (id: unknown, operation: string): string =>
    keyOf(kindOf(entity, singleKeyOf(entity, operation)) ?? '', id);
  // Seed rows are stored as given, and sealing is asynchronous: a seeded sealed entity would hold
  // plaintext every read then refuses to open. Refused here, with the call that seals.
  if (seed.length > 0 && sealedFields(entity).length > 0) {
    throw invariantViolated(
      entity.$name,
      'seed',
      'declares a sealed column, and memoryRepo(entity, seed) stores seed rows unsealed — pass no seed and write them with insertAll(rows)',
    );
  }
  // Every unique key kept as rows move, so a single write is judged by its own keys, never a scan.
  const rows = new StoredRows<Row>(entity);
  for (const row of seed) rows.set(storeKey(row), row);
  tables.set(entity.$name, {
    entity: entity as EntityCore,
    // By the primary key when that is what is asked, which is nearly every reference.
    find: (property, value) => {
      const kind = kindOf(entity, property) ?? '';
      const soleColumn = entity.$primaryKey.length === 1 ? entity.$primaryKey[0] : undefined;
      if (soleColumn === property) return rows.get(keyOf(kind, value));
      for (const row of rows.values()) {
        if (keyOf(kind, field(row, property)) === keyOf(kind, value)) return row;
      }
      return undefined;
    },
    raw: {
      store: (row, undo) => {
        const key = storeKey(row);
        rows.set(key, row as Row);
        undo(() => rows.delete(key));
      },
      replace: (before, after, undo) => {
        const key = storeKey(before);
        rows.set(key, after as Row);
        undo(() => rows.set(key, before as Row));
      },
    },
  });
  /** The trigger half: history and counters, after every stored change (`memory-lifecycle.ts`). */
  const changed = memoryLifecycle(entity as EntityCore, tables);
  const judgeReferences = sameTenantJudge(entity, tables);
  const locks = memoryLocks();
  /** The stamp a soft delete writes: `deletedAt`, and a searchable entity's version advanced. */
  const softDeletion = () =>
    deletionStamp(entity as EntityCore<unknown>, SOFT_DELETE_COLUMN, entityNow());
  /** One guard for every write, as `postgresRepo`'s `writing()`: async, so a refusal rejects. */
  const writing =
    <A extends unknown[], R>(body: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      refuseAbandoned();
      return body(...args);
    };

  /** Whether a soft-deleted row is in the read: hidden unless the caller asked to include it. */
  const visibleTo =
    (args: FindManyArgs) =>
    (row: Row): boolean =>
      !entity.$softDelete ||
      args.includeDeleted === true ||
      field(row, SOFT_DELETE_COLUMN) === null ||
      field(row, SOFT_DELETE_COLUMN) === undefined;
  const matchesPlan = (plan: QueryPlan, row: Row): boolean =>
    plan.where.every((predicate) => matchesPredicate(entity, row, predicate));

  const rowsOf = (plan: QueryPlan, args: FindManyArgs): Row[] => {
    return [...rows.values()]
      .filter((row) => matchesPlan(plan, row))
      .filter(visibleTo(args))
      .sort((left, right) => {
        for (const entry of plan.orderBy) {
          const order = compareByKind(
            kindOf(entity, entry.column),
            valueAt(left, entry.column),
            valueAt(right, entry.column),
          );
          if (order !== 0) return entry.direction === 'desc' ? -order : order;
        }
        return 0;
      });
  };

  const select = (args: FindManyArgs, operation: string): { plan: QueryPlan; found: Row[] } => {
    const plan = readPlan(entity, args, operation);
    return { plan, found: rowsOf(plan, args) };
  };

  /** Money's write shape narrowed once per batch, at the method the caller reached. */
  const narrowed = (batch: readonly RowWrite<Row>[]): readonly Row[] =>
    batch.map((row) => narrowRow<Row>(entity.$columns, row));

  /**
   * `from` is the key the row is stored under NOW, or `undefined` for a new row. A new row may not
   * land on a stored key, and a moved one may not land on another row's — Postgres answers both
   * `X_DB_UNIQUE_VIOLATION` — and a moved row leaves its old key, where this map used to keep it.
   */
  const write = (
    given: RowWrite<Row>,
    options: RepoOptions | undefined,
    operation: string,
    from?: string,
    /** `insertAll` judged every unique key of its batch already, against one index. */
    uniquesJudged = false,
  ): Row => {
    // `MoneyInput` lets a writer hand a `bigint`; a stored row holds the value type. The Postgres
    // driver narrows at the same position — its write methods' entry — so without this an
    // in-memory row would be the one row in the framework `JSON.stringify` refuses.
    const row = narrowRow<Row>(entity.$columns, given);
    // Beside `$assert`, and before the row lands: a write is judged by the tenant it names as well
    // as by the invariants it declares, and the Postgres driver runs the same pair in `writeRows`.
    // `update` reaches here with the STORED row merged under its patch, so a patch that moves a row
    // out of this tenant is refused by the same call that refuses an insert into another one.
    assertRowTenant(entity.$name, entity.$tenantColumn, operation, row);
    entity.$assert(row);
    judgeReferences(row);
    const key = storeKey(row);
    if (key !== from && rows.has(key)) throw uniqueViolation(entity, `${entity.$table}_pkey`);
    const clash = uniquesJudged ? undefined : rows.clash(row, from);
    if (clash !== undefined) throw uniqueViolation(entity, clash);
    const moved = from !== undefined && from !== key ? rows.get(from) : undefined;
    const previous = rows.get(key);
    const prior = from === undefined ? previous : (moved ?? previous);
    (options?.tx ?? memoryJournal())?.onRollback(() => {
      if (previous === undefined) rows.delete(key);
      else rows.set(key, previous);
      if (from !== undefined && moved !== undefined) rows.set(from, moved);
    });
    if (moved !== undefined && from !== undefined) rows.delete(from);
    rows.set(key, row);
    changed(prior, row, options?.tx ?? memoryJournal());
    return row;
  };

  /**
   * The stored rows a filtered write does NOT touch — the ones its results may not collide with.
   * Every stored row counts, not only the visible ones: the unique index in Postgres covers the
   * rows of another tenant and the soft-deleted ones too.
   */
  const untouched = (matched: readonly Row[]): Row[] => {
    const keys = new Set(matched.map((row) => storeKey(row)));
    return [...rows.values()].filter((row) => !keys.has(storeKey(row)));
  };

  // The same guard the read path applies: on a tenant-scoped entity an id alone is not enough
  // to name a row, so `update`/`delete` resolve through a plan rather than through the map.
  const addressed = (id: string, options: RepoOptions | undefined, operation: string): Row => {
    const plan = idPlan(entity, id, options, operation);
    const current = rows.get(idStoreKey(id, operation));
    // A soft-deleted row is hidden from writes too — `delete` on one is `X_NOT_FOUND`, not a
    // second stamp, which is what the Postgres driver's `deleted_at is null` clause already says.
    const hidden =
      current !== undefined &&
      entity.$softDelete &&
      field(current, SOFT_DELETE_COLUMN) !== null &&
      field(current, SOFT_DELETE_COLUMN) !== undefined;
    if (
      current === undefined ||
      hidden ||
      !plan.where.every((predicate) => matchesPredicate(entity, current, predicate))
    ) {
      throw notFound(entity.$name, id);
    }
    return current;
  };

  const assertedBound = (rows: number, operation: string): void => {
    if (rows > MAX_ASSERTED_ROWS) throw assertedRowsTooMany(entity.$name, operation, rows);
  };

  // Every method is async: a repository call that fails must reject, never throw
  // synchronously, or half the call sites would need two error paths. Every write asks
  // `refuseAbandoned()` first, as `postgresRepo`'s `writing()` does (`write-abandon.test.ts`).
  const repo: MemoryRepo<Row> = {
    // Keyed, never a scan: the plan is still built — it is where tenancy is applied and refused —
    // and the one row under the id must pass every predicate in it and be visible, as `rowsOf`
    // would judge it. Filtering and sorting the table cost 6.49 ms at 20k rows.
    async findById(id, options) {
      const args: FindManyArgs = {
        ...options,
        where: [{ column: singleKeyOf(entity, 'findById'), op: 'eq', value: id }],
      };
      const plan = readPlan(entity, args, 'findById');
      const row = rows.get(idStoreKey(id, 'findById'));
      return row !== undefined && visibleTo(args)(row) && matchesPlan(plan, row) ? row : null;
    },

    async findMany(args = {}) {
      const { plan, found } = select(args, 'findMany');
      const start = afterCursor(entity, plan, found);
      const page = found.slice(start, start + plan.limit);
      const last = page.at(-1);
      const more = start + page.length < found.length;
      // Projected as `pg-sql.ts` projects (`driver-rows.ts`): the asked columns, the key and the
      // sort keys — the cursor is minted from the stored row, which holds all of them anyway.
      // The PROJECTED page is weighed, as Postgres weighs the columns it was asked for.
      const projected = page.map((row) => projectRow(entity, plan, row));
      assertPageBytes(
        entity,
        'findMany',
        projected as readonly Readonly<Record<string, unknown>>[],
      );
      return pageOf(
        projected,
        more && last !== undefined ? cursorFor(entity, plan, last, storeKey(last)) : null,
      );
    },

    insert: writing(async (values, options) => {
      return write(values, options, 'insert');
    }),

    insertAll: writing(async (given, options) => {
      // The whole batch is judged before any of it lands: Postgres refuses the statement as one,
      // so a row an invariant rejects — or one naming a tenant this actor may not write — must not
      // leave the rows before it stored here either. `write` re-checks both per row; this loop is
      // what makes the batch all-or-nothing, which is the half a per-row check cannot give.
      //
      // Narrowed FIRST, so what this loop judges is what `write` will store: `$assert` was handed
      // the caller's `bigint` minor unit here and the narrowed `number` one call later.
      const batch = narrowed(given);
      // Layered over the stored rows' index, each batch row's keys added as it is judged: a row
      // collides with what is stored and with the rows before it, never after.
      const taken = uniqueIndex(entity, [], rows);
      const seen = new Set<string>();
      for (const row of batch) {
        assertRowTenant(entity.$name, entity.$tenantColumn, 'insertAll', row);
        entity.$assert(row);
        judgeReferences(row, batch);
        // Keys too, before any row lands: one duplicate refuses the whole statement in Postgres.
        const key = storeKey(row);
        if (seen.has(key) || rows.has(key)) {
          throw uniqueViolation(entity, `${entity.$table}_pkey`);
        }
        seen.add(key);
        const clash = taken.clash(row);
        if (clash !== undefined) throw uniqueViolation(entity, clash);
        taken.add(row);
      }
      return batch.map((row) => write(row, options, 'insertAll', undefined, true));
    }),

    upsertAll: writing(async (given, args) =>
      memoryUpsertAll({ entity, rows, write, storeKey, judgeReferences }, narrowed(given), args),
    ),

    update: writing(async (id, given, options) => {
      // Here and in `pg-driver.ts`, the one door: a value `insert` refuses, a fragment included.
      const patch = entity.$parsePatch(given);
      addressed(id, options, 'update');
      return locks.turn(`row:${idStoreKey(id, 'update')}`, options?.tx, () => {
        const current = addressed(id, options, 'update');
        return write(mergedRow(entity, current, patch), options, 'update', storeKey(current));
      });
    }),

    delete: writing(async (id, options) => {
      addressed(id, options, 'delete');
      return locks.turn(`row:${idStoreKey(id, 'delete')}`, options?.tx, () => {
        const current = addressed(id, options, 'delete');
        // Soft delete hides the row without losing it; the column's presence is the switch.
        // The deleted row, for the search mirror when it asked (`search-written-rows.ts`).
        writtenRowsSink()?.([current]);
        if (entity.$softDelete) {
          write(mergedRow(entity, current, softDeletion()), options, 'delete', storeKey(current));
          return;
        }
        const key = storeKey(current);
        (options?.tx ?? memoryJournal())?.onRollback(() => rows.set(key, current));
        rows.delete(key);
        changed(current, undefined, options?.tx ?? memoryJournal());
      });
    }),

    deleteWhere: writing(async (filter, options) => {
      // `rowsOf` is the read path: the same predicates, the same tenant scoping, and the same
      // soft-delete visibility. A row already stamped is not matched, so a second call cannot
      // move `deletedAt` forward — which is what the Postgres driver's `deleted_at is null`
      // clause says there.
      const doomed = rowsOf(writeWherePlan(entity, filter, options, 'deleteWhere'), {});
      // A soft delete is an update, so an app-only rule judges it: bounded as `updateWhere` is, and
      // one row refused takes the rows before it with it, as the statement does in Postgres.
      if (entity.$softDelete && hasJsOnlyInvariant(entity.$invariants)) {
        assertedBound(doomed.length, 'deleteWhere');
      }
      undoingBatch(options?.tx, (tx) => {
        for (const row of doomed) {
          if (entity.$softDelete) {
            write(mergedRow(entity, row, softDeletion()), { tx }, 'deleteWhere', storeKey(row));
            continue;
          }
          const key = storeKey(row);
          tx.onRollback(() => rows.set(key, row));
          rows.delete(key);
          changed(row, undefined, tx);
        }
      });
      // Past the judged bound the rows are not handed over, as Postgres's `counted` decides.
      if (doomed.length <= MAX_ASSERTED_ROWS) writtenRowsSink()?.(doomed);
      return doomed.length;
    }),

    updateWhere: writing(async (filter, given, options) => {
      const patch = entity.$parsePatch(given);
      const plan = updateWherePlan(entity, filter, patch, options, 'updateWhere');
      // The PATCH, judged whole and before the rows are read — the same call `postgresRepo` makes
      // before its statement exists. Inside the loop below it is judged only where a row was
      // matched, so a patch handing rows to another tenant was refused or accepted depending on
      // what the table happened to hold: `updateWhere(filter, { orgId: theirs })` over a filter
      // matching nothing answered `0` here and threw there, from one call.
      assertRowTenant(entity.$name, entity.$tenantColumn, 'updateWhere', patch);
      // `rowsOf` again, so a soft-deleted row is as unreachable here as it is through
      // `addressed()` — patching a row the app has already deleted is not an update, it is a
      // resurrection nobody asked for. `write` re-asserts the invariants on each result.
      const found = rowsOf(plan, {});
      // The same ceiling `postgresRepo` applies from its own count, and for the same reason: this
      // is the one write whose result size is the caller's FILTER rather than a page, and a rule
      // only the app can judge is what forces every matched row through `$assert`. Without it a
      // sweep of twelve million rows was green here and `X_INVARIANT_VIOLATED` there, from one
      // call — a test proving a call production refuses. Before the loop, so a refusal never
      // writes the rows it declined to judge.
      if (hasJsOnlyInvariant(entity.$invariants)) assertedBound(found.length, 'updateWhere');
      // The WHOLE batch is judged before any row of it lands — the same statement Postgres sends,
      // which refuses as one. A row this batch refuses used to leave the rows before it stored:
      // the write was a loop, and the loop stopped half way through. Postgres rolls that
      // statement back; here nothing was written yet, so nothing has to be undone.
      const merged = judgeUpdate(entity, found, patch, untouched(found), storeKey);
      for (const row of merged) judgeReferences(row);
      const written = merged.map((row, at) =>
        write(row, options, 'updateWhere', storeKey(found[at])),
      );
      if (written.length <= MAX_ASSERTED_ROWS) writtenRowsSink()?.(written);
      return found.length;
    }),

    // Nothing is decoded in memory, so a count is the rows' length: the same judging, one answer.
    insertAllCount: async (given, options) => (await repo.insertAll(given, options)).length,
    upsertAllCount: async (given, args) => (await repo.upsertAll(given, args)).length,
    copyAll: async (given, options) => {
      copyColumns(entity, given as readonly RowPatch<Row>[]);
      return (await repo.insertAll(given, options)).length;
    },

    // `updateWhere`'s path with a patch per row: matched by the read path, judged whole first.
    updateMany: writing(async (given, options) => {
      const plan = updateManyPlan(entity, given, options);
      if (plan.patches.length === 0) return 0;
      // By key, never `rowsOf(plan.match)`: an `in` of n ids over n stored rows is n² comparisons,
      // and 40,000 of each never returned. Each row then passes the scope as a read would judge it.
      const found = plan.patches.flatMap(({ id }) => {
        const row = rows.get(idStoreKey(id, 'updateMany'));
        return row !== undefined && visibleTo({})(row) && matchesPlan(plan.scope, row) ? [row] : [];
      });
      const merged = judgeUpdateMany(entity, plan, found, untouched(found), storeKey);
      for (const row of merged) judgeReferences(row);
      const written = merged.map((row, at) =>
        write(row, options, 'updateMany', storeKey(found[at])),
      );
      if (written.length <= MAX_ASSERTED_ROWS) writtenRowsSink()?.(written);
      return written.length;
    }),

    async count(args = {}) {
      return select(args, 'count').found.length;
    },

    ...memoryAggregates(entity, select),

    // Asked before the wait, so another tenant's id never queues behind that tenant's holder, and
    // again after it, because the row may be gone by then: Postgres re-reads a row it waited for.
    lock: (id, fn, options) =>
      writing(async () => {
        addressed(id, options, 'lock');
        return locks.run(`row:${idStoreKey(id, 'lock')}`, options?.tx, (tx) =>
          fn(addressed(id, options, 'lock'), tx),
        );
      })(),

    lockKey: (key, fn, options) =>
      writing(async () =>
        locks.run(`key:${lockKeyInput(entity, key, options)}`, options?.tx, fn),
      )(),

    reset() {
      rows.clear();
      for (const row of seed) rows.set(storeKey(row), row);
    },
  };
  // The memory driver seals too: it stores what Postgres would, so a test that passes here is not
  // passing over plaintext production never holds. Append-only outermost, in both drivers: a
  // refused rewrite seals nothing and sends nothing, and so reports nothing.
  return appendOnlyRepo<Row, MemoryRepo<Row>>(
    entity,
    sealedRepo<Row, MemoryRepo<Row>>(entity, observedMemoryRepo(entity.$name, repo)),
  );
};

/** Moved beside the lock that needs it, and still answered from here for every existing importer. */
export { memoryTransactor } from './memory-transactor';
