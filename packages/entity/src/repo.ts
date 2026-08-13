// The repository seam. Two rules are structural rather than advisory:
//
//  1. `tx` is an explicit parameter on every write, so the transactional outbox can join the
//     request's transaction instead of opening its own and losing atomicity.
//  2. Pagination is cursor-only. OFFSET is wrong under concurrent writes: a row inserted or
//     deleted before the offset shifts every later page, so a client paging through a live
//     table silently skips and repeats rows. A keyset cursor is stable because it names a
//     position in the sort order, not a row count.

import { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
import { narrowMoney } from './columns';
import { countsFrom, groupColumnOf } from './count-by';
import { cursorFor, seekFrom, valueAt } from './cursor';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { deletePlan, idPlan, readPlan, singleKeyOf, updatePlan } from './plan';
import type { Predicate, QueryPlan, SortKey } from './tenancy';
import type { IdOf } from './types';

export interface Tx {
  readonly id: string;
  /** Registered by drivers so a failed transaction can undo in-memory effects. */
  onRollback(undo: () => void): void;
}

export interface RepoOptions {
  readonly tx?: Tx;
  /** Required for tenant-scoped entities; the guard throws without it. */
  readonly orgId?: string;
}

/** What `upsertAll` does with a row that lands on one already stored. */
export interface UpsertArgs<T = unknown> extends RepoOptions {
  /**
   * The unique constraint a collision is judged against, named as entity properties — never a
   * constraint name, which is a migration artefact this layer cannot resolve. At least one column:
   * "any constraint" is not something a caller can reason about.
   */
  readonly onConflict: readonly (keyof T & string)[];
  /**
   * `'update'` (the default) overwrites the stored row with the incoming values, except the
   * conflict target and the primary key. `'nothing'` leaves the stored row exactly as it is and
   * omits it from the result, so the result is always "the rows this call wrote".
   */
  readonly onMatch?: 'update' | 'nothing';
}

export interface FindManyArgs extends RepoOptions {
  readonly where?: readonly Predicate[];
  readonly orderBy?: readonly SortKey[];
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly includeDeleted?: boolean;
  readonly select?: readonly string[];
}

export interface Page<T> {
  readonly rows: readonly T[];
  /** Pass back as `cursor`. `null` means this was the last page. */
  readonly nextCursor: string | null;
}

/**
 * `T` defaults to `unknown` so a row-agnostic consumer (the generated admin, the manifest
 * emitter) can name the shape without knowing the entity.
 *
 * The id parameters are `IdOf<T>`, not `string`: an entity that declared `uuid<PostId>()` is
 * addressed by a `PostId` and by nothing else. `IdOf<unknown>` and `IdOf<{ id: string }>` are
 * both `string`, so a row-agnostic consumer sees the signature it always saw.
 */
export interface Repo<T = unknown> {
  findById(id: IdOf<T>, options?: RepoOptions): Promise<T | null>;
  findMany(args?: FindManyArgs): Promise<Page<T>>;
  insert(values: T, options?: RepoOptions): Promise<T>;
  /**
   * Many rows, one statement — the bulk form a per-row `insert` loop is the N+1 of. Resolves with
   * the rows as stored, defaults included, in the order given; an empty batch writes nothing and
   * resolves with `[]`. Nothing here resolves a collision — `upsertAll` is the call that does.
   * Past Postgres's bind count the batch becomes several statements, so wrap it in
   * `withTransaction` when all-or-nothing matters.
   */
  insertAll(rows: readonly T[], options?: RepoOptions): Promise<readonly T[]>;
  /**
   * `insertAll` that resolves a collision instead of failing on it. Resolves with the rows this
   * call actually wrote — under `onMatch: 'nothing'` a row already stored is skipped and absent,
   * which is what `returning *` says on the Postgres side.
   */
  upsertAll(rows: readonly T[], args: UpsertArgs<T>): Promise<readonly T[]>;
  update(id: IdOf<T>, patch: Partial<T>, options?: RepoOptions): Promise<T>;
  delete(id: IdOf<T>, options?: RepoOptions): Promise<void>;
  /**
   * Delete by filter, returning how many rows went. The only way to remove a row from an entity
   * with a composite primary key, where `delete(id)` cannot name one. Never `void`: a caller has
   * to be able to tell "nothing matched" from "it worked", and an empty filter is
   * `X_WRITE_UNFILTERED` rather than every row.
   */
  deleteWhere(filter: Partial<T>, options?: RepoOptions): Promise<number>;
  /**
   * Update by filter, returning how many rows were written. The `update(id, patch)` a composite
   * primary key cannot express — `participants.lastReadAt` is the reference case. Same two guards
   * as `deleteWhere`, plus `X_PATCH_EMPTY` for a patch that names no columns, and soft-deleted
   * rows are not reachable, exactly as they are not by `update(id, patch)`.
   */
  updateWhere(filter: Partial<T>, patch: Partial<T>, options?: RepoOptions): Promise<number>;
  count(args?: FindManyArgs): Promise<number>;
  /**
   * The grouped count: one statement, one entry per distinct value of `column`, over exactly the
   * rows `count(args)` counts — the aggregate a `count()` per row is the N+1 of. A value nothing
   * matched is absent rather than `0`: the caller knows which keys they asked about, and a map
   * that invents them cannot say which ones the table has never seen.
   *
   * `column` is a property name, spelled as `select` spells one — the typed form is
   * `ReadBuilder.countBy`, which knows the row. Ordered by count, biggest group first.
   */
  countBy(column: string, args?: FindManyArgs): Promise<ReadonlyMap<unknown, number>>;
}

export interface Transactor {
  run<R>(work: (tx: Tx) => Promise<R>): Promise<R>;
}

const field = (row: unknown, property: string): unknown =>
  typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[property] : undefined;

/**
 * `===` on two Dates compares identity, so `where({ publishedAt })` would match nothing here
 * and every row in Postgres. Equality has to mean the same thing in both drivers or the
 * in-memory one stops being a preview of production.
 */
const sameValue = (left: unknown, right: unknown): boolean =>
  left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left === right;

const matches = (row: unknown, predicate: Predicate): boolean => {
  const actual = field(row, predicate.column);
  switch (predicate.op) {
    case 'eq':
      return sameValue(actual, predicate.value);
    case 'neq':
      return !sameValue(actual, predicate.value);
    case 'in':
      return (
        Array.isArray(predicate.value) &&
        predicate.value.some((candidate) => sameValue(candidate, actual))
      );
    case 'gt':
      return compare(actual, predicate.value) > 0;
    case 'gte':
      return compare(actual, predicate.value) >= 0;
    case 'lt':
      return compare(actual, predicate.value) < 0;
    case 'lte':
      return compare(actual, predicate.value) <= 0;
    // Real LIKE semantics, so `'draft%'` means "starts with" here exactly as it does in
    // Postgres. Treating the pattern as a substring would make the two drivers disagree.
    case 'like':
      return likePattern(String(predicate.value)).test(String(actual));
    case 'is-null':
      return actual === null || actual === undefined;
    case 'is-not-null':
      return actual !== null && actual !== undefined;
  }
};

/** `%` and `_` are the wildcards; everything else in the pattern is literal, as in SQL. */
const likePattern = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('%', '.*')
      .replaceAll('_', '.')}$`,
    's',
  );

const compare = (left: unknown, right: unknown): number => {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Lexicographic over the sort keys, direction applied. `> 0` means "after the cursor". */
const compareToSeek = (plan: QueryPlan, row: unknown, seek: readonly unknown[]): number => {
  for (const [index, entry] of plan.orderBy.entries()) {
    const order = compare(valueAt(row, entry.column), seek[index]);
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
  const start = found.findIndex((row) => compareToSeek(plan, row, seek) > 0);
  return start === -1 ? found.length : start;
};

/**
 * The default driver: correct semantics, no database. `x dev` uses it before the first
 * migration and tests use it everywhere. Postgres is the production driver and implements
 * this same interface.
 */
export const memoryRepo = <Row>(entity: EntityCore<Row>, seed: readonly Row[] = []): Repo<Row> => {
  const keyOf = (row: unknown): string =>
    entity.$primaryKey.map((property) => String(field(row, property))).join('');
  const rows = new Map<string, Row>(seed.map((row) => [keyOf(row), row]));

  const rowsOf = (plan: QueryPlan, args: FindManyArgs): Row[] => {
    const visible = (row: Row): boolean =>
      !entity.$softDelete ||
      args.includeDeleted === true ||
      field(row, SOFT_DELETE_COLUMN) === null ||
      field(row, SOFT_DELETE_COLUMN) === undefined;
    return [...rows.values()]
      .filter((row) => plan.where.every((predicate) => matches(row, predicate)))
      .filter(visible)
      .sort((left, right) => {
        for (const entry of plan.orderBy) {
          const order = compare(valueAt(left, entry.column), valueAt(right, entry.column));
          if (order !== 0) return entry.direction === 'desc' ? -order : order;
        }
        return 0;
      });
  };

  const select = (args: FindManyArgs, operation: string): { plan: QueryPlan; found: Row[] } => {
    const plan = readPlan(entity, args, operation);
    return { plan, found: rowsOf(plan, args) };
  };

  const write = (given: Row, options: RepoOptions | undefined): Row => {
    // `MoneyInput` lets a writer hand a `bigint`; a stored row holds the value type. The Postgres
    // driver narrows in `bindValues` and reads its answer back through `returning *`, so without
    // this an in-memory row would be the one row in the framework `JSON.stringify` refuses.
    const row = narrowMoney(entity.$columns, given);
    entity.$assert(row);
    const key = keyOf(row);
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
    const current = rows.get(id);
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
      !plan.where.every((predicate) => matches(current, predicate))
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
        nextCursor: more && last !== undefined ? cursorFor(entity, plan, last, keyOf(last)) : null,
      };
    },

    async insert(values, options) {
      return write(values, options);
    },

    async insertAll(batch, options) {
      // The whole batch is judged before any of it lands: Postgres refuses the statement as one,
      // so a row an invariant rejects must not leave the rows before it stored here either.
      for (const row of batch) entity.$assert(row);
      return batch.map((row) => write(row, options));
    },

    async upsertAll(batch, args) {
      for (const row of batch) entity.$assert(row);
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
        const result = write(merged, args);
        // Filed as it lands, so a later row of the same batch collides with an earlier one exactly
        // as it would with a row the request stored a moment before it.
        if (key !== undefined) stored.set(key, result);
        written.push(result);
      }
      return written;
    },

    async update(id, patch, options) {
      return write(Object.assign({}, addressed(id, options, 'update'), patch), options);
    },

    async delete(id, options) {
      const current = addressed(id, options, 'delete');
      // Soft delete hides the row without losing it; the column's presence is the switch.
      if (entity.$softDelete) {
        write(Object.assign({}, current, { [SOFT_DELETE_COLUMN]: new Date() }), options);
        return;
      }
      const key = keyOf(current);
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
          write(Object.assign({}, row, { [SOFT_DELETE_COLUMN]: new Date() }), options);
          continue;
        }
        const key = keyOf(row);
        options?.tx?.onRollback(() => rows.set(key, row));
        rows.delete(key);
      }
      return doomed.length;
    },

    async updateWhere(filter, patch, options) {
      // `rowsOf` again, so a soft-deleted row is as unreachable here as it is through
      // `addressed()` — patching a row the app has already deleted is not an update, it is a
      // resurrection nobody asked for. `write` re-asserts the invariants on each result.
      const found = rowsOf(updatePlan(entity, filter, patch, options, 'updateWhere'), {});
      for (const row of found) write(Object.assign({}, row, patch), options);
      return found.length;
    },

    async count(args = {}) {
      return select(args, 'count').found.length;
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
