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
import { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
import { entityNow } from './clock';
import { narrowRow } from './columns';
import { cursorFor, kindOf, valueAt } from './cursor';
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
import { uniqueClash, uniqueViolation } from './memory-unique';
import { judgeUpdate, mergedRow } from './memory-update';
import { deletePlan, idPlan, readPlan, singleKeyOf, updatePlan } from './plan';
import type { FindManyArgs, MemoryRepo, RepoOptions } from './repo';
import { sealedFields } from './sealed';
import { sealedRepo } from './sealed-repo';
import type { QueryPlan } from './tenancy';
import { assertRowTenant } from './tenancy';
import type { RowWrite } from './types';

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
  /**
   * A stored row's key, spelled the way `batch-read.ts` spells an id — because Postgres compares a
   * `uuid` as a VALUE and prints it lower-cased, so `findById(UPPER)` reads the row there while
   * `String(...)` missed it here: `null` from a read and `X_NOT_FOUND` from a write, against a row
   * that exists, reachable from a path parameter, a client-supplied id or a legacy import.
   */
  const storeKey = (row: unknown): string =>
    entity.$primaryKey
      .map((property) => keyOf(kindOf(entity, property) ?? '', field(row, property)))
      .join('');
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
  const rows = new Map<string, Row>(seed.map((row) => [storeKey(row), row]));
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
  /** One guard for every write, as `postgresRepo`'s `writing()`: async, so a refusal rejects. */
  const writing =
    <A extends unknown[], R>(body: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      refuseAbandoned();
      return body(...args);
    };

  const rowsOf = (plan: QueryPlan, args: FindManyArgs): Row[] => {
    const visible = (row: Row): boolean =>
      !entity.$softDelete ||
      args.includeDeleted === true ||
      field(row, SOFT_DELETE_COLUMN) === null ||
      field(row, SOFT_DELETE_COLUMN) === undefined;
    return [...rows.values()]
      .filter((row) => plan.where.every((predicate) => matchesPredicate(entity, row, predicate)))
      .filter(visible)
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
   * Lazy: a batch asks this once a row, and an entity with no unique never iterates it. Re-iterable
   * and not a generator: `uniqueClash` walks it once per constraint.
   */
  const storedExcept = (from: string | undefined): Iterable<Row> => ({
    *[Symbol.iterator]() {
      for (const [stored, other] of rows) if (stored !== from) yield other;
    },
  });

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
    const clash = uniqueClash(entity, row, storedExcept(from));
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
    async findById(id, options) {
      const { found } = select(
        { ...options, where: [{ column: singleKeyOf(entity, 'findById'), op: 'eq', value: id }] },
        'findById',
      );
      return found[0] ?? null;
    },

    async findMany(args = {}) {
      const { plan, found } = select(args, 'findMany');
      const start = afterCursor(entity, plan, found);
      const page = found.slice(start, start + plan.limit);
      const last = page.at(-1);
      const more = start + page.length < found.length;
      return pageOf(
        page,
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
      const earlier = (position: number): Iterable<Row> => ({
        *[Symbol.iterator]() {
          yield* rows.values();
          for (let at = 0; at < position; at += 1) yield batch[at] as Row;
        },
      });
      const seen = new Set<string>();
      for (const [position, row] of batch.entries()) {
        assertRowTenant(entity.$name, entity.$tenantColumn, 'insertAll', row);
        entity.$assert(row);
        judgeReferences(row, batch);
        // Keys too, before any row lands: one duplicate refuses the whole statement in Postgres.
        const key = storeKey(row);
        if (seen.has(key) || rows.has(key)) {
          throw uniqueViolation(entity, `${entity.$table}_pkey`);
        }
        seen.add(key);
        const clash = uniqueClash(entity, row, earlier(position));
        if (clash !== undefined) throw uniqueViolation(entity, clash);
      }
      return batch.map((row) => write(row, options, 'insertAll'));
    }),

    upsertAll: writing(async (given, args) => {
      // The INCOMING rows, judged before any of them is matched: under `onMatch: 'nothing'` a
      // colliding row is skipped and never reaches `write()`, so checking only what lands would
      // let a row naming another tenant through whenever it happened to collide. Narrowed first
      // for the reason `insertAll` above is, and before `conflictKeyOf` reads a target too.
      const batch = narrowed(given);
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
          const merged =
            existing === undefined
              ? row
              : Object.assign(
                  {},
                  existing,
                  Object.fromEntries(plan.set.map((property) => [property, field(row, property)])),
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
    }),

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
        if (entity.$softDelete) {
          write(
            Object.assign({}, current, { [SOFT_DELETE_COLUMN]: entityNow() }),
            options,
            'delete',
            storeKey(current),
          );
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
      const doomed = rowsOf(deletePlan(entity, filter, options, 'deleteWhere'), {});
      // A soft delete is an update, so an app-only rule judges it: bounded as `updateWhere` is, and
      // one row refused takes the rows before it with it, as the statement does in Postgres.
      if (entity.$softDelete && hasJsOnlyInvariant(entity.$invariants)) {
        assertedBound(doomed.length, 'deleteWhere');
      }
      undoingBatch(options?.tx, (tx) => {
        for (const row of doomed) {
          if (entity.$softDelete) {
            write(
              Object.assign({}, row, { [SOFT_DELETE_COLUMN]: entityNow() }),
              { tx },
              'deleteWhere',
              storeKey(row),
            );
            continue;
          }
          const key = storeKey(row);
          tx.onRollback(() => rows.set(key, row));
          rows.delete(key);
          changed(row, undefined, tx);
        }
      });
      return doomed.length;
    }),

    updateWhere: writing(async (filter, given, options) => {
      const patch = entity.$parsePatch(given);
      const plan = updatePlan(entity, filter, patch, options, 'updateWhere');
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
      for (const [position, row] of merged.entries()) {
        write(row, options, 'updateWhere', storeKey(found[position]));
      }
      return found.length;
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
