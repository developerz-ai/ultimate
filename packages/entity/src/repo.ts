// The repository seam. Two rules are structural rather than advisory:
//
//  1. `tx` is an explicit parameter on every write, so the transactional outbox can join the
//     request's transaction instead of opening its own and losing atomicity.
//  2. Pagination is cursor-only. OFFSET is wrong under concurrent writes: a row inserted or
//     deleted before the offset shifts every later page, so a client paging through a live
//     table silently skips and repeats rows. A keyset cursor is stable because it names a
//     position in the sort order, not a row count.

import type { AggregateFn } from './aggregate';
import type { Predicate, SortKey } from './tenancy';
import type { IdOf, RowPatch, RowWrite } from './types';

export interface Tx {
  readonly id: string;
  /** Registered by drivers so a failed transaction can undo in-memory effects. */
  onRollback(undo: () => void): void;
}

export interface RepoOptions {
  readonly tx?: Tx;
  /**
   * The tenant, and never the authority for it: inside a request the plan is scoped to the acting
   * actor's org whether this is passed or not, and a value that disagrees with the actor is
   * `X_TENANCY_ACTOR_MISMATCH` rather than the tenant the query runs under. It is still required
   * outside every request context — a script has no actor to derive from.
   */
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

/**
 * `findById`'s options: `RepoOptions`, plus the one knob a point READ has and a write must not.
 *
 * `includeDeleted` lives here and deliberately NOT on `RepoOptions`. It has always been honoured
 * on this path — `idPlan` spreads the options straight into `FindManyArgs`, and both drivers read
 * `args.includeDeleted === true` — but `RepoOptions` never declared it, so the only documented way
 * to read a soft-deleted row by its id did not typecheck. Putting it on `RepoOptions` instead would
 * have offered it to `update(id, patch)` and `delete(id)`, which reach the same `idPlan`: that is
 * the resurrection those two carry `deleted_at is null` to refuse.
 */
export interface FindByIdOptions extends RepoOptions {
  /** Soft-deleted rows are hidden unless the caller asks for them. */
  readonly includeDeleted?: boolean;
}

export interface FindManyArgs extends FindByIdOptions {
  readonly where?: readonly Predicate[];
  readonly orderBy?: readonly SortKey[];
  readonly limit?: number;
  readonly cursor?: string | null;
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
 *
 * The whole-row writes take `RowWrite<T>` and the filtered ones `RowPatch<T>`, which are one
 * statement in two shapes: money's write type is wider than its row type, and every one of these
 * five entry points narrows it — `narrowRow` — before anything reads the row. Taking `T` here made
 * the documented `bigint` minor unit unspellable at the only call an app makes.
 */
export interface Repo<T = unknown> {
  findById(id: IdOf<T>, options?: FindByIdOptions): Promise<T | null>;
  findMany(args?: FindManyArgs): Promise<Page<T>>;
  insert(values: RowWrite<T>, options?: RepoOptions): Promise<T>;
  /**
   * Many rows, one statement — the bulk form a per-row `insert` loop is the N+1 of. Resolves with
   * the rows as stored, defaults included, in the order given; an empty batch writes nothing and
   * resolves with `[]`. Nothing here resolves a collision — `upsertAll` is the call that does.
   * Past Postgres's bind count the batch becomes several statements, so wrap it in
   * `withTransaction` when all-or-nothing matters.
   */
  insertAll(rows: readonly RowWrite<T>[], options?: RepoOptions): Promise<readonly T[]>;
  /**
   * `insertAll` that resolves a collision instead of failing on it. Resolves with the rows this
   * call actually wrote — under `onMatch: 'nothing'` a row already stored is skipped and absent,
   * which is what `returning *` says on the Postgres side.
   */
  upsertAll(rows: readonly RowWrite<T>[], args: UpsertArgs<T>): Promise<readonly T[]>;
  update(id: IdOf<T>, patch: RowPatch<T>, options?: RepoOptions): Promise<T>;
  delete(id: IdOf<T>, options?: RepoOptions): Promise<void>;
  /**
   * Delete by filter, returning how many rows went. The only way to remove a row from an entity
   * with a composite primary key, where `delete(id)` cannot name one. Never `void`: a caller has
   * to be able to tell "nothing matched" from "it worked", and an empty filter is
   * `X_WRITE_UNFILTERED` rather than every row.
   */
  deleteWhere(filter: RowPatch<T>, options?: RepoOptions): Promise<number>;
  /**
   * Update by filter, returning how many rows were written. The `update(id, patch)` a composite
   * primary key cannot express — `participants.lastReadAt` is the reference case. Same two guards
   * as `deleteWhere`, plus `X_PATCH_EMPTY` for a patch that names no columns, and soft-deleted
   * rows are not reachable, exactly as they are not by `update(id, patch)`.
   */
  updateWhere(filter: RowPatch<T>, patch: RowPatch<T>, options?: RepoOptions): Promise<number>;
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
  /**
   * One aggregate over exactly the rows `count(args)` counts. Row-agnostic here and typed on the
   * chain, the same seam `countBy` has: a column name is a runtime string at this contract.
   *
   * `null` for an empty set in every function, which is what SQL answers — a `0` would claim rows
   * were seen. A `sum` or an `avg` comes back as decimal TEXT and a money aggregate as a
   * `MoneyValue`; neither is ever a float.
   */
  aggregate(fn: AggregateFn, column: string, args?: FindManyArgs): Promise<unknown>;
  /**
   * The planner's own row estimate for the table — not a count, and never filtered. `null` when
   * the table has never been analysed, which is a fact and not an estimate.
   */
  approximateCount(args?: FindManyArgs): Promise<number | null>;
}

/**
 * What `memoryRepo()` returns: a `Repo`, plus the one member a database-backed repository has no
 * business having. TEST SEAM — nothing on the framework's own request path calls `reset()`.
 */
export interface MemoryRepo<Row> extends Repo<Row> {
  /**
   * Drops every stored row, in place. In place is the whole point: `database()` resolves each
   * table's repository once, so a test harness that replaced the driver's repositories would be
   * emptying objects the app under test no longer reads.
   */
  reset(): void;
}

export interface Transactor {
  run<R>(work: (tx: Tx) => Promise<R>): Promise<R>;
}
