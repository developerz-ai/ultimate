// The production driver. Same `Repo` contract as `memoryRepo`, same plans, same cursor — the
// only difference is where the rows are, which is the point: a test that passes against memory
// means something about Postgres.
//
// It takes no connection. `db()` from `@ultimat3/db` returns the open transaction, so a repository
// call inside `withTransaction` joins it unasked, which lands `ctx.jobs.enqueue()`'s outbox row
// with its write. `RepoOptions.tx` is the in-memory driver's undo hook and is ignored here.

import { pageOf } from '@ultimat3/core';
import {
  currentTx,
  type DbClient,
  db,
  refuseAbandoned,
  type SqlFragment,
  sql,
  withStatementAttribution,
} from '@ultimat3/db';
import { appendOnlyRepo } from './append-only';
import { entityNow } from './clock';
import { coalesceFindById } from './coalesce';
import { cursorFor, seekFrom } from './cursor';
import type { Driver } from './database';
import { noteDriverStore } from './driver-registry';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound, repoClientPinned } from './errors';
import { stampHistoryActor } from './history-actor';
import { assertedRowsTooMany, hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
import { forgetPreloaded, tagSiblings } from './jit-preload';
import { judgedWrite } from './judged-write';
import { assertPageBytes } from './page-bytes';
import { postgresAggregates } from './pg-aggregates';
import { postgresBulkWrites } from './pg-bulk-repo';
import { postgresLatestBy } from './pg-latest-by';
import { postgresLocks } from './pg-lock';
import { bindValues, decodeRow, type PhysicalRow, physicalName, sortPrecision } from './pg-row';
import { countStatement, type ReadShape, selectStatement } from './pg-sql';
import { postgresTransactor } from './pg-transactor';
import { deleteStatement, updateStatement } from './pg-write-sql';
import { idPlan, readPlan } from './plan';
import type { FindManyArgs, Repo } from './repo';
import { rowKey } from './row-key';
import { sealedRepo } from './sealed-repo';
import { deletionStamp } from './search-index-version';
import { writtenRowsSink } from './search-written-rows';
import type { QueryPlan } from './tenancy';
import { assertRowTenant } from './tenancy';
import { assertVersionedUpdate, staleOrNotFound, versionOf } from './version-lock';
import { taggedWrite } from './write-tag';
import { updateWherePlan, writeWherePlan } from './write-where';

export interface PostgresDriverOptions {
  /**
   * Pin a client. Left out, every call resolves `db()` — the ambient pool, or the open transaction
   * in scope. Tests pass `recordingClient()` here or install one with `setDbClient()`.
   */
  readonly client?: DbClient | undefined;
  /**
   * Preload foreign keys resolved by a page into a request-scoped cache, so the first `findById`
   * for any of them resolves that key for the whole page in one statement. Default: true.
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
   * each method. Unpinned, `db()` answers with the open transaction when there is one. Pinned, a
   * statement sent straight to `config.client` takes another connection out of that pool — so it
   * goes through the open transaction instead when that transaction was opened ON this client
   * (`tx.origin`): one database, one reservation, and the repository joins it. Any other open
   * transaction is a second database in one scope, and is refused rather than written around.
   */
  const client = (): DbClient => {
    const pinned = config.client;
    if (pinned === undefined) return db();
    const tx = currentTx();
    if (tx === undefined) return pinned;
    if (tx.origin === pinned) return tx;
    throw repoClientPinned(entity.$name);
  };

  /** The statement and its app-side judgement on one connection — see `judged-write.ts`. */
  const judged = <T>(work: (send: DbClient) => Promise<T>): Promise<T> =>
    judgedWrite(entity, client(), config.client, work);

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

  /** The cursor's id — `row-key.ts`, the spelling the memory driver stores a row under. */
  const idOf = (row: Row): string => rowKey(entity, row);

  /**
   * A soft delete's SET list: the stamp, plus a searchable entity's version — advanced past the
   * stored one in the statement (`pg-write-sql.ts`), so a deletion is a newer version too.
   */
  const softDeletion = (): ReadonlyMap<string, unknown> =>
    new Map(
      Object.entries(
        deletionStamp(entity as EntityCore<unknown>, SOFT_DELETE_COLUMN, entityNow()),
      ).map(([property, value]) => [physicalName(entity, property), value]),
    );

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
   * `returning` only when the search mirror asked for the rows, and only up to the judged bound
   * (`counted`): otherwise both callers read a count, and the rows would be a whole tenant's table
   * crossing the wire for nobody.
   */
  /** What a removal matches: the live rows of a soft delete, every row of a hard one. */
  const removalShape = (): ReadShape => shapeOf({ includeDeleted: !entity.$softDelete });

  const removal = (plan: QueryPlan, returning: boolean): SqlFragment =>
    entity.$softDelete
      ? updateStatement(entity, plan, softDeletion(), shapeOf({}), returning)
      : returning
        ? sql`${deleteStatement(entity, plan)} returning *`
        : deleteStatement(entity, plan);

  /**
   * A count, or — when the search mirror asked (`search-written-rows.ts`) — the same statement with
   * `returning *`, its rows handed over and counted. The rows ride only for a searchable entity
   * under an external index, and only when a count says they fit the judged bound: past
   * `MAX_ASSERTED_ROWS` the write stays a count and the mirror logs the rows it could not name. A
   * concurrent writer can drift the count, which moves the bound, never the write.
   */
  const counted = async (
    op: string,
    plan: QueryPlan,
    shape: ReadShape,
    statement: (returning: boolean) => SqlFragment,
  ): Promise<number> => {
    const sink = writtenRowsSink();
    const fits =
      sink !== undefined &&
      Number(
        (
          await attributed(op, () =>
            client().one<{ count: unknown }>(countStatement(entity, plan, shape)),
          )
        )?.count ?? 0,
      ) <= MAX_ASSERTED_ROWS;
    if (sink === undefined || !fits) {
      return attributed(op, () => writing(() => client().execute(statement(false))));
    }
    return attributed(op, () =>
      writing(async () => {
        const rows = await client().query<PhysicalRow>(statement(true));
        sink(rows.map((row) => decodeRow(entity, row)));
        return rows.length;
      }),
    );
  };

  /**
   * Every write goes out through here: the ONE place the request's preloaded rows are dropped (a
   * row this statement changes must not be served afterwards from a page read before it — so
   * before the statement, not after), and where a keyed request's write names itself in the WAL
   * (`write-tag.ts`). The one funnel for an autocommit repository write, so it is also where a scope
   * whose caller was already answered stops: the pool does not refuse, and must not (`runOn`).
   */
  const writing = async <T>(send: () => Promise<T>): Promise<T> => {
    refuseAbandoned();
    forgetPreloaded();
    await stampHistoryActor(entity, config.client !== undefined);
    return taggedWrite(config.client !== undefined, send);
  };

  /**
   * Only an entity with a JS-only rule comes here: rows ARE needed, so how many is a memory bound.
   * Counted BEFORE the write, because a refusal after `returning *` has already allocated what it
   * refuses; a concurrent writer can drift the count, which moves a bound, never a decision.
   */
  const judgedRows = async (
    op: string,
    plan: QueryPlan,
    values: ReadonlyMap<string, unknown>,
    shape: ReadShape,
  ): Promise<number> => {
    const matched = await attributed(op, () =>
      client().one<{ count: unknown }>(countStatement(entity, plan, shape)),
    );
    const rows = Number(matched?.count ?? 0);
    if (rows > MAX_ASSERTED_ROWS) throw assertedRowsTooMany(entity.$name, op, rows);
    const statement = updateStatement(entity, plan, values, shape, true);
    return judged(async (send) => {
      const written = await attributed(op, () => writing(() => send.query<PhysicalRow>(statement)));
      const decoded = written.map((row) => decodeRow(entity, row));
      for (const row of decoded) entity.$assert(row);
      writtenRowsSink()?.(decoded);
      return written.length;
    });
  };

  /**
   * `delete` and `deleteWhere`. A soft delete is an update, so an app-only rule judges the stamped
   * rows, as `memoryRepo`'s `write` does; everything else is one statement and a count.
   */
  const removed = (op: string, plan: QueryPlan): Promise<number> =>
    entity.$softDelete && hasJsOnlyInvariant(entity.$invariants)
      ? judgedRows(op, plan, softDeletion(), shapeOf({}))
      : counted(op, plan, removalShape(), (returning) => removal(plan, returning));

  const repo: Repo<Row> = {
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
      // Weighed raw, before a row is decoded — the PAGE, not the look-ahead row past it, or the
      // `limit(n)` the refusal names would itself be refused.
      const page = found.slice(0, plan.limit);
      assertPageBytes(entity, op, page);
      const rows = page.map((row) => decodeRow(entity, row));
      // What the page leaves behind: its foreign key values, so the first `findById` for any one
      // of them resolves the key for the whole page. A `for … of` loop over these rows costs one
      // statement, not one per row — its `await` already ended the coalescing window.
      if (config.jitPreload !== false) tagSiblings(entity, rows);
      const last = rows.at(-1);
      return pageOf(
        rows,
        found.length > plan.limit && last !== undefined
          ? // Minted from the PHYSICAL row as well as the decoded one: a `timestamptz` decodes
            // to a `Date`, and the microseconds that drops are the difference between a position
            // the `order by` agrees with and one that cuts between two rows.
            cursorFor(
              entity,
              plan,
              last,
              idOf(last),
              sortPrecision(entity, plan.orderBy, page.at(-1)),
            )
          : null,
      );
    },

    ...postgresBulkWrites({
      entity,
      client,
      pinned: config.client,
      attributed,
      writing,
    }),

    async update(id, given, options) {
      // Here and in `memory-repo.ts`, the one door: a value `insert` refuses, a fragment included.
      const patch = entity.$parsePatch(given);
      const op = 'update';
      // A declared version lock: the patch carries the version it read (`version-lock.ts`), and
      // `updateStatement` conditions on it and increments it.
      assertVersionedUpdate(entity, patch);
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
      const statement = updateStatement(entity, plan, values, shapeOf(options ?? {}), true);
      // SQL-expressible invariants are CHECK constraints, so Postgres already rejected the
      // statement. A JS-only one can only be judged on the result — which is why `judged` sends
      // the statement inside a transaction the refusal rolls back.
      return judged(async (send) => {
        const written = await attributed(op, () => writing(() => send.one<PhysicalRow>(statement)));
        if (written === null) {
          // No row matched: absent, another tenant's, or (versioned) moved past the read version.
          if (versionOf(entity) === null) throw notFound(entity.$name, id);
          throw await staleOrNotFound(entity, id, patch, () =>
            attributed(op, () => one(idPlan(entity, id, options, op), options ?? {})),
          );
        }
        const after = decodeRow(entity, written);
        entity.$assert(after);
        return after;
      });
    },

    async delete(id, options) {
      const op = 'delete';
      const plan = idPlan(entity, id, options, op);
      if ((await removed(op, plan)) === 0) {
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
      const plan = writeWherePlan(entity, filter, options, op);
      return removed(op, plan);
    },

    async updateWhere(filter, given, options) {
      const patch = entity.$parsePatch(given);
      const op = 'updateWhere';
      const plan = updateWherePlan(entity, filter, patch, options, op);
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
        return counted(op, plan, shape, (returning) =>
          updateStatement(entity, plan, values, shape, returning),
        );
      }
      return judgedRows(op, plan, values, shape);
    },

    async count(args = {}) {
      const op = 'count';
      const plan = readPlan(entity, args, op);
      const row = await attributed(op, () =>
        client().one<{ count: unknown }>(countStatement(entity, plan, shapeOf(args))),
      );
      return Number(row?.count ?? 0);
    },

    ...postgresAggregates(entity, client),
    ...postgresLatestBy(entity, client),
    ...postgresLocks(entity, config.client, client),
  };
  // The one sealing seam, shared with `memoryRepo()`: sealed on the way in, opened on the way out.
  // Append-only outermost, as there: a refused rewrite seals nothing and sends no statement.
  return appendOnlyRepo(entity, sealedRepo(entity, repo));
};

/**
 * `database(entities, { driver: postgresDriver() })` — the one line that moves an app off the
 * in-memory default. Repos are stateless, so there is nothing to memoise.
 */
export const postgresDriver = (config: PostgresDriverOptions = {}): Driver => {
  // Noted as it is built, so `x verify`'s drift step can tell a Postgres app from one whose store
  // owns its own schema (`driver-registry.ts`). `testDriver()` builds one, so it is noted too.
  noteDriverStore('sql', 'postgres');
  return {
    repo: <Row>(entity: EntityCore<Row>) => postgresRepo(entity, config),
    transactor: () =>
      postgresTransactor(config.client === undefined ? {} : { client: config.client }),
  };
};
