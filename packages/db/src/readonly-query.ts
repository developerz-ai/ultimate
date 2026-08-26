// Single responsibility: LAYER 2 of `db.query`'s defence-in-depth — an isolated `BEGIN READ
// ONLY` transaction with a statement timeout for any SQL an LLM is about to run. Postgres
// enforcing read-only beats a regex, and the timeout bounds a runaway scan the agent never
// meant to ask for.

import { finiteCount } from '@ultimat3/core';
import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { multipleStatements } from './errors';
import { identifier, raw, sql } from './sql';
import { stripSqlNoise } from './sql-noise';
import { statementsOf } from './statement-split';

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
 * `SAVEPOINT`, and a savepoint inside a read-write transaction is not read-only. It runs no
 * mutating-keyword scan of its own either — `BEGIN READ ONLY` is the server refusing the write,
 * which is stronger than any regex, and this package deliberately ships no second answer to "is
 * this SQL a write?" (`@ultimat3/mcp`'s parse guard is layer 3, and it is the only one).
 */
export async function readOnlyQuery<T>(
  statement: string,
  options: ReadOnlyQueryOptions = {},
): Promise<ReadOnlyQueryResult<T>> {
  // ONE statement, decided before anything is opened. Not a second mutating-keyword scan — a
  // different question, and the one the guards below depend on: only the first command of a text
  // is bounded by them, so `select 1; set statement_timeout = 0` undid the timeout this function
  // had just installed while `guards` went on reporting `timeout:5000ms`. `statementsOf` is the
  // package's one splitter, so a `;` inside a literal, a comment or a dollar-quoted body is data.
  const statements = statementsOf(statement);
  if (statements.length > 1) throw multipleStatements(statement, statements.length);

  // Decided before anything is opened, for the reason `rollback({ steps })` screens before it
  // takes the advisory lock: a value this build cannot honour is not a fact about the pool. It
  // was computed after `reserve()` and after `BEGIN READ ONLY`, so an unbounded `timeoutMs`
  // against an exhausted pool answered with the pool's error — or waited for a connection it was
  // never going to use — in place of the `X_INVARIANT` naming the option that was wrong.
  //
  // Clamped and truncated to an integer: the result is a JS number the caller never touches
  // as text, so there is nothing here for `raw()` to inject — `SET LOCAL` can't bind `$n`
  // parameters, which is why this can't go through `sql` the normal, parameterised way.
  // REFUSED rather than normalised: `NaN` used to take the default silently, so a config typo
  // ran under a timeout nobody wrote. Only an explicit 0 disables the layer, which is why the
  // floor is 0 and not 1; the hour ceiling is a clamp on a number that IS one.
  const asked = finiteCount(
    'readonlyQuery',
    'timeoutMs',
    options.timeoutMs ?? READONLY_TIMEOUT_MS,
    0,
  );
  const ms = Math.min(3_600_000, asked);

  const client = options.client ?? baseClient();
  // A pooled BEGIN that lands on a different physical connection than the query that follows is
  // not a transaction at all, so a reservable client must pin one connection for the sequence.
  // Held by a `using` declaration, the same shape as `withTransaction` — the pin comes back on
  // every exit path, and no future edit can move a statement above the guard that returns it.
  using reserved: DbConnection | undefined = isReservable(client)
    ? await client.reserve()
    : undefined;
  const connection: DbClient = reserved ?? client;
  const guards: string[] = [];

  try {
    await connection.execute(raw('BEGIN READ ONLY'));
    guards.push('txn:read-only');

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

    // Two texts, deliberately: the caller's own, sent verbatim when nothing is spliced, and the
    // one COMMAND `statementsOf` cut out of it, which is the only text a `DECLARE` may carry.
    const rows = await readRows<T>(
      connection,
      statement,
      statements[0] ?? statement,
      fetchCount(options.maxRows),
      guards,
    );
    await connection.execute(raw('ROLLBACK'));
    return { rows, guards };
  } catch (error) {
    // Best-effort: the caller needs the original error, never the rollback's.
    await connection.execute(raw('ROLLBACK')).catch(() => undefined);
    throw error;
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
  /** What the caller wrote. Sent byte-for-byte on the uncursored path, which splices nothing. */
  statement: string,
  /**
   * The one command `statementsOf` cut out of it — what may be spliced.
   *
   * This was `statement.trim().replace(/;\s*$/, '')`, a second answer to "where does the command
   * end" that only saw a `;` at the very END of the text: `select 1; -- note` is ONE statement to
   * the splitter (a chunk of pure noise is not a statement), so it passed the one-statement gate
   * and reached the splice whole, as `DECLARE … CURSOR FOR select 1; -- note` — two commands, and
   * `cannot insert multiple commands into a prepared statement` out of the driver with no code
   * and no `fix:`. The splitter is the package's one answer, and this is now its only reader.
   */
  command: string,
  fetch: number | undefined,
  guards: string[],
): Promise<readonly T[]> {
  if (fetch === undefined || !cursorable(command)) return connection.query<T>(raw(statement));

  await connection.execute(raw(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${command}`));
  const rows = await connection.query<T>(raw(`FETCH FORWARD ${fetch} FROM ${CURSOR_NAME}`));
  guards.push(`fetch:${fetch} rows`);
  return rows;
}
