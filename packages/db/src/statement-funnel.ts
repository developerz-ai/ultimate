// Single responsibility: the pooled driver's statement funnel — one statement on one handle, every
// driver failure typed on the way out, and the installed `StatementObserver` notified on both
// settle paths. Split from `client.ts` at the file-size rule; `pglite.ts` holds the mirror pair
// (`send`/`statement`) for the embedded driver, and the two must keep answering the same way.

import { encodeArrayParameters } from './array-parameter';
import { statementAttribution } from './attribution';
import type { BunSqlDriver } from './bun-sql';
import { driverError } from './errors';
import { expectedQueryLoopReason } from './expected-loop';
import { statementObserver } from './observe';
import type { SqlFragment } from './sql';
import { statementExcerpt } from './statement-excerpt';
import { withStatementSpan } from './statement-span';

export function rowsOf<T>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

// The command tag only when it counted something, exactly like `rowsOf` in `pglite.ts` — one rule
// across both drivers, so `execute()` and the observer's event cannot answer differently for the
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
  try {
    // `encodeArrayParameters`, never `fragment.values` raw: `Bun.SQL` joins a JS array's elements
    // with commas, so every `any($n::T[])` in this framework sent Postgres a malformed literal and
    // failed — the worker's claim loop among them (#384). One encoder here rather than one import
    // per call site, because this is the only place this driver's `unsafe` is called.
    return await driver.unsafe(fragment.text, encodeArrayParameters(fragment.values));
  } catch (error) {
    // `driverError`, not `dbUnavailable`: the SQLSTATE has always been on this error and nothing
    // read it, so a `23505` from two clicks racing a signup told the operator the database was
    // unreachable and paged on-call for an outage that never happened. Everything the table does
    // not classify is still `X_DB_UNAVAILABLE`, byte for byte.
    throw driverError(statementExcerpt(fragment.text), error);
  }
}

/**
 * The funnel — pooled and pinned statements both arrive here, which is why the observer hangs
 * off this one function and nowhere else. Uninstalled it costs one property read and one
 * branch: no clock read, no span, no event object, and `sendOn` receives exactly the call `runOn`
 * made before the seam existed (axiom 6).
 */
export async function runOn(
  driver: Pick<BunSqlDriver, 'unsafe'>,
  fragment: SqlFragment,
): Promise<unknown> {
  const observer = statementObserver();
  if (observer === undefined) return sendOn(driver, fragment);
  // Read here, not by the consumer: the scope is gone by the time a per-request detector judges
  // what it collected, so the reason has to be captured with the statement it defends.
  const expected = expectedQueryLoopReason();
  // Same moment, same argument: `postgresRepo` is several frames and a microtask above this one,
  // and what it knows — the entity and the operation — is what turns fifty identical `select`s
  // into "50× findById on members". Absent for hand-written SQL, a migration, a health probe.
  const attribution = statementAttribution();
  const started = performance.now();
  let result: unknown;
  try {
    // The span wraps the send and nothing else, so its duration is the statement's and the
    // observer's own work is not charged to the database.
    result = await withStatementSpan(fragment.text, () => sendOn(driver, fragment));
  } catch (error) {
    // A statement that failed is still a statement: fifty identical timeouts are an N+1 of
    // timeouts. The error is already `X_DB_UNAVAILABLE`, so the event carries what the caller
    // is about to be thrown — and an observer that throws here replaces it, which is why
    // `observe.ts` says a reporting-only observer must not throw.
    observer.onStatement({
      text: fragment.text,
      values: fragment.values,
      durationMs: performance.now() - started,
      rows: 0,
      error,
      attribution,
      expected,
    });
    throw error;
  }
  // Outside the `try` deliberately: a throw from `onStatement` is the observer's, not the
  // database's, and catching it above would report a statement that succeeded as failed.
  observer.onStatement({
    text: fragment.text,
    values: fragment.values,
    durationMs: performance.now() - started,
    rows: affectedBy(result),
    attribution,
    expected,
  });
  return result;
}
