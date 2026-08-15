// May this named sweep run here, now? One decision, pure, so the pass, the CLI, a test and a
// deploy container all read the same verdict instead of four almost-identical `if`s. It RETURNS
// the refusal rather than throwing it: `x db backfill --all` isolates per name and continues past
// a failure, and a thrown verdict would let one wedged cleanup block every later one forever.
//
// The environment half is enforced inside the pass as well, because a backfill enqueued by app
// code never passes through the CLI — the check has to sit where the work is, or it is a
// convention rather than a rail (axiom 3).

import type { Environment, UltimateError } from '@ultimat3/core';
// `BackfillProgress`, the one ledger projection every surface already reads — never the driver's
// own row shape, which would make this a second reader of `x_backfills`.
import type { BackfillProgress } from './backfill-inspect';
import type { BackfillDeclaration } from './backfill-registry';
import {
  BackfillAppliedError,
  BackfillEnvironmentError,
  BackfillMigrationPendingError,
} from './errors';

export type BackfillGate =
  | { readonly run: true }
  | { readonly run: false; readonly error: UltimateError };

const ALLOWED: BackfillGate = { run: true };

/**
 * An absent `environments` means EVERY environment. Never an implied "production only": a staging
 * rehearsal is correct practice, and a framework that guessed which deploys a cleanup belongs to
 * would be shipping one business's convention to every app (axiom 8).
 */
export function checkBackfillEnvironment(
  backfill: string,
  declared: readonly Environment[] | null,
  environment: Environment,
): BackfillEnvironmentError | undefined {
  if (declared === null || declared.length === 0) return undefined;
  if (declared.includes(environment)) return undefined;
  return new BackfillEnvironmentError({ backfill, environment, declared });
}

export interface BackfillGateInput {
  readonly declaration: BackfillDeclaration;
  readonly environment: Environment;
  /**
   * Migration ids `x_migrations` records as applied. `undefined` means the caller could not read
   * the ledger, and an unreadable ledger is deliberately NOT a refusal — a `requires` that blocked
   * on "I could not check" would make every driver with no database an unrunnable backfill.
   */
  readonly appliedMigrations: readonly string[] | undefined;
  /** The newest COMPLETED pass under this name, when the ledger holds one. */
  readonly completed: BackfillProgress | undefined;
  readonly force: boolean;
}

/**
 * Order is the order an operator can act in: environment first (nothing else matters if this
 * process may not run it at all), then the migration it waits on, then whether it already ran.
 * A live pass is NOT judged here — that verdict belongs to the enqueue, which is the only thing
 * that can see the one live idempotency key without racing it.
 */
export function gateBackfill(input: BackfillGateInput): BackfillGate {
  const { declaration } = input;
  const environment = checkBackfillEnvironment(
    declaration.name,
    declaration.environments,
    input.environment,
  );
  if (environment !== undefined) return { run: false, error: environment };

  const requires = declaration.requires;
  if (
    requires !== null &&
    input.appliedMigrations !== undefined &&
    !input.appliedMigrations.includes(requires)
  ) {
    return {
      run: false,
      error: new BackfillMigrationPendingError({ backfill: declaration.name, migration: requires }),
    };
  }

  const completed = input.completed;
  if (completed !== undefined && !input.force) {
    return {
      run: false,
      error: new BackfillAppliedError({
        backfill: declaration.name,
        runId: completed.runId,
        // Verbatim: the projection already rendered it as ISO, and the repo forbids a date
        // formatted without an explicit zone — not formatting at all is the one render with none.
        completedAt: completed.completedAt ?? completed.startedAt,
      }),
    };
  }
  return ALLOWED;
}
