// The production driver. Same `Repo` contract as `memoryRepo`, same plans, same cursor — the
// only difference is where the rows are, which is the point: a test that passes against memory
// means something about Postgres.
//
// It never takes a connection as an argument. `db()` from `@ultimat3/db` returns the open
// transaction when there is one, so a repository call inside `withTransaction` joins it without
// being told — which is how `ctx.jobs.enqueue()` lands its outbox row atomically with the write
// that caused it. `RepoOptions.tx` is the in-memory driver's undo hook and is ignored here.

import {
  type DbClient,
  db,
  type SqlFragment,
  type TransactionOptions,
  withTransaction,
} from '@ultimat3/db';
import {
  conflictKeys,
  insertChunks,
  insertColumns,
  namedProperties,
  upsertPlan,
} from './bulk-write';
import { coalesceFindById } from './coalesce';
import { snake } from './column';
import { countsFrom, groupColumnOf, groupValue, MAX_GROUPS } from './count-by';
import { cursorFor, seekFrom, valueAt } from './cursor';
import type { Driver } from './database';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { forgetPreloaded, tagSiblings } from './jit-preload';
import { bindValues, decodeRow, type PhysicalRow } from './pg-row';
import {
  type ConflictTarget,
  countByStatement,
  countStatement,
  deleteStatement,
  type GroupRow,
  insertStatement,
  type ReadShape,
  selectStatement,
  updateStatement,
} from './pg-sql';
import { deletePlan, idPlan, readPlan, updatePlan } from './plan';
import type { FindManyArgs, Repo, Transactor, UpsertArgs } from './repo';
import type { QueryPlan } from './tenancy';

export interface PostgresDriverOptions {
  /**
   * Pin a client. Left out, every call resolves `db()` — the ambient pool, or the open
   * transaction when one is in scope. Tests pass `createRecordingClient()` here or install one
   * globally with `setDbClient()`.
   */
  readonly client?: DbClient | undefined;
  /**
   * Preload foreign keys resolved by a page into a request-scoped cache, so the first
   * `findById` for any one of them resolves that key for the whole page in one statement.
   * Default: true.
   */
  readonly jitPreload?: boolean | undefined;
}

const shapeOf = (args: FindManyArgs, seek?: readonly unknown[]): ReadShape => ({
  includeDeleted: args.includeDeleted === true,
  ...(seek === undefined ? {} : { seek }),
});

export const postgresRepo = <Row>(
  entity: EntityCore<Row>,
  config: PostgresDriverOptions = {},
): Repo<Row> => {
  const client = (): DbClient => config.client ?? db();
  const idOf = (row: Row): string =>
    entity.$primaryKey.map((property) => String(valueAt(row, property))).join('');

  const one = async (plan: QueryPlan, args: FindManyArgs): Promise<Row | null> => {
    const [found] = await client().query<PhysicalRow>(
      selectStatement(entity, plan, shapeOf(args), 1),
    );
    return found === undefined ? null : decodeRow(entity, found);
  };

  /**
   * Hard or soft, decided once so `delete(id)` and `deleteWhere(filter)` cannot drift apart. Soft
   * delete hides the row without losing it; the column's presence is the switch, and `shapeOf({})`
   * keeps the `deleted_at is null` clause so a second call cannot move an existing stamp forward.
   */
  const removal = (plan: QueryPlan): SqlFragment =>
    entity.$softDelete
      ? updateStatement(
          entity,
          plan,
          new Map([[snake(SOFT_DELETE_COLUMN), new Date()]]),
          shapeOf({}),
        )
      : deleteStatement(entity, plan);

  /**
   * Every write goes out through here, which makes it the ONE place the request's preloaded rows
   * are dropped: a row this statement changes must not be served afterwards from a page read
   * before it. Before the statement, not after — a row read back afterwards is the row this write
   * left, and one read concurrently with it was concurrent either way.
   */
  const writing = <T>(send: () => Promise<T>): Promise<T> => {
    forgetPreloaded(entity.$name);
    return send();
  };

  /**
   * The one insert path, for one row or ten thousand: the batch's own column list, split into as
   * many statements as Postgres's bind count allows, and the rows the server stored. `insert(row)`
   * comes through here too, so there is no second builder for the two to drift apart in — and a
   * batch wide enough to split is several statements, which is why an all-or-nothing caller wraps
   * the call in `withTransaction` rather than trusting one statement's atomicity.
   */
  const writeRows = async (
    batch: readonly Row[],
    conflict: ConflictTarget | undefined,
  ): Promise<readonly Row[]> => {
    if (batch.length === 0) return [];
    for (const row of batch) entity.$assert(row);
    const columns = insertColumns(entity, namedProperties(entity, batch));
    const bound = batch.map((row) => bindValues(entity, row));
    const shape = { columns, ...(conflict === undefined ? {} : { conflict }) };
    const written: Row[] = [];
    await writing(async () => {
      for (const chunk of insertChunks(bound, columns.length)) {
        for (const row of await client().query<PhysicalRow>(
          insertStatement(entity, chunk, shape),
        )) {
          written.push(decodeRow(entity, row));
        }
      }
    });
    return written;
  };

  return {
    async findById(id, options) {
      const plan = idPlan(entity, id, options, 'findById');
      const args = options ?? {};
      // Every point lookup a request issues in one microtask is one statement: a page that
      // resolves an author per row pays for one round trip, not one per row. The statement is the
      // one this call would have sent — same scope, same soft-delete filter, `in` instead of `=` —
      // and with no request in scope (a job, a script) it is exactly that statement, alone.
      return coalesceFindById(entity, client(), plan, shapeOf(args), id) ?? one(plan, args);
    },

    async findMany(args = {}) {
      const plan = readPlan(entity, args, 'findMany');
      // One row past the page: the presence of that row is what says there is a next cursor,
      // and it costs one row instead of a second `count(*)` over the same predicate.
      const found = await client().query<PhysicalRow>(
        selectStatement(entity, plan, shapeOf(args, seekFrom(entity, plan)), plan.limit + 1),
      );
      const rows = found.slice(0, plan.limit).map((row) => decodeRow(entity, row));
      // What the page leaves behind: its foreign key values, so the first `findById` for any one
      // of them resolves the key for the whole page. A `for … of` loop over these rows costs one
      // statement, not one per row — its `await` already ended the coalescing window.
      if (config.jitPreload !== false) tagSiblings(entity, rows);
      const last = rows.at(-1);
      return {
        rows,
        nextCursor:
          found.length > plan.limit && last !== undefined
            ? cursorFor(entity, plan, last, idOf(last))
            : null,
      };
    },

    async insert(values) {
      const [written] = await writeRows([values], undefined);
      // `returning *` is the row Postgres actually stored, defaults included.
      return written ?? values;
    },

    async insertAll(batch) {
      return writeRows(batch, undefined);
    },

    async upsertAll(batch, args: UpsertArgs<Row>) {
      const plan = upsertPlan(entity, batch, args.onConflict, args.onMatch ?? 'update');
      // Refused here, not by the server: a batch that repeats a conflict target is `21000` in
      // Postgres and a silent overwrite in memory, and the two drivers have to mean one thing.
      conflictKeys(entity, plan, batch);
      return writeRows(batch, {
        columns: insertColumns(entity, plan.on),
        set: insertColumns(entity, plan.set),
      });
    },

    async update(id, patch, options) {
      const plan = idPlan(entity, id, options, 'update');
      const values = bindValues(entity, patch);
      if (values.size === 0) {
        const current = await one(plan, options ?? {});
        if (current === null) throw notFound(entity.$name, id);
        return current;
      }
      const written = await writing(() =>
        client().one<PhysicalRow>(updateStatement(entity, plan, values, shapeOf(options ?? {}))),
      );
      if (written === null) throw notFound(entity.$name, id);
      const after = decodeRow(entity, written);
      // SQL-expressible invariants are CHECK constraints, so Postgres already rejected the
      // statement. A JS-only one (`kind: 'assert'`, `sql: null`) can only be judged on the
      // result — inside `withTransaction` the throw takes the row with it.
      entity.$assert(after);
      return after;
    },

    async delete(id, options) {
      const plan = idPlan(entity, id, options, 'delete');
      if ((await writing(() => client().execute(removal(plan)))) === 0) {
        throw notFound(entity.$name, id);
      }
    },

    // No `X_NOT_FOUND` here: a filter that matches nothing is a fact the caller asked for, not a
    // failed address. The count is the answer, which is why it is a `number` and not `void`.
    //
    // `deleteWhere`/`updateWhere` are the bulk forms of `delete(id)`/`update(id, patch)` — same
    // role `insertAll`/`upsertAll` play for a per-row insert loop, one statement instead of one
    // per row. They are also the *only* filtered writes a composite-key entity has: `likes`,
    // `blocks`, `participants`, any join table has no single-column id for `delete`/`update` to
    // address, so without this pair such an entity would be create-only.
    async deleteWhere(filter, options) {
      // The plan is built before the write is announced: a refused filter never happened.
      const plan = deletePlan(entity, filter, options, 'deleteWhere');
      return writing(() => client().execute(removal(plan)));
    },

    async updateWhere(filter, patch, options) {
      const plan = updatePlan(entity, filter, patch, options, 'updateWhere');
      // `shapeOf({})` keeps the `deleted_at is null` clause `update(id, patch)` already carries,
      // so a soft-deleted row is not silently patched back into shape.
      const statement = updateStatement(entity, plan, bindValues(entity, patch), shapeOf({}));
      // `query`, not `execute`, for the rows `returning *` already produces: the in-memory driver
      // re-asserts every row it writes, and a JS-only invariant (`kind: 'assert'`, `sql: null`)
      // has no CHECK for Postgres to have enforced. Inside `withTransaction` the throw takes the
      // whole statement with it.
      const written = await writing(() => client().query<PhysicalRow>(statement));
      for (const row of written) entity.$assert(decodeRow(entity, row));
      return written.length;
    },

    async count(args = {}) {
      const plan = readPlan(entity, args, 'count');
      const row = await client().one<{ count: unknown }>(
        countStatement(entity, plan, shapeOf(args)),
      );
      return Number(row?.count ?? 0);
    },

    async countBy(column, args = {}) {
      const grouped = groupColumnOf(entity, column, 'countBy');
      const plan = readPlan(entity, args, 'countBy');
      // One group past the bound, for the same reason a page reads one row past its limit: the
      // presence of that group is what says the answer was never going to fit, and `countsFrom`
      // refuses it rather than hand back a breakdown missing its tail.
      const rows = await client().query<GroupRow>(
        countByStatement(entity, plan, shapeOf(args), column, MAX_GROUPS + 1),
      );
      return countsFrom(
        entity,
        column,
        'countBy',
        rows.map((row) => [groupValue(grouped, row.group_value), Number(row.group_count)] as const),
      );
    },
  };
};

/**
 * `database(entities, { driver: postgresDriver() })` — the one line that moves an app off the
 * in-memory default. Repos are stateless, so there is nothing to memoise.
 */
export const postgresDriver = (config: PostgresDriverOptions = {}): Driver => ({
  repo: <Row>(entity: EntityCore<Row>) => postgresRepo(entity, config),
});

/**
 * A real Postgres transaction behind the same `Transactor` the in-memory one implements. The
 * `Tx` handed to the callback is a token: repositories find the transaction through `db()`, so
 * nothing has to thread a connection through the call stack.
 */
export const postgresTransactor = (options: TransactionOptions = {}): Transactor => ({
  run: (work) =>
    withTransaction(
      (tx) => work({ id: tx.id, onRollback: (undo: () => void) => tx.onRollback(undo) }),
      options,
    ),
});
