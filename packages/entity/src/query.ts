// The chainable read. Every chain terminates in a cursor page — `page()` returns rows plus the
// cursor for the next one, `all()`/`one()` are that page's rows, and `inBatches()` is that page
// repeated until the cursor runs out. There is no `offset()` and there will not be one: under
// concurrent writes an insert before the offset shifts every later page, so a client silently
// skips and repeats rows.

import { systemClock } from '@ultimat3/core';
import type { BatchIterator } from './batch';
import { assertBatchable, batchIterator } from './batch';
import type { EntityCore } from './entity';
import { assertPageSize, DEFAULT_PAGE_SIZE, namedColumns } from './plan';
import type { RelatedTables } from './preload';
import { preloaded } from './preload';
import type { Relation } from './relations';
import { relationNamed } from './relations';
import type { Page, Repo, RepoOptions, UpsertArgs } from './repo';
import type { Operator, Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
import type { ColumnMap, IdOf, Insertable } from './types';

/**
 * What a preloaded relation adds to a row. `unknown` because the name is a string resolved at
 * runtime against the relation map: the row on the other side is parsed by its own entity, never
 * asserted into shape here.
 */
export type Preloaded<Name extends string> = { readonly [K in Name]: unknown };

export interface ReadBuilder<Row> {
  /** Equality on the columns given. `where({ orgId })` is what satisfies the tenancy guard. */
  where(filter: Partial<Row>): ReadBuilder<Row>;
  andWhere(column: keyof Row & string, op: Operator, value: unknown): ReadBuilder<Row>;
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
   * cursor — a nullable sort column — and a chain that also called `limit()` are refused here,
   * not one batch later.
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
  /** The plan this chain describes. Safe to log — `describePlan()` elides values. */
  plan(): QueryPlan;
}

export interface Table<Row, C extends ColumnMap = ColumnMap> extends ReadBuilder<Row> {
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
  update(id: IdOf<Row>, patch: Partial<Row>, options?: RepoOptions): Promise<Row>;
  delete(id: IdOf<Row>, options?: RepoOptions): Promise<void>;
  /**
   * Delete by equality filter; resolves with the number of rows removed. The only way to remove a
   * row from an entity whose primary key is composite — `likes`, `blocks`, a join table — where
   * one id cannot name it. `deleteWhere({})` is `X_WRITE_UNFILTERED`, never every row.
   */
  deleteWhere(filter: Partial<Row>, options?: RepoOptions): Promise<number>;
  /**
   * Update by equality filter; resolves with the number of rows written. The `update(id, patch)`
   * a composite primary key cannot express — `participants.updateWhere({ conversationId, userId },
   * { lastReadAt })` is the reference case. Empty filter: `X_WRITE_UNFILTERED`. Empty patch:
   * `X_PATCH_EMPTY`. `onUpdateNow()` columns are stamped exactly as `update(id, patch)` stamps them.
   */
  updateWhere(filter: Partial<Row>, patch: Partial<Row>, options?: RepoOptions): Promise<number>;
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

    orderBy: (column, direction = 'asc') =>
      next({ orderBy: [...state.orderBy, { column, direction }] }),

    // Judged on the chain, like `inBatches(size)` and for the same reason: the number is the
    // author's own text, and a page size that arrived as action input is exactly the one nobody
    // sized. `planFor` applies the identical guard, so a caller reaching the repository directly
    // cannot go round it.
    limit: (rows) => {
      assertPageSize(entity.$name, rows);
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
      limit: state.limit ?? DEFAULT_PAGE_SIZE,
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
    if (column.$meta.onUpdate !== undefined) stamped[property] = systemClock.now();
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
});
