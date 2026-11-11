// The embedded-database rule for `x doctor`: an optional peer is required only when the selected
// database is PGlite, so external Postgres configurations do not receive irrelevant advice.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { PGLITE_FIX, PGLITE_MISSING } from '@ultimat3/db';
import type { EmbeddedDatabase } from './doctor-probe-types';
import type { Finding } from './output';

/** Converts the embedded database facts into the package-owned unavailable-database diagnostic. */
export const embeddedDatabaseFinding = (fact: EmbeddedDatabase): Finding | undefined =>
  fact.selected && !fact.resolved
    ? {
        code: 'X_DB_UNAVAILABLE',
        cause: `${PGLITE_MISSING} — and DATABASE_URL is unset or blank, so the embedded one is the database this app would open`,
        fix: PGLITE_FIX,
        docs: ERROR_DOCS_URL,
      }
    : undefined;
