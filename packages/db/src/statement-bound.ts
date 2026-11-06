// Single responsibility: a time bound for ONE read, tighter than the role's. `statement_timeout`
// is per role (`libpq-options.ts`); a search that must give up at 500 ms and a report allowed 60 s
// share it unless the read states its own, transaction-local, through the one `setLocal` seam.

import type { DbClient } from './client';
import { DbError } from './errors';
import { setLocal } from './local-settings';
import { withReadTransaction } from './read-transaction';
import { sql } from './sql';
import { currentTx } from './transaction';
import type { DbTx } from './transaction-options';

const FIX =
  'query({ timeoutMs: 500 })  # a whole number of ms below the role bound, read with: psql "$DATABASE_URL" -c \'show statement_timeout\'';

function boundInvalid(ms: number, why: string): DbError {
  return new DbError({
    code: 'X_DB_STATEMENT_BOUND_INVALID',
    cause: `withStatementTimeout(${String(ms)}) — ${why}`,
    fix: FIX,
  });
}

export interface StatementBoundOptions {
  /** Override the ambient pool, as `withTransaction`'s `client` does. */
  readonly client?: DbClient | undefined;
}

interface BoundRow {
  readonly ms: string | number | null;
}

/**
 * The bound in force on `tx` now, in ms; `0` is none. Read from `pg_settings`, whose `setting` is
 * already milliseconds — `current_setting` answers `10s`, a unit this would have to parse.
 */
async function boundOn(tx: DbTx): Promise<number> {
  const row = await tx.one<BoundRow>(
    sql`select setting as ms from pg_settings where name = 'statement_timeout'`,
  );
  return Number(row?.ms ?? 0);
}

/**
 * `fn` inside a read-only transaction whose statements are bounded at `ms`. A transaction is pinned
 * to the primary, so a bounded read never reaches a replica. Inside an open transaction the bound is
 * set, `fn` runs, and the prior bound is put back — the rest of that transaction keeps its own.
 *
 * Refused above the bound already in force (`X_DB_STATEMENT_BOUND_INVALID`): a read cannot extend
 * what the role was sized for. The bound firing is `57014`, which stays `X_DB_STATEMENT_TIMEOUT`.
 */
export function withStatementTimeout<T>(
  ms: number,
  fn: (tx: DbTx) => Promise<T>,
  options: StatementBoundOptions = {},
): Promise<T> {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    return Promise.reject(boundInvalid(ms, 'a bound is a whole number of milliseconds above 0'));
  }
  const nested = currentTx() !== undefined;
  return withReadTransaction(async (tx) => {
    const prior = await boundOn(tx);
    if (prior > 0 && ms > prior) {
      throw boundInvalid(
        ms,
        `the bound in force is ${String(prior)} ms, and a read may only tighten it`,
      );
    }
    await setLocal(tx, { statement_timeout: String(ms) });
    if (!nested) return fn(tx);
    let result: T;
    try {
      result = await fn(tx);
    } catch (error) {
      // Aborted by `fn`'s own failure, the restore would fail too; the abort discards the bound.
      await setLocal(tx, { statement_timeout: String(prior) }).catch(() => undefined);
      throw error;
    }
    await setLocal(tx, { statement_timeout: String(prior) });
    return result;
  }, options);
}
