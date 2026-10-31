// Single responsibility: apply ONE migration script and its ledger write — inside a transaction,
// or, for a migration marked `-- transaction: false`, statement by statement outside one. Split
// from `migrate.ts`, which keeps the lock, the ledger audit and the loops over pending migrations;
// `migrate()` and `rollback()` both come through here, so both directions take the same path.

import { logger } from '@ultimat3/core';
import type { DbClient } from './client';
import {
  concurrentIndexTarget,
  firstConcurrentStatement,
  isConcurrentIndexStatement,
  isNonTransactional,
} from './concurrent-index';
import { refuseDependentViews } from './dependent-view';
import { migrationConcurrentInTransaction } from './migration-errors';
import { raw, sql } from './sql';
import { statementsOf } from './statement-split';
import { withTransaction } from './transaction';

export interface MigrationStep {
  readonly id: string;
  /** The migration's `up` — where the marker lives, whichever direction runs. */
  readonly up: string;
  /** What runs: `up` forwards, `down` on a rollback. */
  readonly script: string;
  /** `SET LOCAL lock_timeout` — every transaction, and no concurrent statement. `0` sets none. */
  readonly lockTimeoutMs: number;
  /** The ledger write, on the client the statements ran on — after the last of them succeeded. */
  readonly record: (client: DbClient) => Promise<void>;
}

/**
 * A migration's `up` and `down` are **scripts**, and one send is one statement — because the two
 * drivers disagree about anything else. PGlite's `query()` is the extended protocol always and
 * answers `cannot insert multiple commands into a prepared statement`; `Bun.SQL.unsafe` degrades
 * to the simple protocol when no value is bound and applies the same script, which is a fact about
 * bun 1.3.14 and not a contract. An empty script sends nothing at all, which is how a no-op
 * migration reaches its ledger row.
 */
async function applyScript(tx: DbClient, script: string): Promise<void> {
  for (const statement of statementsOf(script)) await tx.execute(raw(statement));
}

/**
 * Bound how long this migration will queue behind a lock it cannot take.
 *
 * `alter table … add column` needs `ACCESS EXCLUSIVE`. A long `SELECT` holding `ACCESS SHARE`
 * makes it wait — and because Postgres' lock queue is FIFO, **every subsequent query on that table
 * queues behind the ALTER**. The `migrate` profile runs `statement_timeout = 0` deliberately, so
 * without this the migrator waits forever and the app is down on one table for as long as the
 * reporting query runs. `lock_timeout` bounds the *wait* alone and never the work.
 *
 * `SET LOCAL`, inside the migration's own transaction: it reverts at COMMIT, so a value chosen for
 * DDL never leaks onto the session the next migration runs on. The failure it produces is `55P03`,
 * typed as `X_DB_LOCK_TIMEOUT` by `driverError` with the `pg_stat_activity` read as its fix.
 */
async function setLockTimeout(tx: DbClient, lockTimeoutMs: number): Promise<void> {
  if (lockTimeoutMs <= 0) return;
  // `SET LOCAL` takes no parameter placeholder, and the value is a validated integer of ours.
  await tx.execute(raw(`SET LOCAL lock_timeout = ${Math.round(lockTimeoutMs)}`));
}

/**
 * An interrupted `create index concurrently` leaves the index behind marked INVALID: never used by
 * the planner, still maintained on every write, and — the part that bites — still holding the
 * name, so `if not exists` would skip the rebuild and record the step as done. So before each
 * named concurrent build: an INVALID index under that name is dropped (concurrently) first.
 *
 * `to_regclass` resolves the name exactly as the statement will — quoting and `search_path`
 * included — and answers `null` for a missing one. The name is the statement's own text, which
 * this runner is about to send anyway, so the drop adds no surface the build did not have.
 */
async function dropInvalidLeftover(session: DbClient, statement: string): Promise<void> {
  const name = concurrentIndexTarget(statement);
  if (name === null) return;
  const row = await session.one<{ valid: boolean }>(
    sql`select i.indisvalid as valid from pg_index i where i.indexrelid = to_regclass(${name})`,
  );
  if (row === null || row.valid) return;
  logger.warn('ultimate migrate dropping an invalid index left by an interrupted build', {
    index: name,
    cause: `index ${name} is INVALID — a concurrent build of it failed or was interrupted`,
    fix: 'x db migrate --json   # already running: the leftover is dropped and built again',
  });
  await session.execute(raw(`drop index concurrently if exists ${name}`));
}

/**
 * Outside a transaction, one statement at a time. A concurrent index statement runs bare, with no
 * `lock_timeout`: the concurrent forms take SHARE UPDATE EXCLUSIVE, which queues no read and no
 * write, and the long waits they do make — for every transaction older than the build — are lock
 * waits too, so the 3 s bound would turn a slow-but-harmless build into an INVALID index.
 *
 * Every other statement — the `alter table … drop constraint` a UNIQUE removal needs, a hand-written
 * `drop table` — can queue the table, so it gets a transaction of its own under the same
 * `SET LOCAL lock_timeout` a transactional migration runs with. Only what Postgres refuses inside a
 * transaction (`vacuum`, `create database`, …: `AUTOCOMMIT_ONLY`) runs autocommitted.
 *
 * The step must be idempotent, since a failure leaves what already ran in place and no ledger
 * row: `x db gen` writes only `if not exists` / `if exists` forms here.
 */
/**
 * The statements Postgres refuses inside a transaction block (25001): they run autocommitted. Every
 * other statement under the marker — an `alter table`, a `drop table`, any DDL that can queue the
 * table behind a long reader — runs in a short transaction under the migration's `lock_timeout`.
 */
const AUTOCOMMIT_ONLY =
  /^\s*(?:vacuum|cluster\b(?!\s+\w+\s+using)|create\s+database|drop\s+database|alter\s+system|create\s+tablespace|drop\s+tablespace|reindex\s+(?:\(.*\)\s*)?(?:system|database)\b|create\s+subscription|drop\s+subscription|alter\s+subscription)\b/i;

/** A statement's text past its leading `--` lines (the step's own marker rides the first one). */
const withoutLeadingComments = (statement: string): string =>
  statement.replace(/^(?:\s*--[^\n]*(?:\n|$))+/, '');

async function applyOutsideTransaction(session: DbClient, step: MigrationStep): Promise<void> {
  await refuseDependentViews(session, step.script);
  for (const statement of statementsOf(step.script)) {
    if (isConcurrentIndexStatement(statement)) {
      await dropInvalidLeftover(session, statement);
      await session.execute(raw(statement));
      continue;
    }
    // Postgres refuses these inside a transaction (25001): autocommitted, as the marker promises.
    if (AUTOCOMMIT_ONLY.test(withoutLeadingComments(statement))) {
      await session.execute(raw(statement));
      continue;
    }
    await withTransaction(
      async (tx) => {
        await setLockTimeout(tx, step.lockTimeoutMs);
        await tx.execute(raw(statement));
      },
      { client: session },
    );
  }
  await step.record(session);
}

/** Apply one migration script and record it, on the migrator's own pinned session. */
export async function applyMigrationStep(session: DbClient, step: MigrationStep): Promise<void> {
  if (isNonTransactional(step.up)) return applyOutsideTransaction(session, step);
  // Before `BEGIN`, never after the failure: inside the transaction Postgres' 25001 names neither
  // the migration nor the marker that fixes it.
  const refused = firstConcurrentStatement(step.script);
  if (refused !== undefined) {
    throw migrationConcurrentInTransaction(step.id, refused);
  }
  await withTransaction(
    async (tx) => {
      await setLockTimeout(tx, step.lockTimeoutMs);
      // Before the first statement, never after the failure: a view compiled against a column
      // this script retypes is `0A000` from the server with the view named only in a DETAIL field
      // nothing prints (`dependent-view.ts`).
      await refuseDependentViews(tx, step.script);
      await applyScript(tx, step.script);
      await step.record(tx);
    },
    // The lock's own session: a migration applied on another connection is not covered by the
    // lock at all, and on `ROLE=migrate` there is no other connection to apply it on.
    { client: session },
  );
}
