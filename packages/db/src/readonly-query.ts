// Single responsibility: LAYER 2 of `db.query`'s defence-in-depth — an isolated `BEGIN READ
// ONLY` transaction with a statement timeout for any SQL an LLM is about to run. Postgres
// enforcing read-only beats a regex, and the timeout bounds a runaway scan the agent never
// meant to ask for.

import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { stripSqlNoise } from './readonly';
import { identifier, raw, sql } from './sql';

/** Default per-statement ceiling for an agent-authored read. */
export const READONLY_TIMEOUT_MS = 5_000;

/**
 * Leaders Postgres accepts in `DECLARE ... CURSOR FOR`. `EXPLAIN` and `SHOW` are commands, not
 * queries, so they have no cursor form and stay on the direct path.
 */
const CURSORABLE_LEADERS = new Set(['select', 'with', 'table', 'values']);

/** Fixed: the cursor lives inside one pinned transaction that always rolls back. */
const CURSOR_NAME = 'ultimate_read_cursor';

export interface ReadOnlyQueryOptions {
  /** Override the ambient pool. */
  readonly client?: DbClient | undefined;
  /** Role to assume for the statement, from `ensureReadOnlyRole`. `null` = none available. */
  readonly role?: string | null | undefined;
  /** 0 disables. Default READONLY_TIMEOUT_MS. */
  readonly timeoutMs?: number | undefined;
  /**
   * Ask the server for at most this many rows, through a cursor. A caller that slices the
   * answer afterwards has already paid for every row the driver produced — `select * from
   * events` materialises the whole table in this process before any ceiling gets to drop it,
   * and a statement timeout does not stop a fast scan that simply returns a lot. Omit for the
   * whole result set. Ignored for `EXPLAIN`/`SHOW`, which have no cursor form.
   */
  readonly maxRows?: number | undefined;
}

export interface ReadOnlyQueryResult<T> {
  readonly rows: readonly T[];
  /** The defences that actually engaged, in the order they ran. Reported, never assumed. */
  readonly guards: readonly string[];
}

/**
 * A whole positive row count, or `undefined` when the caller wants everything. NaN and a
 * fractional or negative ask are the same mistake — treat them as "no cursor" rather than
 * emitting `FETCH FORWARD NaN`, which Postgres would reject as a syntax error.
 */
function fetchCount(maxRows: number | undefined): number | undefined {
  if (maxRows === undefined || !Number.isFinite(maxRows)) return undefined;
  const whole = Math.trunc(maxRows);
  return whole > 0 ? whole : undefined;
}

/**
 * True when Postgres will accept `statement` as a cursor's query. Reads the leading keyword off
 * the *stripped* form so a leading comment or a keyword inside a literal cannot decide it.
 */
function cursorable(statement: string): boolean {
  const leader = /^\s*([a-z]+)/i.exec(stripSqlNoise(statement))?.[1]?.toLowerCase();
  return leader !== undefined && CURSORABLE_LEADERS.has(leader);
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
    // NaN normalises to the default first: only an explicit 0 disables the timeout, and
    // `Math.min(3_600_000, NaN)` is NaN, which would fail `ms > 0` and silently skip the layer.
    const asked = options.timeoutMs ?? READONLY_TIMEOUT_MS;
    const requested = Number.isNaN(asked) ? READONLY_TIMEOUT_MS : asked;
    const ms = Math.max(0, Math.min(3_600_000, Math.trunc(requested)));
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

    const rows = await readRows<T>(connection, statement, fetchCount(options.maxRows), guards);
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

/**
 * Run the caller's statement and return its rows, bounded at the server when it can be.
 *
 * `DECLARE ... CURSOR` costs one extra round trip and buys the only bound that exists before the
 * rows are in this process: without it `maxRows` describes what the caller *keeps*, not what the
 * driver *allocates*. `NO SCROLL` because nothing here reads backwards, and the cursor needs no
 * closing — it dies with the transaction that always rolls back.
 *
 * The statement is spliced in, not bound: a cursor's query is syntax, and there is no `$n` that
 * could carry it. It has already passed the caller's own gate — this function adds no second one.
 */
async function readRows<T>(
  connection: DbClient,
  statement: string,
  fetch: number | undefined,
  guards: string[],
): Promise<readonly T[]> {
  if (fetch === undefined || !cursorable(statement)) return connection.query<T>(raw(statement));

  // A trailing `;` would close `DECLARE` before its query and turn one statement into two.
  const query = statement.trim().replace(/;\s*$/, '');
  await connection.execute(raw(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${query}`));
  const rows = await connection.query<T>(raw(`FETCH FORWARD ${fetch} FROM ${CURSOR_NAME}`));
  guards.push(`fetch:${fetch} rows`);
  return rows;
}
