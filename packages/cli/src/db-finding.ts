// One rule for turning a thrown value into a `Finding` on the `x db` path, shared by every
// subcommand: a framework error reaches the caller verbatim, and anything else is named by the
// step that failed. Its own module because `cmd-db.ts` and `cmd-db-branch.ts` both need it and
// neither may import the other.

import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import type { Finding } from './output';
import { findingFrom, isUltimateErrorShape } from './output';

/**
 * The engine names its own failures — `X_MIGRATION_CONFLICT` carries the ledger row that disagrees,
 * `X_MIGRATION_IRREVERSIBLE` carries the exact `--allow-destructive` line to rerun, and
 * `X_BRANCH_EXISTS` carries the `x db branch drop` that clears it — so those reach the caller
 * verbatim. `X_DB_GEN_FAILED` / `X_DB_MIGRATE_FAILED` / `X_DB_BRANCH_FAILED` are what is left: the
 * step failed for a reason no framework error claimed, and the raw message is all there is.
 */
export const stepFinding = (error: unknown, code: string): Finding =>
  isUltimateErrorShape(error)
    ? findingFrom(error)
    : {
        code,
        // The engine may throw a non-Error, and an Error whose `message` is a getter: core's
        // `renderThrowable` reads both without trusting either, so the refusal cannot be lost to
        // a TypeError raised while reporting it.
        cause: renderThrowable(error),
        fix: 'x doctor --json',
        docs: ERROR_DOCS_URL,
      };
