// The seven `X_BACKFILL_*` codes, apart from `errors.ts` for the reason `driver-pg-rows.ts` is
// apart from `driver-pg.ts`: one file, one job, and `errors.ts` was over the 500-line ceiling
// `x verify`'s `filesize` step enforces. The registry stays there — `JOB_OWNED_ERROR_CODES`,
// `JOB_ERROR_TITLES` and the single `registerErrorCodes()` call — because a package's codes are
// declared in ONE place; only the classes that throw them live here, beside `backfill-ledger.ts`,
// `backfill-pending.ts` and `backfill-registry.ts`.

import { UltimateError } from '@ultimat3/core';
import { docsFor } from './errors';

/**
 * The seven backfill codes below all answer one question — "why is this sweep not running?" — and
 * each is here because it sends the reader somewhere different: run it, force it, change
 * environment, migrate first, wait, fix the predicates, or fix the name. A code that shared a fix
 * line with another one would be code inflation, which is why `X_BACKFILL_WRITE_UNCONFIRMED` was
 * considered and rejected: a dry run that wrote nothing did exactly what it was asked to.
 *
 * Every `fix` below is ONE line something can execute — a shell command, or the edit to make.
 * Never a command with prose appended: a `fix:` is copied and run verbatim, so a trailing clause
 * turns a working command into a syntax error at the one moment the reader is following it
 * literally. Explanations belong in `cause`, which is read and never run.
 */

/**
 * Declared and never completed. The alarm the framework did not have: an author could
 * `x g backfill`, merge and deploy, and nothing anywhere said the pass had not run.
 */
export class BackfillPendingError extends UltimateError {
  constructor(input: { backfill: string; environment: string }) {
    super({
      code: 'X_BACKFILL_PENDING',
      cause: `backfill "${input.backfill}" is declared and x_backfills holds no completed pass for it in ${input.environment}`,
      fix: `x db backfill ${input.backfill} --write --json`,
      docs: docsFor('X_BACKFILL_PENDING'),
    });
  }
}

/** Already swept. A rerun is legitimate, so this names the flag rather than refusing outright. */
export class BackfillAppliedError extends UltimateError {
  constructor(input: { backfill: string; runId: string; completedAt: string }) {
    super({
      code: 'X_BACKFILL_APPLIED',
      cause: `backfill "${input.backfill}" completed as run ${input.runId} at ${input.completedAt}; a forced rerun writes a NEW ledger row and never edits that one`,
      fix: `x db backfill ${input.backfill} --write --force --json`,
      docs: docsFor('X_BACKFILL_APPLIED'),
    });
  }
}

/**
 * The declaration names the environments it belongs to and this is not one. Declared DATA, never a
 * hardcoded "cleanups are production": a staging rehearsal is correct practice, so which
 * environments a sweep belongs to is the app's convention and this is only the mechanism carrying
 * it (axiom 8).
 */
export class BackfillEnvironmentError extends UltimateError {
  constructor(input: { backfill: string; environment: string; declared: readonly string[] }) {
    // The first declared environment, because the fix has to be ONE runnable line and the list is
    // ordered by the author. The empty case cannot arise from `checkBackfillEnvironment`, which
    // treats an empty list as "every environment" — but this constructor is public, so it answers
    // with the command that lists what IS declared rather than an `ULTIMATE_ENV=undefined`.
    const target = input.declared[0];
    super({
      code: 'X_BACKFILL_ENVIRONMENT',
      cause: `backfill "${input.backfill}" declares environments: ${input.declared.join(', ')} and this process resolved ${input.environment} — add "${input.environment}" to that list if this deploy should sweep too`,
      fix:
        target === undefined
          ? 'x db backfill --pending --json'
          : `ULTIMATE_ENV=${target} x db backfill ${input.backfill} --write --json`,
      docs: docsFor('X_BACKFILL_ENVIRONMENT'),
    });
  }
}

/**
 * `requires` names a migration the ledger has not applied. Checked where `x_migrations` is
 * readable — this package holds no `@ultimat3/db` dependency and growing one to read a ledger
 * would put the migration engine on the tier-3 queue's import graph.
 */
export class BackfillMigrationPendingError extends UltimateError {
  constructor(input: { backfill: string; migration: string }) {
    super({
      code: 'X_BACKFILL_MIGRATION_PENDING',
      cause: `backfill "${input.backfill}" requires migration ${input.migration}, which x_migrations does not record as applied`,
      fix: 'x db migrate --json',
      docs: docsFor('X_BACKFILL_MIGRATION_PENDING'),
    });
  }
}

/**
 * The enqueue deduped: one live pass per name, so this run is the one already going. Distinct from
 * `X_BACKFILL_APPLIED`, which is a pass that finished — the response there is `--force`, and the
 * response here is to look at the run that is holding the key.
 */
export class BackfillRunningError extends UltimateError {
  constructor(input: { backfill: string; jobId: string }) {
    super({
      code: 'X_BACKFILL_RUNNING',
      cause: `backfill "${input.backfill}" already has a live pass queued as ${input.jobId}, and one name holds one live pass; its step trace names the batch it is on, and a pass that is not advancing is a worker that lost its lease`,
      fix: `x jobs show ${input.jobId} --json`,
      docs: docsFor('X_BACKFILL_RUNNING'),
    });
  }
}

/**
 * The source ran out of rows and the declaration's own `count()` still matches some. Two
 * predicates that disagree is an authoring bug in any business — the sweep reported success over
 * rows it never visited — so the pass fails rather than writing a completed row nobody can trust.
 */
export class BackfillStalledError extends UltimateError {
  constructor(input: { backfill: string; remaining: number; swept: number }) {
    super({
      code: 'X_BACKFILL_STALLED',
      cause: `backfill "${input.backfill}" swept ${input.swept} rows, exhausted its source, and count() still matches ${input.remaining} — a WHERE the sweep narrows and the count does not is what leaves rows behind`,
      fix: `make count() select on exactly what source() selects on in backfill("${input.backfill}")`,
      docs: docsFor('X_BACKFILL_STALLED'),
    });
  }
}

/** A name no declaration in this app carries — a typo, or a backfill whose module was deleted. */
export class BackfillUnknownError extends UltimateError {
  constructor(input: { backfill: string; known: readonly string[] }) {
    super({
      code: 'X_BACKFILL_UNKNOWN',
      cause:
        input.known.length === 0
          ? `no backfill named "${input.backfill}" is declared, and this app declares none at all`
          : `no backfill named "${input.backfill}" is declared (declared: ${input.known.join(', ')})`,
      fix: 'x db backfill --pending --json',
      docs: docsFor('X_BACKFILL_UNKNOWN'),
    });
  }
}
