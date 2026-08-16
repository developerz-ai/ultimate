// The production driver. Same `Repo` contract as `memoryRepo`, same plans, same cursor — the
// only difference is where the rows are, which is the point: a test that passes against memory
// means something about Postgres.
//
// It never takes a connection as an argument. `db()` from `@ultimat3/db` returns the open
// transaction when there is one, so a repository call inside `withTransaction` joins it without
// being told — which is how `ctx.jobs.enqueue()` lands its outbox row atomically with the write
// that caused it. `RepoOptions.tx` is the in-memory driver's undo hook and is ignored here.

import { systemClock } from '@ultimat3/core';
import {
  currentTx,
  type DbClient,
  db,
  type SqlFragment,
  type TransactionOptions,
  withStatementAttribution,
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
import { notFound, repoClientPinned } from './errors';
import { assertedRowsTooMany, hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
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
import { assertRowTenant } from './tenancy';

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
  /**
   * The one place a connection is chosen, which is why the transaction guard is here and not on
   * each method. Unpinned, `db()` answers with the open transaction when there is one — that is
   * how a repository call inside `withTransaction` joins it without being told. Pinned, it cannot:
   * `withTransaction` ran `BEGIN` on a connection IT reserved, and a statement sent straight to
   * `config.client` takes a different connection out of the pool, so the write commits whatever
   * the transaction decides and the read cannot see what the transaction has written. Refused
   * rather than resolved — a `DbTx` does not name the client it was opened on, so this layer
   * cannot even tell whether the two are the same database.
   */
  const client = (): DbClient => {
    const pinned = config.client;
    if (pinned === undefined) return db();
    if (currentTx() !== undefined) throw repoClientPinned(entity.$name);
    return pinned;
  };

  /**
   * Every statement a repository call sends carries the entity and the operation that compiled it,
   * which is what turns "50× `select … where "id" = $1`" into "50× `findById` on `members`" in a
   * diagnostic. This is the last frame that knows both: below it there is only SQL.
   *
   * It wraps the whole call rather than the `client()` handle because the statement is often sent
   * well below — inside the coalescer's microtask flush, inside a chunked write, inside the
   * preload's `readByIds` — and threading a parameter through all of them is the same fact written
   * five times. The scope is an `AsyncLocalStorage` in `@ultimat3/db` (tier 1, downward), so it
   * survives every one of those awaits, and with no observer installed it is not entered at all:
   * one property read and one branch on the production path (axiom 6).
   *
   * `op` is the string the plan builder was already given, named once per method so the operation
   * a refusal reports and the operation a diagnostic reports cannot drift.
   */
  const attributed = <T>(op: string, send: () => Promise<T>): Promise<T> =>
    withStatementAttribution(entity.$name, op, send);

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
   *
   * No `returning`: both callers send this through `execute()` and read a count, so the rows would
   * be a whole tenant's table crossing the wire for nobody — the same cost `updateWhere` used to
   * pay unconditionally, on the sibling path that looked like the one doing it right.
   */
  const removal = (plan: QueryPlan): SqlFragment =>
    entity.$softDelete
      ? updateStatement(
          entity,
          plan,
          new Map([[snake(SOFT_DELETE_COLUMN), systemClock.now()]]),
          shapeOf({}),
          false,
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
    op: string,
    batch: readonly Row[],
    conflict: ConflictTarget | undefined,
  ): Promise<readonly Row[]> => {
    if (batch.length === 0) return [];
    // The whole batch is judged before any statement exists, tenant and invariants together, in
    // the same loop and for the same reason: Postgres refuses one statement as one, so a row this
    // actor may not write must stop the rows beside it too. `memoryRepo`'s `write` runs the same
    // pair — an insert builds no read plan, so this is the only place the tenant is checked.
    for (const row of batch) {
      assertRowTenant(entity.$name, entity.$tenantColumn, op, row);
      entity.$assert(row);
    }
    const columns = insertColumns(entity, namedProperties(entity, batch));
    const bound = batch.map((row) => bindValues(entity, row));
    const shape = { columns, ...(conflict === undefined ? {} : { conflict }) };
    const written: Row[] = [];
    // Attributed here rather than in each of the three callers: a batch wide enough to split is
    // several statements sent inside this loop, and every one of them belongs to the call that
    // asked for it — `insert`, `insertAll` or `upsertAll`, which is why the op is a parameter.
    await attributed(op, () =>
      writing(async () => {
        for (const chunk of insertChunks(bound, columns.length)) {
          for (const row of await client().query<PhysicalRow>(
            insertStatement(entity, chunk, shape),
          )) {
            written.push(decodeRow(entity, row));
          }
        }
      }),
    );
    return written;
  };

  return {
    async findById(id, options) {
      const op = 'findById';
      const plan = idPlan(entity, id, options, op);
      const args = options ?? {};
      // Every point lookup a request issues in one microtask is one statement: a page that
      // resolves an author per row pays for one round trip, not one per row. The statement is the
      // one this call would have sent — same scope, same soft-delete filter, `in` instead of `=` —
      // and with no request in scope (a job, a script) it is exactly that statement, alone.
      //
      // The batch is flushed from a microtask scheduled inside this scope, so the statement one
      // lookup sends for fifty carries the pair every one of those fifty would have carried.
      return attributed(
        op,
        () => coalesceFindById(entity, client(), plan, shapeOf(args), id) ?? one(plan, args),
      );
    },

    async findMany(args = {}) {
      const op = 'findMany';
      const plan = readPlan(entity, args, op);
      // One row past the page: the presence of that row is what says there is a next cursor,
      // and it costs one row instead of a second `count(*)` over the same predicate.
      const found = await attributed(op, () =>
        client().query<PhysicalRow>(
          selectStatement(entity, plan, shapeOf(args, seekFrom(entity, plan)), plan.limit + 1),
        ),
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
      const [written] = await writeRows('insert', [values], undefined);
      // `returning *` is the row Postgres actually stored, defaults included.
      return written ?? values;
    },

    async insertAll(batch) {
      return writeRows('insertAll', batch, undefined);
    },

    async upsertAll(batch, args: UpsertArgs<Row>) {
      const plan = upsertPlan(entity, batch, args.onConflict, args.onMatch ?? 'update');
      // Refused here, not by the server: a batch that repeats a conflict target is `21000` in
      // Postgres and a silent overwrite in memory, and the two drivers have to mean one thing.
      conflictKeys(entity, plan, batch);
      return writeRows('upsertAll', batch, {
        columns: insertColumns(entity, plan.on),
        set: insertColumns(entity, plan.set),
      });
    },

    async update(id, patch, options) {
      const op = 'update';
      const plan = idPlan(entity, id, options, op);
      // The plan bounds WHICH row is written; the patch decides what it becomes, and a patch
      // naming another tenant would hand this row away — a leak out of the actor's tenant that no
      // predicate can refuse.
      assertRowTenant(entity.$name, entity.$tenantColumn, op, patch);
      const values = bindValues(entity, patch);
      // The read an empty patch degrades to is still this call: attributed to `update`, because
      // that is the line an author would go and change.
      if (values.size === 0) {
        const current = await attributed(op, () => one(plan, options ?? {}));
        if (current === null) throw notFound(entity.$name, id);
        return current;
      }
      const written = await attributed(op, () =>
        writing(() =>
          client().one<PhysicalRow>(
            updateStatement(entity, plan, values, shapeOf(options ?? {}), true),
          ),
        ),
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
      const op = 'delete';
      const plan = idPlan(entity, id, options, op);
      if ((await attributed(op, () => writing(() => client().execute(removal(plan))))) === 0) {
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
      const op = 'deleteWhere';
      // The plan is built before the write is announced: a refused filter never happened.
      const plan = deletePlan(entity, filter, options, op);
      return attributed(op, () => writing(() => client().execute(removal(plan))));
    },

    async updateWhere(filter, patch, options) {
      const op = 'updateWhere';
      const plan = updatePlan(entity, filter, patch, options, op);
      // The same move, filtered: one statement can hand away every row it matches.
      assertRowTenant(entity.$name, entity.$tenantColumn, op, patch);
      const values = bindValues(entity, patch);
      // `shapeOf({})` keeps the `deleted_at is null` clause `update(id, patch)` already carries,
      // so a soft-deleted row is not silently patched back into shape.
      const shape = shapeOf({});
      // The rows come back only when something here can still refuse them. A `check` or a `unique`
      // invariant is a constraint Postgres enforced on the statement itself, so the answer is
      // already a count; only a JS-only rule (`kind: 'assert'`, `sql: null`) has to be judged on
      // the result. Unconditional, this was `returning *` on every filtered write in the framework
      // — a GDPR sweep patching twelve million rows streamed all twelve million into the process,
      // decoded each one, asserted nothing about any of them, and answered with a number.
      // `deleteWhere` was the tell: same predicate, same table, `execute()` and a count.
      if (!hasJsOnlyInvariant(entity.$invariants)) {
        const statement = updateStatement(entity, plan, values, shape, false);
        return attributed(op, () => writing(() => client().execute(statement)));
      }
      // Rows ARE needed, so how many is a memory bound rather than a detail — this is the one
      // statement in the driver whose result size is the caller's filter and not a page. Counted
      // BEFORE the write, because a refusal after `returning *` has already allocated the thing it
      // is refusing; the count can drift by whatever a concurrent writer adds between the two,
      // which moves a bound, never a decision.
      const matched = await attributed(op, () =>
        client().one<{ count: unknown }>(countStatement(entity, plan, shape)),
      );
      const rows = Number(matched?.count ?? 0);
      if (rows > MAX_ASSERTED_ROWS) throw assertedRowsTooMany(entity.$name, op, rows);
      const statement = updateStatement(entity, plan, values, shape, true);
      // Inside `withTransaction` a failed assert takes the whole statement with it.
      const written = await attributed(op, () =>
        writing(() => client().query<PhysicalRow>(statement)),
      );
      for (const row of written) entity.$assert(decodeRow(entity, row));
      return written.length;
    },

    async count(args = {}) {
      const op = 'count';
      const plan = readPlan(entity, args, op);
      const row = await attributed(op, () =>
        client().one<{ count: unknown }>(countStatement(entity, plan, shapeOf(args))),
      );
      return Number(row?.count ?? 0);
    },

    async countBy(column, args = {}) {
      const op = 'countBy';
      const grouped = groupColumnOf(entity, column, op);
      const plan = readPlan(entity, args, op);
      // One group past the bound, for the same reason a page reads one row past its limit: the
      // presence of that group is what says the answer was never going to fit, and `countsFrom`
      // refuses it rather than hand back a breakdown missing its tail.
      const rows = await attributed(op, () =>
        client().query<GroupRow>(
          countByStatement(entity, plan, shapeOf(args), column, MAX_GROUPS + 1),
        ),
      );
      return countsFrom(
        entity,
        column,
        op,
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
