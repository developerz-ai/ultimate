// The `x_backfills` ledger, projected for the surfaces that report it: `x db backfill --list`,
// `x jobs`, `/_x`'s jobs panel and MCP. Plain JSON-serialisable objects, the same contract
// `inspect.ts` holds for the queue — one shape, so the dashboard renders what `--json` prints.
//
// Nothing here reads a clock. A running row's elapsed time would need one, and "how long has this
// been going" computed against the reader's wall clock is a different number in every process
// that asks — so `durationMs` is the pass's own completed span or nothing at all.

import type { BackfillFilter, BackfillRun, BackfillStatus } from './backfill-ledger';
import type { JobDriver } from './driver';

/** One ledger row as a surface reports it: epochs become ISO, absent becomes `null`. */
export interface BackfillProgress {
  /** The pass, and the run id of the job that is sweeping — `x jobs show <id>` joins on it. */
  readonly runId: string;
  readonly name: string;
  readonly status: BackfillStatus;
  readonly checksum: string;
  readonly appVersion: string;
  /** Rows the pass has handled so far. Absolute, so a replayed batch reports the same number. */
  readonly rows: number;
  /** Where the pass had got to. `null` before the first batch and once it is over. */
  readonly cursor: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  /** How long the pass took. `null` while it is still running — see the file header. */
  readonly durationMs: number | null;
}

export function toBackfillProgress(run: BackfillRun): BackfillProgress {
  return {
    runId: run.runId,
    name: run.name,
    status: run.status,
    checksum: run.checksum,
    appVersion: run.appVersion,
    rows: run.rows,
    cursor: run.cursor,
    startedAt: new Date(run.startedAt).toISOString(),
    completedAt: run.completedAt === undefined ? null : new Date(run.completedAt).toISOString(),
    durationMs: run.completedAt === undefined ? null : run.completedAt - run.startedAt,
  };
}

/**
 * Every pass the ledger holds, newest first. An EMPTY list on a driver that ships no ledger, and
 * deliberately not a throw: `x jobs ls` and the jobs panel report the queue, and a queue that
 * answers everything except "no backfills recorded" is a broken command for a fact nobody asked
 * about. `x db backfill --list` says so in its own summary instead, where it IS the question.
 */
export async function inspectBackfills(
  driver: JobDriver,
  // `BackfillFilter` itself, never its fields restated: `ledger.list` takes that type, so a field
  // added to it reaches this surface instead of being silently dropped one call short of it.
  filter: BackfillFilter = {},
): Promise<readonly BackfillProgress[]> {
  const ledger = driver.backfills;
  if (ledger === undefined) return [];
  return (await ledger.list(filter)).map(toBackfillProgress);
}

/**
 * The pass one job run is sweeping, or nothing. Keyed by run rather than by name because `force`
 * writes a NEW row for a name that already has one — the row this job wrote is the only one that
 * describes this job.
 */
export async function backfillForRun(
  driver: JobDriver,
  runId: string,
): Promise<BackfillProgress | undefined> {
  const [row] = await inspectBackfills(driver, { runId, limit: 1 });
  return row;
}
