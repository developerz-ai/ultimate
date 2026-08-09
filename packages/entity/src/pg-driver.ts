// The production driver. Same `Repo` contract as `memoryRepo`, same plans, same cursor — the
// only difference is where the rows are, which is the point: a test that passes against memory
// means something about Postgres.
//
// It never takes a connection as an argument. `db()` from `@ultimat3/db` returns the open
// transaction when there is one, so a repository call inside `withTransaction` joins it without
// being told — which is how `ctx.jobs.enqueue()` lands its outbox row atomically with the write
// that caused it. `RepoOptions.tx` is the in-memory driver's undo hook and is ignored here.

import { type DbClient, db, type TransactionOptions, withTransaction } from '@ultimat3/db';
import { snake } from './column';
import { cursorFor, seekFrom, valueAt } from './cursor';
import type { Driver } from './database';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { bindValues, decodeRow, type PhysicalRow } from './pg-row';
import {
  countStatement,
  deleteStatement,
  insertStatement,
  type ReadShape,
  selectStatement,
  updateStatement,
} from './pg-sql';
import { idPlan, readPlan } from './plan';
import type { FindManyArgs, Repo, Transactor } from './repo';
import type { QueryPlan } from './tenancy';

export interface PostgresDriverOptions {
  /**
   * Pin a client. Left out, every call resolves `db()` — the ambient pool, or the open
   * transaction when one is in scope. Tests pass `createRecordingClient()` here or install one
   * globally with `setDbClient()`.
   */
  readonly client?: DbClient | undefined;
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

  return {
    async findById(id, options) {
      const plan = idPlan(entity, id, options, 'findById');
      return one(plan, options ?? {});
    },

    async findMany(args = {}) {
      const plan = readPlan(entity, args, 'findMany');
      // One row past the page: the presence of that row is what says there is a next cursor,
      // and it costs one row instead of a second `count(*)` over the same predicate.
      const found = await client().query<PhysicalRow>(
        selectStatement(entity, plan, shapeOf(args, seekFrom(entity, plan)), plan.limit + 1),
      );
      const rows = found.slice(0, plan.limit).map((row) => decodeRow(entity, row));
      const last = rows.at(-1);
      return {
        rows,
        nextCursor:
          found.length > plan.limit && last !== undefined
            ? cursorFor(plan, last, idOf(last))
            : null,
      };
    },

    async insert(values) {
      entity.$assert(values);
      const written = await client().one<PhysicalRow>(
        insertStatement(entity, bindValues(entity, values)),
      );
      // `returning *` is the row Postgres actually stored, defaults included.
      return written === null ? values : decodeRow(entity, written);
    },

    async update(id, patch, options) {
      const plan = idPlan(entity, id, options, 'update');
      const values = bindValues(entity, patch);
      if (values.size === 0) {
        const current = await one(plan, options ?? {});
        if (current === null) throw notFound(entity.$name, id);
        return current;
      }
      const written = await client().one<PhysicalRow>(
        updateStatement(entity, plan, values, shapeOf(options ?? {})),
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
      // Soft delete hides the row without losing it; the column's presence is the switch.
      const statement = entity.$softDelete
        ? updateStatement(
            entity,
            plan,
            new Map([[snake(SOFT_DELETE_COLUMN), new Date()]]),
            shapeOf({}),
          )
        : deleteStatement(entity, plan);
      if ((await client().execute(statement)) === 0) throw notFound(entity.$name, id);
    },

    async count(args = {}) {
      const plan = readPlan(entity, args, 'count');
      const row = await client().one<{ count: unknown }>(
        countStatement(entity, plan, shapeOf(args)),
      );
      return Number(row?.count ?? 0);
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
