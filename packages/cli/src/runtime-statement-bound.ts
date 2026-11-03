// Single responsibility: the one boot line for a statement bound that is not the role's. A report,
// never a refusal: a fleet already running on a pooler that drops the bound must not stop on upgrade.

import { logger, renderThrowable, resolveRole } from '@ultimat3/core';
import type { DbClient, PostgresClient } from '@ultimat3/db';
import { lostStatementBound, statementBound } from '@ultimat3/db';

/** PGlite has no profile and no `options`, and a replica's bound is read by nothing at boot. */
const isPool = (db: DbClient): db is PostgresClient => 'profile' in db && 'pooler' in db;

/** Total: a boot that got past `db.ping()` does not fail on a report about itself. */
export async function reportStatementBound(db: DbClient): Promise<void> {
  if (!isPool(db)) return;
  try {
    const lost = lostStatementBound(await statementBound(db), resolveRole(), db.pooler);
    if (lost !== undefined) {
      logger.error(lost.format(), { code: lost.code, ...lost.meta });
    }
  } catch (error) {
    logger.debug('db.statement_bound_unread', { error: renderThrowable(error) });
  }
}
