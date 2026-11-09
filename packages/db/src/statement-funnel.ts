// Single responsibility: the pooled driver's statement funnel — one statement on one handle, every
// driver failure typed on the way out, traced and put on the bus by `traceStatement` on both
// settle paths. Split from `client.ts` at the file-size rule; `pglite.ts` holds the mirror pair
// (`send`/`statement`) for the embedded driver, and the two must keep answering the same way.

import { callerStack } from '@ultimat3/core';
import { encodeBoundParameters } from './bound-parameters';
import type { BunSqlDriver } from './bun-sql';
import { refuseRolledBackCommit } from './commit-tag';
import { driverError } from './errors';
import type { SqlFragment } from './sql';
import { statementExcerpt } from './statement-excerpt';
import { traceStatement } from './statement-span';

export function rowsOf<T>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

// The command tag only when it counted something, exactly like `rowsOf` in `pglite.ts` — one rule
// across both drivers, so `execute()` and the `db.statement` event cannot answer differently for the
// same statement depending on which database is behind them. A driver that tags a read `0` while
// returning rows would otherwise report 0 here and the row count there.
export function affectedBy(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const count = (result as { count?: unknown }).count;
  return typeof count === 'number' && count > 0 ? count : result.length;
}

/** The send itself: one statement on one handle, every driver failure typed on the way out. */
async function sendOn(
  driver: Pick<BunSqlDriver, 'unsafe'>,
  fragment: SqlFragment,
): Promise<unknown> {
  // `encodeBoundParameters`, never `fragment.values` raw: `Bun.SQL` joins a JS array's elements
  // with commas (#384), and on the pool's unnamed statements sends a `Date` as its local-zone
  // `toString()`. One encoder here rather than one import per call site, because this is the
  // only place this driver's `unsafe` is called.
  //
  // ABOVE the `try`: its refusals are this package's own and already coded. Inside it, a ragged
  // array or an Invalid Date came back as `X_DB_UNAVAILABLE` — "set DATABASE_URL" — from a driver
  // that was never called.
  const values = encodeBoundParameters(fragment.values);
  let result: unknown;
  try {
    result = await driver.unsafe(fragment.text, values);
  } catch (error) {
    // `driverError`, not `dbUnavailable`: the SQLSTATE has always been on this error and nothing
    // read it, so a `23505` from two clicks racing a signup told the operator the database was
    // unreachable and paged on-call for an outage that never happened. Everything the table does
    // not classify is still `X_DB_UNAVAILABLE`, byte for byte.
    throw driverError(statementExcerpt(fragment.text), error);
  }
  // Outside the `try`: this refusal is already typed, and `driverError` would re-wrap it as a
  // database nobody could reach.
  refuseRolledBackCommit(fragment.text, result);
  return result;
}

/**
 * The funnel — pooled and pinned statements both arrive here, which is why the span and the
 * `db.statement` event hang off this one function and nowhere else (`traceStatement`).
 */
export function runOn(
  driver: Pick<BunSqlDriver, 'unsafe'>,
  fragment: SqlFragment,
): Promise<unknown> {
  return traceStatement(fragment, () => sendOn(driver, fragment), affectedBy, callerStack());
}
