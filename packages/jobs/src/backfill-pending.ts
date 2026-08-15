// Declared minus completed — the diff nothing in the framework could compute, because until
// `backfill-registry.ts` only half of it existed. `inspectBackfills` reads the ledger, so a sweep
// that was merged and never enqueued had no row and appeared on no surface at all.
//
// Pure: declarations in, ledger rows in, verdict out. The reader is `x db backfill --pending`,
// whose non-zero exit is what lets a cron or a deploy check answer "is anything unswept" without
// parsing a table.

import type { Environment } from '@ultimat3/core';
import { checkBackfillEnvironment } from './backfill-gate';
// `BackfillProgress` and not the driver's own `BackfillRun`: `inspectBackfills()` is the ONE
// projection of the ledger, and this diff is its fifth reader rather than a sixth path into rows.
import type { BackfillProgress } from './backfill-inspect';
import type { BackfillDeclaration } from './backfill-registry';

/**
 * `excluded` is a declaration this environment may not run at all, and it is the reason the diff
 * needs an environment: a production-only cleanup read in staging is not drift, and an alarm that
 * fired on it would be muted within a week.
 */
export const BACKFILL_STATES = ['pending', 'running', 'failed', 'completed', 'excluded'] as const;

export type BackfillState = (typeof BACKFILL_STATES)[number];

/** One declaration, judged against the ledger. Plain JSON: absent is `null`, never `undefined`. */
export interface BackfillStateRow {
  readonly name: string;
  readonly state: BackfillState;
  readonly checksum: string;
  /** The checksum the newest run under this name recorded, when there is one. */
  readonly ledgerChecksum: string | null;
  /** The completed pass ran under a different definition. Reported, never a refusal. */
  readonly changed: boolean;
  readonly requires: string | null;
  readonly environments: readonly Environment[] | null;
  readonly lastRunId: string | null;
  readonly rows: number | null;
}

export interface BackfillPendingReport {
  readonly environment: Environment;
  /** Every declaration, judged. Newest-first ledger rows decide each verdict. */
  readonly rows: readonly BackfillStateRow[];
  /**
   * The alarm: `pending` and `failed`, never `running` — a pass in flight is progress, and a check
   * that went red for the duration of every sweep is a check nobody leaves wired to a deploy.
   */
  readonly pending: readonly BackfillStateRow[];
  /** Ledger names no declaration carries — a sweep whose module was deleted after it ran. */
  readonly orphaned: readonly string[];
}

/** Newest first is `BackfillLedger.list`'s contract, so the first match under a name is the one. */
const newestUnder = (
  runs: readonly BackfillProgress[],
  name: string,
): BackfillProgress | undefined => runs.find((run) => run.name === name);

function stateOf(
  declaration: BackfillDeclaration,
  runs: readonly BackfillProgress[],
  environment: Environment,
): BackfillState {
  if (
    checkBackfillEnvironment(declaration.name, declaration.environments, environment) !== undefined
  ) {
    return 'excluded';
  }
  const under = runs.filter((run) => run.name === declaration.name);
  // A completed row anywhere in this name's history is what blocks a re-run, so it decides the
  // state even when a later forced pass failed — `decideBackfill` reads the same fact.
  if (under.some((run) => run.status === 'completed')) return 'completed';
  const newest = under[0];
  if (newest === undefined) return 'pending';
  return newest.status === 'running' ? 'running' : 'failed';
}

export function pendingBackfills(input: {
  readonly declarations: readonly BackfillDeclaration[];
  /** Every `x_backfills` row, newest first — `inspectBackfills`' own order, unfiltered. */
  readonly runs: readonly BackfillProgress[];
  readonly environment: Environment;
}): BackfillPendingReport {
  const rows = input.declarations.map((declaration): BackfillStateRow => {
    const newest = newestUnder(input.runs, declaration.name);
    const completed = input.runs.find(
      (run) => run.name === declaration.name && run.status === 'completed',
    );
    return {
      name: declaration.name,
      state: stateOf(declaration, input.runs, input.environment),
      checksum: declaration.checksum,
      ledgerChecksum: newest?.checksum ?? null,
      changed: completed !== undefined && completed.checksum !== declaration.checksum,
      requires: declaration.requires,
      environments: declaration.environments,
      lastRunId: newest?.runId ?? null,
      rows: newest?.rows ?? null,
    };
  });
  const declared = new Set(input.declarations.map((declaration) => declaration.name));
  const orphaned = [...new Set(input.runs.map((run) => run.name))]
    .filter((name) => !declared.has(name))
    .sort();
  return {
    environment: input.environment,
    rows,
    pending: rows.filter((row) => row.state === 'pending' || row.state === 'failed'),
    orphaned,
  };
}
