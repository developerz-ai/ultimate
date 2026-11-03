// Single responsibility: letting go of a pool that stopped answering. Bun.SQL exposes no one
// connection to close, and a statement past its bound means a dead path, so its siblings on that path
// are suspect too: the whole pool goes, in the background, and the next statement builds a new one.

import { logger, renderThrowable } from '@ultimat3/core';
import type { BunSqlDriver } from './bun-sql';

/**
 * Measured against a TCP proxy blackholing every connection: `close({ timeout: 1 })` returned at
 * 1003 ms, the hung statement rejected `ERR_POSTGRES_CONNECTION_CLOSED`, a new pool answered on the
 * same proxy. **The unit is seconds.** Total: a caller is already holding the error that matters.
 */
export function closeRetiredPool(pool: Pick<BunSqlDriver, 'close'>): void {
  const report = (error: unknown): void => {
    logger.warn('db.pool.retire_failed', { error: renderThrowable(error) });
  };
  try {
    void pool.close({ timeout: 1 }).then(undefined, report);
  } catch (error) {
    report(error);
  }
}
