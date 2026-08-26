// The chainable read. Every chain terminates in a cursor page — `page()` returns rows plus the
// cursor for the next one, `all()`/`one()` are that page's rows, and `inBatches()` is that page
// repeated until the cursor runs out. There is no `offset()` and there will not be one: under
// concurrent writes an insert before the offset shifts every later page, so a client silently
// skips and repeats rows.

import type { BatchIterator } from './batch';
import { assertBatchable, batchIterator } from './batch';
import { entityNow } from './clock';
import type { EntityCore } from './entity';
import { searchUndeclared } from './feature-errors';
import { assertFinitePageSize, DEFAULT_PAGE_SIZE, namedColumns } from './plan';
import type { RelatedTables } from './preload';
import { preloaded } from './preload';
import type { Relation } from './relations';
import { relationNamed } from './relations';
import type { Page, Repo, RepoOptions, UpsertArgs } from './repo';
import { SEARCH_PROPERTY } from './search';
import type { Operator, Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
import { transitionRow } from './transition';
import type { ColumnMap, IdOf, Insertable, MoneyValue, RowPatch } from './types';

/**
 * What a preloaded relation adds to a row. `unknown` because the name is a string resolved at
 * runtime against the relation map: the row on the other side is parsed by its own entity, never
 * asserted into shape here.
 */
export type Preloaded<Name extends string> = { readonly [K in Name]: unknown };

export interface ReadBuilder<Row> {
  /** Equality on the columns given. `where({ orgId })` is what satisfies the tenancy guard. */
  where(filter: RowPatch<Row>): ReadBuilder<Row>;
  andWhere(column: keyof Row & string, op: Operator, value: unknown): ReadBuilder<Row>;
  /**
   * Full-text search over the entity's generated `tsvector` — every `.searchable()` column at
   * once, one GIN index, one predicate. `posts.where({ orgId }).search(input.q).limit(20).page()`.
   *
   * `term` is USER TEXT and is treated as such end to end: it crosses as a bound parameter and is
   * parsed by `websearch_to_tsquery`, so `&`, `|`, `!`, `:*` and an unbalanced paren are characters
   * to be matched, never operators and never a syntax error. There is deliberately no way to hand
   * this layer a tsquery — a query language inside the query language is a second way to ask, and
   * the one caller that would want it is the injection this method exists to make unreachable.
   *
   * It is an ordinary predicate, so the chain's tenancy, soft delete, projection, order, cursor
   * and page size all mean here exactly what they mean without it. RELEVANCE is not an order this
   * chain can serve: `ts_rank` is a computed value and the cursor carries columns, so the order
   * stays the one the caller declared. An entity with no searchable column is `X_SEARCH_UNDECLARED`
   * and the in-memory driver is `X_SEARCH_IN_MEMORY` — never a different answer from the two.
   */
  search(term: string): ReadBuilder<Row>;
  orderBy(column: keyof Row & string, direction?: SortDirection): ReadBuilder<Row>;
  limit(rows: number): ReadBuilder<Row>;
  /** The cursor from the previous page. */
  after(cursor: string | null): ReadBuilder<Row>;
  select<K extends keyof Row & string>(
    fields: { readonly [P in K]: true },
  ): ReadBuilder<Pick<Row, K>>;
  /**
   * One relation, read for the whole page in one extra `where <key> in (…)` and attached to every
   * row under its own name — the eager form of the batching a point lookup does for itself, and
   * the line an N+1 warning names. The relation is the `references()` already declared, so there
   * is nothing to declare here; a name no foreign key produces is `X_PRELOAD_UNKNOWN_RELATION`,
   * listing the ones that exist.
   *
   * A `belongsTo` attaches the row or `null`, a `hasMany` an array — always present, so "no
   * author" never reads like "nobody preloaded the author". Attached after the projection: a
   * `select()` narrows the columns, never the relations.
   */
  preload<Name extends string>(relation: Name): ReadBuilder<Row & Preloaded<Name>>;
  /**
   * Every row the chain matches, `size` at a time and one statement per batch — the terminal a
   * `for await` consumes instead of holding a whole table in memory. A batch is the page `page()`
   * would have returned at that position, so filters, tenancy, soft delete, the projection and
   * every `preload()` mean here what they mean there, and an empty batch is never yielded.
   *
   * Keyset, never OFFSET: each batch resumes from the cursor the previous one ended on, so a row
   * written mid-iteration cannot make the loop skip or repeat one. `after(cursor)` is where it
   * starts and `.cursor` is where it stopped — persist that and a job resumes the iteration.
   *
   * The loop closes it: `break`, `return` and a throw all stop the next statement, and
   * `await using` does the same for a handle kept in a variable. A chain that cannot carry a
   * cursor and a chain that also called `limit()` are refused here, not one batch later. An
   * ORDINARY nullable sort column is not one of those: it orders `nulls last` ascending and
   * `nulls first` descending, and the cursor carries that position. What is refused is a sort key
   * that leaves the order un-total — an undeclared column, a money property named without its
   * part, or a nullable PRIMARY-KEY column, where `null = null` is unknown and two such rows are
   * one position to the seek (`cursor.ts`'s `assertSeekable`).
   */
  inBatches(size: number): BatchIterator<Row>;
  /** The terminal: one bounded page and the cursor that continues it. */
  page(): Promise<Page<Row>>;
  all(): Promise<readonly Row[]>;
  one(): Promise<Row | null>;
  count(): Promise<number>;
  /**
   * The grouped count: one statement, one entry per distinct value of `column`, keyed by that
   * value — the aggregate a `count()` per row is the N+1 of. `recount every post's likes` is one
   * `likes.andWhere('postId', 'in', ids).countBy('postId')`, not one statement per post.
   *
   * Counts the whole predicate, exactly as `count()` does: the chain's filters, its tenancy and
   * its soft-delete visibility, never its page. A value nothing matched is absent rather than `0`,
   * which is what `group by` returns and what lets a caller tell "none" from "never asked".
   * Entries come back biggest group first, ties by the value, `null` — the group every row without
   * one shares — last.
   *
   * Refused rather than answered: a column whose values a map cannot be keyed by (a timestamp, a
   * jsonb, money), and a chain matching more distinct values than one statement should answer with.
   */
  countBy<K extends keyof Row & string>(column: K): Promise<ReadonlyMap<Row[K], number>>;
  /**
   * The four SQL aggregates, over exactly the rows `count()` counts — the chain's filters, its
   * tenancy and its soft-delete visibility, never its page. "Total spend this month" is
   * `payments.where({ orgId }).andWhere('paidAt', 'gte', from).sum('amount')`, one statement,
   * rather than a page loop or a hand-written query outside every guard this layer applies.
   *
   * **Never a float.** `sum` and `avg` answer decimal TEXT whatever the column was — the sum of a
   * million `integer` rows is not an `integer` and `Number()` on it loses digits past 2^53 — and a
   * money column answers a `MoneyValue` in integer minor units. `min`/`max` answer the row's own
   * type, because the answer is one of the values that went in.
   *
   * `null` for an empty set in every one of them, which is what SQL answers: a `0` would claim
   * rows were seen.
   *
   * Refused rather than answered: a kind with no aggregate the two drivers can agree on (`text`
   * ordering is the database's collation here and JS code-unit order there), `avg` over money
   * (every answer would be a silent rounding of a fraction of a minor unit), and an amount
   * covering more than one currency or scale.
   */
  sum<K extends keyof Row & string>(
    column: K,
  ): Promise<(Row[K] extends MoneyValue | null ? MoneyValue : string) | null>;
  avg<K extends keyof Row & string>(column: K): Promise<string | null>;
  min<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
  max<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
  /**
   * The planner's own row estimate for the table — `reltuples`, one row out of `pg_class`, and the
   * only count that stays constant time as the table grows. `count()` walks every visible row
   * because MVCC gives it no shortcut, so past a few million it is the read that trips a web
   * role's `statement_timeout` and no index can make it cheaper.
   *
   * The whole TABLE, never the chain's filters — a filtered chain is `X_APPROXIMATE_COUNT_FILTERED`
   * rather than an estimate that answers a different question than the one asked. `null` when the
   * table has never been analysed, which is the absence of an estimate and not an estimate of zero.
   */
  approximateCount(): Promise<number | null>;
  /** The plan this chain describes. Safe to log — `describePlan()` elides values. */
  plan(): QueryPlan;
}

export interface Table<Row, C extends ColumnMap = ColumnMap> extends ReadBuilder<Row> {
  /**
   * Move one row through the state machine `column` declares, in ONE statement.
   *
   * `from` is the state the caller believes the row is in, and it rides in the statement's own
   * predicate — so the state that was observed and the state that was written are one decision,
   * made under the row's lock. A read-then-check-then-write is the same call with a window in it,
   * and under two concurrent callers the second one writes a transition out of a state the row had
   * already left. Here the second statement matches no row: `X_STATE_CONFLICT`, naming the state
   * the row is really in.
   *
   * A move the machine does not hold is `X_STATE_TRANSITION_ILLEGAL` and never reaches the
   * database — the table is a property of the declaration. A move out of a TERMINAL state is the
   * same code saying so; a terminal state is one whose outgoing list is empty, which is the whole
   * of the concept and the only part of it the framework owns. Which state is terminal, what any
   * of them mean, who may make a move and what happens on arrival are the app's, every one.
   *
   * Tenant-scoped exactly as `updateWhere` is, because it IS one: a row in another org matches no
   * statement and reads back as absent, so the answer is `X_NOT_FOUND` rather than a conflict that
   * would confirm it exists.
   */
  transition<K extends keyof Row & string>(
    column: K,
    id: IdOf<Row>,
    move: { readonly from: Row[K] & string; readonly to: Row[K] & string },
    options?: RepoOptions,
  ): Promise<Row>;
  insert(values: Insertable<C>, options?: RepoOptions): Promise<Row>;
  /**
   * Many rows, one statement — the bulk write a per-row `insert` loop is the N+1 of, and the line
   * an N+1 warning on a write loop names. Every row is parsed and asserted exactly as `insert`
   * parses one, so declared defaults are filled here and not by the caller. Resolves with the rows
   * as stored, in order; `insertAll([])` writes nothing. A collision is an error — `upsertAll` is
   * the call that tolerates one.
   */
  insertAll(rows: readonly Insertable<C>[], options?: RepoOptions): Promise<readonly Row[]>;
  /**
   * `insertAll` that resolves a collision instead of failing on it: `on conflict (…) do update`,
   * or `do nothing` with `onMatch: 'nothing'`. Resolves with the rows this call actually wrote, so
   * a row left alone is absent from the result — which is how a caller counts what it inserted.
   * The conflict target and the primary key are never overwritten: they are how the stored row was
   * found and where it lives.
   */
  upsertAll(rows: readonly Insertable<C>[], args: UpsertArgs<Row>): Promise<readonly Row[]>;
  /** `IdOf<Row>`: an entity that declared `uuid<PostId>()` is addressed by a `PostId` only. */
  update(id: IdOf<Row>, patch: RowPatch<Row>, options?: RepoOptions): Promise<Row>;
  delete(id: IdOf<Row>, options?: RepoOptions): Promise<void>;
  /**
   * Delete by equality filter; resolves with the number of rows removed. The only way to remove a
   * row from an entity whose primary key is composite — `likes`, `blocks`, a join table — where
   * one id cannot name it. `deleteWhere({})` is `X_WRITE_UNFILTERED`, never every row.
   */
  deleteWhere(filter: RowPatch<Row>, options?: RepoOptions): Promise<number>;
  /**
   * Update by equality filter; resolves with the number of rows written. The `update(id, patch)`
   * a composite primary key cannot express — `participants.updateWhere({ conversationId, userId },
   * { lastReadAt })` is the reference case. Empty filter: `X_WRITE_UNFILTERED`. Empty patch:
   * `X_PATCH_EMPTY`. `onUpdateNow()` columns are stamped exactly as `update(id, patch)` stamps them.
   */
  updateWhere(filter: RowPatch<Row>, patch: RowPatch<Row>, options?: RepoOptions): Promise<number>;
}

interface State {
  readonly where: readonly Predicate[];
  readonly orderBy: readonly SortKey[];
  /**
   * `undefined` until `limit()` is called, and not the default spelled a second time: the driver
   * already defaults an unnamed page to `DEFAULT_PAGE_SIZE`, and only "the caller named a page
   * size" tells `inBatches()` it was handed one number for two jobs.
   */
  readonly limit: number | undefined;
  readonly cursor: string | null;
  readonly select: readonly string[] | undefined;
  /** Resolved when `preload()` was called, so an unknown name fails at the chain and not a page later. */
  readonly preload: readonly Relation[];
}

const EMPTY: State = {
  where: [],
  orderBy: [],
  limit: undefined,
  cursor: null,
  select: undefined,
  preload: [],
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const builder = <Source, Row>(
  entity: EntityCore<Source>,
  repo: Repo<Source>,
  state: State,
  pick: (row: Source) => Row,
  related?: RelatedTables,
): ReadBuilder<Row> => {
  const next = (patch: Partial<State>): ReadBuilder<Row> =>
    builder(entity, repo, { ...state, ...patch }, pick, related);

  /**
   * A projection that drops a key the page is about to be preloaded on would send the statement
   * looking for a column it did not select. The framework asks for what it needs; `pick` still
   * hands the caller only the columns they named.
   */
  const selected: readonly string[] | undefined =
    state.select === undefined
      ? undefined
      : [...new Set([...state.select, ...state.preload.map((relation) => relation.localKey)])];

  const args = () => ({
    where: state.where,
    orderBy: state.orderBy,
    // Sent only when the caller named one: an unnamed page is the driver's default, and passing
    // it from here would be the same number written in two files.
    ...(state.limit === undefined ? {} : { limit: state.limit }),
    cursor: state.cursor,
    ...(selected === undefined ? {} : { select: selected }),
  });

  /** The page the caller gets: projected, then every named relation attached to it by position. */
  const attach = (rows: readonly Source[]): Promise<readonly Row[]> =>
    preloaded(
      { entity, related, relations: state.preload, where: state.where },
      rows,
      rows.map(pick),
    );

  return {
    where: (filter) =>
      next({
        where: [
          ...state.where,
          ...Object.entries(asRecord(filter)).map(
            ([column, value]): Predicate => ({ column, op: 'eq', value }),
          ),
        ],
      }),

    andWhere: (column, op, value) => next({ where: [...state.where, { column, op, value }] }),

    // Refused HERE as well as at the statement, because this is the line the author wrote: a chain
    // over an entity that declares nothing searchable can never produce a match, and the repair is
    // one edit to the schema rather than anything about this call.
    search: (term) => {
      if (entity.$search === null) throw searchUndeclared(entity.$name);
      return next({
        where: [...state.where, { column: SEARCH_PROPERTY, op: 'matches', value: term }],
      });
    },

    orderBy: (column, direction = 'asc') =>
      next({ orderBy: [...state.orderBy, { column, direction }] }),

    // Judged on the chain, like `inBatches(size)` and for the same reason: the number is the
    // author's own text, and a page size that arrived as action input is exactly the one nobody
    // sized. `planFor` applies the identical guard, so a caller reaching the repository directly
    // cannot go round it.
    limit: (rows) => {
      assertFinitePageSize(entity.$name, rows);
      return next({ limit: rows });
    },

    after: (cursor) => next({ cursor }),

    select<K extends keyof Row & string>(fields: { readonly [P in K]: true }) {
      // The predicate is what carries the literal key type through `Object.keys`.
      const keys = Object.keys(fields).filter((key): key is K => Object.hasOwn(fields, key));
      return builder<Source, Pick<Row, K>>(
        entity,
        repo,
        { ...state, select: keys },
        (row) => {
          const source = pick(row);
          const picked = {} as Pick<Row, K>;
          for (const key of keys) picked[key] = source[key];
          return picked;
        },
        related,
      );
    },

    preload<Name extends string>(relation: Name) {
      // Resolved here, so a name no foreign key produces fails on the chain rather than one page
      // later — and naming one relation twice is one statement, not two identical ones.
      const resolved = relationNamed(entity.$name, relation);
      const already = state.preload.some((held) => held.name === resolved.name);
      return builder<Source, Row & Preloaded<Name>>(
        entity,
        repo,
        { ...state, preload: already ? state.preload : [...state.preload, resolved] },
        // The relation is attached after the projection, so `pick` is unchanged and the row type
        // is the only thing that grows — one cast, where a runtime name becomes a static one.
        pick as (row: Source) => Row & Preloaded<Name>,
        related,
      );
    },

    inBatches(size) {
      assertBatchable(entity, size, state);
      return batchIterator<Row>({
        from: state.cursor,
        // The chain's own arguments with the batch as the page size and the iteration's position
        // in place of the chain's: one statement per batch, and the same one `page()` sends.
        page: async (cursor) => {
          const result = await repo.findMany({ ...args(), limit: size, cursor });
          return { rows: await attach(result.rows), nextCursor: result.nextCursor };
        },
      });
    },

    page: async () => {
      const result = await repo.findMany(args());
      return { rows: await attach(result.rows), nextCursor: result.nextCursor };
    },

    all: async () => attach((await repo.findMany(args())).rows),

    one: async () => {
      const { rows } = await repo.findMany({ ...args(), limit: 1 });
      const row = rows[0];
      return row === undefined ? null : ((await attach([row]))[0] ?? null);
    },

    count: () => repo.count(args()),

    // The one cast on each of these, and it is the same seam `countBy` and `select()` have: the
    // driver contract is row-agnostic because a column name is a runtime string there, while the
    // chain knows which property it just named and therefore what comes back.
    sum: async <K extends keyof Row & string>(column: K) =>
      (await repo.aggregate('sum', column, args())) as
        | (Row[K] extends MoneyValue | null ? MoneyValue : string)
        | null,
    avg: async (column: keyof Row & string) =>
      (await repo.aggregate('avg', column, args())) as string | null,
    min: async <K extends keyof Row & string>(column: K) =>
      (await repo.aggregate('min', column, args())) as Row[K] | null,
    max: async <K extends keyof Row & string>(column: K) =>
      (await repo.aggregate('max', column, args())) as Row[K] | null,

    approximateCount: () => repo.approximateCount(args()),

    async countBy<K extends keyof Row & string>(column: K) {
      // The one cast on this terminal, and it is the same seam `select()` has: the driver contract
      // is row-agnostic because a column name is a runtime string there, while the chain knows
      // which property it just named and therefore what the map is keyed by.
      return (await repo.countBy(column, args())) as ReadonlyMap<Row[K], number>;
    },

    plan: (): QueryPlan => ({
      entity: entity.$name,
      where: state.where,
      orderBy: state.orderBy,
      // The page that will actually run, so an unnamed one still reads as the bound it has.
      limit: assertFinitePageSize(entity.$name, state.limit ?? DEFAULT_PAGE_SIZE),
      ...(state.cursor === null ? {} : { cursor: state.cursor }),
      // The projection actually sent, preload keys included: a plan that is safe to log is only
      // useful if it is the plan that ran.
      ...(selected === undefined ? {} : { select: selected }),
    }),
  };
};

/**
 * Columns declared `onUpdateNow()` are written by the framework, never by the caller. One helper,
 * so `update(id, patch)` and `updateWhere(filter, patch)` stamp the same columns at the same
 * moment — a second copy is how one of them ends up with a stale `updatedAt`.
 *
 * A patch that names nothing is returned untouched. Stamping `updatedAt` onto "the caller named no
 * columns" would turn that mistake into a real write on any entity that happens to declare the
 * column, and `X_PATCH_EMPTY` downstream would never see it — so whether the refusal fires would
 * depend on the schema rather than on the call.
 */
const touch = <Row, Patch>(entity: EntityCore<Row>, patch: Patch): Patch => {
  if (namedColumns(patch).length === 0) return patch;
  const stamped: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.onUpdate !== undefined) stamped[property] = entityNow();
  }
  return Object.assign({}, patch, stamped);
};

// Every write is `async`, matching the repository contract: a failing call rejects and never
// throws synchronously. `$parse` throws — without the wrapper, a bad row escapes at call time
// while a bad id rejects, and every call site would need two error paths for one mistake.
export const tableFor = <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
  repo: Repo<Row>,
  /** How this table reaches another — `database()` passes it; a table built by hand has none. */
  related?: RelatedTables,
): Table<Row, C> => ({
  ...builder<Row, Row>(entity, repo, EMPTY, (row) => row, related),
  insert: async (values, options) => repo.insert(entity.$parse(values), options),
  insertAll: async (rows, options) =>
    repo.insertAll(
      rows.map((row) => entity.$parse(row)),
      options,
    ),
  // `touch` and not `$parse` alone: an upsert that lands on a stored row IS an update, so an
  // `onUpdateNow()` column has to move exactly as `update(id, patch)` moves it — and stamping it
  // in a second place is how one of the two ends up writing a stale `updatedAt`.
  upsertAll: async (rows, args) =>
    repo.upsertAll(
      rows.map((row) => touch(entity, entity.$parse(row))),
      args,
    ),
  update: async (id, patch, options) => repo.update(id, touch(entity, patch), options),
  delete: async (id, options) => repo.delete(id, options),
  deleteWhere: async (filter, options) => repo.deleteWhere(filter, options),
  updateWhere: async (filter, patch, options) =>
    repo.updateWhere(filter, touch(entity, patch), options),
  // `touch` is passed rather than applied here: a transition IS an update, so an `onUpdateNow()`
  // column has to move exactly as `update(id, patch)` moves it — which is also the audit of WHEN
  // the row moved, using the stamp already declared instead of a second one beside it.
  transition: async (column, id, move, options) =>
    transitionRow(entity, repo, column, id, move, (patch) => touch(entity, patch), options),
});
