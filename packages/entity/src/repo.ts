// The repository seam. Two rules are structural rather than advisory:
//
//  1. `tx` is an explicit parameter on every write, so the transactional outbox can join the
//     request's transaction instead of opening its own and losing atomicity.
//  2. Pagination is cursor-only. OFFSET is wrong under concurrent writes: a row inserted or
//     deleted before the offset shifts every later page, so a client paging through a live
//     table silently skips and repeats rows. A keyset cursor is stable because it names a
//     position in the sort order, not a row count.

import { cursorFor, seekFrom, valueAt } from './cursor';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { idPlan, readPlan, singleKeyOf } from './plan';
import type { Predicate, QueryPlan, SortKey } from './tenancy';

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
 */
export interface Repo<T = unknown> {
  findById(id: string, options?: RepoOptions): Promise<T | null>;
  findMany(args?: FindManyArgs): Promise<Page<T>>;
  insert(values: T, options?: RepoOptions): Promise<T>;
  update(id: string, patch: Partial<T>, options?: RepoOptions): Promise<T>;
  delete(id: string, options?: RepoOptions): Promise<void>;
  count(args?: FindManyArgs): Promise<number>;
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

  const write = (row: Row, options: RepoOptions | undefined): Row => {
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

    async count(args = {}) {
      return select(args, 'count').found.length;
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
