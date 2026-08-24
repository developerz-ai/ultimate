// Single responsibility: the in-memory driver. Same `Repo` contract as `postgresRepo`, the same
// plans, the same cursor — the only difference is where the rows are, which is the point: a test
// that passes here means something about Postgres.
//
// Split from `repo.ts` when that file passed the 500-line ceiling. What stays there is the
// CONTRACT — `Repo`, `Page`, `FindManyArgs`, `Transactor` — which `postgresRepo` implements too
// and which nothing about storing rows in a `Map` belongs in.

import { aggregateColumnOf } from './aggregate';
import { foldAggregate } from './aggregate-fold';
import { keyOf } from './batch-read';
import { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
import { entityNow } from './clock';
import { narrowMoney } from './columns';
import { countsFrom, groupColumnOf } from './count-by';
import { cursorFor, kindOf, seekFrom, valueAt } from './cursor';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { compareByKind, matchesPredicate } from './memory-match';
import { deletePlan, idPlan, readPlan, singleKeyOf, updatePlan } from './plan';
import type { FindManyArgs, MemoryRepo, RepoOptions, Transactor, Tx } from './repo';
import type { QueryPlan } from './tenancy';
import { assertRowTenant } from './tenancy';

const field = (row: unknown, property: string): unknown =>
  typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[property] : undefined;

/** Lexicographic over the sort keys, direction applied. `> 0` means "after the cursor". */
const compareToSeek = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  row: unknown,
  seek: readonly unknown[],
): number => {
  for (const [index, entry] of plan.orderBy.entries()) {
    // The COLUMN's kind, not the value's: the seek was revived from the same kind (`cursor.ts`),
    // so a `bigint` column compares its stored decimal string against a revived `BigInt` as one
    // number instead of as two pieces of text.
    const order = compareByKind(
      kindOf(entity, entry.column),
      valueAt(row, entry.column),
      seek[index],
    );
    if (order !== 0) return entry.direction === 'desc' ? -order : order;
  }
  return 0;
};

/**
 * Where the next page starts. By sort position, not by the previous row's id: that row may have
 * been deleted between the two requests, and an id that is no longer there would restart
 * pagination at the top instead of continuing it.
 */
const afterCursor = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  found: readonly Row[],
): number => {
  const seek = seekFrom(entity, plan);
  if (seek === undefined) return 0;
  const start = found.findIndex((row) => compareToSeek(entity, plan, row, seek) > 0);
  return start === -1 ? found.length : start;
};

/**
 * The default driver: correct semantics, no database. `x dev` uses it before the first
 * migration and tests use it everywhere. Postgres is the production driver and implements
 * this same interface.
 */
export const memoryRepo = <Row>(
  entity: EntityCore<Row>,
  seed: readonly Row[] = [],
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
  const rows = new Map<string, Row>(seed.map((row) => [storeKey(row), row]));

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

  const write = (given: Row, options: RepoOptions | undefined, operation: string): Row => {
    // `MoneyInput` lets a writer hand a `bigint`; a stored row holds the value type. The Postgres
    // driver narrows in `bindValues` and reads its answer back through `returning *`, so without
    // this an in-memory row would be the one row in the framework `JSON.stringify` refuses.
    const row = narrowMoney(entity.$columns, given);
    // Beside `$assert`, and before the row lands: a write is judged by the tenant it names as well
    // as by the invariants it declares, and the Postgres driver runs the same pair in `writeRows`.
    // `update` reaches here with the STORED row merged under its patch, so a patch that moves a row
    // out of this tenant is refused by the same call that refuses an insert into another one.
    assertRowTenant(entity.$name, entity.$tenantColumn, operation, row);
    entity.$assert(row);
    const key = storeKey(row);
    const previous = rows.get(key);
    options?.tx?.onRollback(() => {
      if (previous === undefined) rows.delete(key);
      else rows.set(key, previous);
    });
    rows.set(key, row);
    return row;
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

  // Every method is async: a repository call that fails must reject, never throw
  // synchronously, or half the call sites would need two error paths.
  return {
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
      return {
        rows: page,
        nextCursor:
          more && last !== undefined ? cursorFor(entity, plan, last, storeKey(last)) : null,
      };
    },

    async insert(values, options) {
      return write(values, options, 'insert');
    },

    async insertAll(batch, options) {
      // The whole batch is judged before any of it lands: Postgres refuses the statement as one,
      // so a row an invariant rejects — or one naming a tenant this actor may not write — must not
      // leave the rows before it stored here either. `write` re-checks both per row; this loop is
      // what makes the batch all-or-nothing, which is the half a per-row check cannot give.
      for (const row of batch) {
        assertRowTenant(entity.$name, entity.$tenantColumn, 'insertAll', row);
        entity.$assert(row);
      }
      return batch.map((row) => write(row, options, 'insertAll'));
    },

    async upsertAll(batch, args) {
      // The INCOMING rows, judged before any of them is matched: under `onMatch: 'nothing'` a
      // colliding row is skipped and never reaches `write()`, so checking only what lands would
      // let a row naming another tenant through whenever it happened to collide.
      for (const row of batch) {
        assertRowTenant(entity.$name, entity.$tenantColumn, 'upsertAll', row);
        entity.$assert(row);
      }
      const plan = upsertPlan(entity, batch, args.onConflict, args.onMatch ?? 'update');
      const keys = conflictKeys(entity, plan, batch);
      // The stored rows under the same key, so "does this collide" is the question the unique
      // index answers in Postgres and not a scan per row. A soft-deleted row still occupies its
      // key here, because the index it would collide with there is not partial either — and a row
      // whose target holds a null occupies none, because the index is `NULLS DISTINCT`.
      const stored = new Map<string, Row>();
      for (const row of rows.values()) {
        const key = conflictKeyOf(entity, plan.on, row);
        if (key !== undefined) stored.set(key, row);
      }
      const written: Row[] = [];
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
        const result = write(merged, args, 'upsertAll');
        // Filed as it lands, so a later row of the same batch collides with an earlier one exactly
        // as it would with a row the request stored a moment before it.
        if (key !== undefined) stored.set(key, result);
        written.push(result);
      }
      return written;
    },

    async update(id, patch, options) {
      return write(Object.assign({}, addressed(id, options, 'update'), patch), options, 'update');
    },

    async delete(id, options) {
      const current = addressed(id, options, 'delete');
      // Soft delete hides the row without losing it; the column's presence is the switch.
      if (entity.$softDelete) {
        write(Object.assign({}, current, { [SOFT_DELETE_COLUMN]: entityNow() }), options, 'delete');
        return;
      }
      const key = storeKey(current);
      options?.tx?.onRollback(() => rows.set(key, current));
      rows.delete(key);
    },

    async deleteWhere(filter, options) {
      // `rowsOf` is the read path: the same predicates, the same tenant scoping, and the same
      // soft-delete visibility. A row already stamped is not matched, so a second call cannot
      // move `deletedAt` forward — which is what the Postgres driver's `deleted_at is null`
      // clause says there.
      const doomed = rowsOf(deletePlan(entity, filter, options, 'deleteWhere'), {});
      for (const row of doomed) {
        if (entity.$softDelete) {
          write(
            Object.assign({}, row, { [SOFT_DELETE_COLUMN]: entityNow() }),
            options,
            'deleteWhere',
          );
          continue;
        }
        const key = storeKey(row);
        options?.tx?.onRollback(() => rows.set(key, row));
        rows.delete(key);
      }
      return doomed.length;
    },

    async updateWhere(filter, patch, options) {
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
      for (const row of found) write(Object.assign({}, row, patch), options, 'updateWhere');
      return found.length;
    },

    async count(args = {}) {
      return select(args, 'count').found.length;
    },

    async aggregate(fn, column, args = {}) {
      // Refused before a row is read, and by the same function the Postgres driver calls: a column
      // that has no aggregate is that mistake in both drivers or in neither.
      const declared = aggregateColumnOf(entity, fn, column);
      const { found } = select(args, fn);
      return foldAggregate(entity, fn, column, declared.$meta.kind, found);
    },

    /**
     * Exact here, and that is the honest answer rather than a shortcut: the estimate exists
     * because `count(*)` walks every visible row of a real table, and this driver's rows are
     * already an array whose length is free. Filters are refused in both drivers by `plan.ts`,
     * so the two still answer the same QUESTION.
     */
    async approximateCount(args = {}) {
      return select(args, 'approximateCount').found.length;
    },

    async countBy(column, args = {}) {
      // Refused before a row is read, and by the same function the Postgres driver calls: a column
      // a map cannot be keyed by is that mistake in both drivers or in neither.
      groupColumnOf(entity, column, 'countBy');
      const { found } = select(args, 'countBy');
      const groups = new Map<unknown, number>();
      for (const row of found) {
        // `?? null`, so a property this row never carried lands in the same group Postgres puts a
        // NULL row in — and `0`, `''` and `false` stay the values they are.
        const value = field(row, column) ?? null;
        groups.set(value, (groups.get(value) ?? 0) + 1);
      }
      return countsFrom(entity, column, 'countBy', [...groups]);
    },

    reset() {
      rows.clear();
      for (const row of seed) rows.set(storeKey(row), row);
    },
  };
};

let txCounter = 0;

/** In-memory transactor: undo closures registered by drivers run on failure. */
export const memoryTransactor = (): Transactor => ({
  async run(work) {
    const undos: (() => void)[] = [];
    txCounter += 1;
    const tx: Tx = { id: `tx-${txCounter}`, onRollback: (undo) => undos.push(undo) };
    try {
      return await work(tx);
    } catch (error) {
      for (const undo of undos.reverse()) undo();
      throw error;
    }
  },
});
