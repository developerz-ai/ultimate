// Single responsibility: `lock`, `lockKey` and `lockKeys` on Postgres. A transaction, through the driver's own
// transactor, so nested in `withTransaction` it is a savepoint and the lock lives to the root COMMIT.
// No wait option: the bound is the role's `statement_timeout`, and a deadlock the server breaks is
// `X_DB_SERIALIZATION_FAILURE` through the funnel like any other statement.

import { type DbClient, join, type SqlFragment, sql, withStatementAttribution } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { notFound } from './errors';
import { lockKeyInput, lockKeysInput } from './lock-key';
import { decodeRow, type PhysicalRow } from './pg-row';
import { selectStatement } from './pg-sql';
import { postgresTransactor } from './pg-transactor';
import { idPlan } from './plan';
import type { Repo } from './repo';

/** The read path's own statement, so tenant and soft delete are its own, `for update` after it. */
const lockedRow = <Row>(entity: EntityCore<Row>, plan: ReturnType<typeof idPlan>): SqlFragment =>
  sql`${selectStatement(entity, plan, { includeDeleted: false }, 1)} for update`;

/** Scoped to the transaction: COMMIT and ROLLBACK release it, and a dropped connection does too. */
const advisoryLock = (input: string): SqlFragment =>
  sql`select pg_advisory_xact_lock(hashtextextended(${input}::text, 0))`;

/**
 * Every input, one round trip, in the order given: a `values` list is scanned in list order and the
 * aggregate consumes its rows in that order, so the locks are taken in `lockKeysInput`'s sorted
 * order — the one global order that keeps two overlapping `lockKeys` calls from deadlocking.
 */
const advisoryLocks = (inputs: readonly string[]): SqlFragment =>
  sql`select count(pg_advisory_xact_lock(hashtextextended(k, 0))) from (values ${join(
    inputs.map((input) => sql`(${input}::text)`),
  )}) as held(k)`;

export const postgresLocks = <Row>(
  entity: EntityCore<Row>,
  pinned: DbClient | undefined,
  client: () => DbClient,
): Required<Pick<Repo<Row>, 'lock' | 'lockKey' | 'lockKeys'>> => ({
  async lock(id, fn, options) {
    const plan = idPlan(entity, id, options, 'lock');
    return postgresTransactor(pinned === undefined ? {} : { client: pinned }).run(async (tx) => {
      const found = await withStatementAttribution(entity.$name, 'lock', () =>
        client().query<PhysicalRow>(lockedRow(entity, plan)),
      );
      const [row] = found;
      if (row === undefined) throw notFound(entity.$name, id);
      return fn(decodeRow(entity, row), tx);
    });
  },

  async lockKey(key, fn, options) {
    const input = lockKeyInput(entity, key, options);
    return postgresTransactor(pinned === undefined ? {} : { client: pinned }).run(async (tx) => {
      await withStatementAttribution(entity.$name, 'lockKey', () =>
        client().query(advisoryLock(input)),
      );
      return fn(tx);
    });
  },

  async lockKeys(keys, fn, options) {
    const inputs = lockKeysInput(entity, keys, options);
    return postgresTransactor(pinned === undefined ? {} : { client: pinned }).run(async (tx) => {
      await withStatementAttribution(entity.$name, 'lockKeys', () =>
        client().query(advisoryLocks(inputs)),
      );
      return fn(tx);
    });
  },
});
