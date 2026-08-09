// Single responsibility: LAYER 2 of `db.query`'s defence-in-depth — an isolated `BEGIN READ
// ONLY` transaction with a statement timeout for any SQL an LLM is about to run. Postgres
// enforcing read-only beats a regex, and the timeout bounds a runaway scan the agent never
// meant to ask for.

import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { identifier, raw, sql } from './sql';

/** Default per-statement ceiling for an agent-authored read. */
export const READONLY_TIMEOUT_MS = 5_000;

export interface ReadOnlyQueryOptions {
  /** Override the ambient pool. */
  readonly client?: DbClient | undefined;
  /** Role to assume for the statement, from `ensureReadOnlyRole`. `null` = none available. */
  readonly role?: string | null | undefined;
  /** 0 disables. Default READONLY_TIMEOUT_MS. */
  readonly timeoutMs?: number | undefined;
}

export interface ReadOnlyQueryResult<T> {
  readonly rows: readonly T[];
  /** The defences that actually engaged, in the order they ran. Reported, never assumed. */
  readonly guards: readonly string[];
}

/**
 * Runs `statement` inside its own `BEGIN READ ONLY` transaction, on one pinned connection, and
 * always exits via `ROLLBACK` — a read-only transaction has nothing to commit, and rollback is
 * the one exit that cannot be wrong. The statement has already been parsed and accepted
 * upstream, so this does not re-scan it for mutating keywords: a second gate is a second place
 * to keep right.
 *
 * Deliberately does not use `withTransaction`: it nests into an ambient transaction with a
 * `SAVEPOINT`, and a savepoint inside a read-write transaction is not read-only. Deliberately
 * does not wrap the connection in `readOnly()` either: that guard's regex would refuse our own
 * `SET LOCAL` statements, and `BEGIN READ ONLY` is a stronger, Postgres-enforced backstop.
 */
export async function readOnlyQuery<T>(
  statement: string,
  options: ReadOnlyQueryOptions = {},
): Promise<ReadOnlyQueryResult<T>> {
  const client = options.client ?? baseClient();
  // A pooled BEGIN that lands on a different physical connection than the query that follows is
  // not a transaction at all, so a reservable client must pin one connection for the sequence.
  const reserved: DbConnection | undefined = isReservable(client)
    ? await client.reserve()
    : undefined;
  const connection: DbClient = reserved ?? client;
  const guards: string[] = [];

  try {
    await connection.execute(raw('BEGIN READ ONLY'));
    guards.push('txn:read-only');

    // Clamped and truncated to an integer: the result is a JS number the caller never touches
    // as text, so there is nothing here for `raw()` to inject — `SET LOCAL` can't bind `$n`
    // parameters, which is why this can't go through `sql` the normal, parameterised way.
    const ms = Math.max(
      0,
      Math.min(3_600_000, Math.trunc(options.timeoutMs ?? READONLY_TIMEOUT_MS)),
    );
    if (ms > 0) {
      // `LOCAL`, so the setting dies with the transaction — one agent read must not re-time
      // every request the pool serves afterwards. Caveat: embedded PGlite applies the setting
      // but is single-threaded WASM, so it cannot interrupt a running scan; on a real server
      // the timeout fires. Layers 1 and 3 do not depend on it.
      await connection.execute(raw(`SET LOCAL statement_timeout = ${ms}`));
      guards.push(`timeout:${ms}ms`);
    }

    // Timeout first, then role: a role restricted to SELECT must not be the one asked to change
    // the session's own statement_timeout.
    if (typeof options.role === 'string' && options.role.length > 0) {
      await connection.execute(sql`SET LOCAL ROLE ${identifier(options.role)}`);
      guards.push(`role:${options.role}`);
    }

    const rows = await connection.query<T>(raw(statement));
    await connection.execute(raw('ROLLBACK'));
    return { rows, guards };
  } catch (error) {
    // Best-effort: the caller needs the original error, never the rollback's.
    await connection.execute(raw('ROLLBACK')).catch(() => undefined);
    throw error;
  } finally {
    reserved?.release();
  }
}
