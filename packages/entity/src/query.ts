// The chainable read. Every chain terminates in a cursor page — `page()` returns rows plus the
// cursor for the next one, and `all()`/`one()` are that page's rows. There is no `offset()` and
// there will not be one: under concurrent writes an insert before the offset shifts every later
// page, so a client silently skips and repeats rows.

import type { EntityCore } from './entity';
import { namedColumns } from './plan';
import type { Page, Repo, RepoOptions } from './repo';
import type { Operator, Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
import type { ColumnMap, Insertable } from './types';

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
  /** The terminal: one bounded page and the cursor that continues it. */
  page(): Promise<Page<Row>>;
  all(): Promise<readonly Row[]>;
  one(): Promise<Row | null>;
  count(): Promise<number>;
  /** The plan this chain describes. Safe to log — `describePlan()` elides values. */
  plan(): QueryPlan;
}

export interface Table<Row, C extends ColumnMap = ColumnMap> extends ReadBuilder<Row> {
  insert(values: Insertable<C>, options?: RepoOptions): Promise<Row>;
  update(id: string, patch: Partial<Row>, options?: RepoOptions): Promise<Row>;
  delete(id: string, options?: RepoOptions): Promise<void>;
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
  readonly limit: number;
  readonly cursor: string | null;
  readonly select: readonly string[] | undefined;
}

const EMPTY: State = { where: [], orderBy: [], limit: 50, cursor: null, select: undefined };

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const builder = <Source, Row>(
  entity: EntityCore<Source>,
  repo: Repo<Source>,
  state: State,
  pick: (row: Source) => Row,
): ReadBuilder<Row> => {
  const next = (patch: Partial<State>): ReadBuilder<Row> =>
    builder(entity, repo, { ...state, ...patch }, pick);

  const args = () => ({
    where: state.where,
    orderBy: state.orderBy,
    limit: state.limit,
    cursor: state.cursor,
    ...(state.select === undefined ? {} : { select: state.select }),
  });

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

    limit: (rows) => next({ limit: rows }),

    after: (cursor) => next({ cursor }),

    select<K extends keyof Row & string>(fields: { readonly [P in K]: true }) {
      // The predicate is what carries the literal key type through `Object.keys`.
      const keys = Object.keys(fields).filter((key): key is K => Object.hasOwn(fields, key));
      return builder<Source, Pick<Row, K>>(entity, repo, { ...state, select: keys }, (row) => {
        const source = pick(row);
        const picked = {} as Pick<Row, K>;
        for (const key of keys) picked[key] = source[key];
        return picked;
      });
    },

    page: async () => {
      const result = await repo.findMany(args());
      return { rows: result.rows.map(pick), nextCursor: result.nextCursor };
    },

    all: async () => (await repo.findMany(args())).rows.map(pick),

    one: async () => {
      const { rows } = await repo.findMany({ ...args(), limit: 1 });
      const row = rows[0];
      return row === undefined ? null : pick(row);
    },

    count: () => repo.count(args()),

    plan: (): QueryPlan => ({
      entity: entity.$name,
      where: state.where,
      orderBy: state.orderBy,
      limit: state.limit,
      ...(state.cursor === null ? {} : { cursor: state.cursor }),
      ...(state.select === undefined ? {} : { select: state.select }),
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
const touch = <Row>(entity: EntityCore<Row>, patch: Partial<Row>): Partial<Row> => {
  if (namedColumns(patch).length === 0) return patch;
  const stamped: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.onUpdate !== undefined) stamped[property] = new Date();
  }
  return Object.assign({}, patch, stamped);
};

// Every write is `async`, matching the repository contract: a failing call rejects and never
// throws synchronously. `$parse` throws — without the wrapper, a bad row escapes at call time
// while a bad id rejects, and every call site would need two error paths for one mistake.
export const tableFor = <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
  repo: Repo<Row>,
): Table<Row, C> => ({
  ...builder<Row, Row>(entity, repo, EMPTY, (row) => row),
  insert: async (values, options) => repo.insert(entity.$parse(values), options),
  update: async (id, patch, options) => repo.update(id, touch(entity, patch), options),
  delete: async (id, options) => repo.delete(id, options),
  deleteWhere: async (filter, options) => repo.deleteWhere(filter, options),
  updateWhere: async (filter, patch, options) =>
    repo.updateWhere(filter, touch(entity, patch), options),
});
