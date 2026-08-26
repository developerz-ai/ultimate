// `x_backfills` — what has already been swept, and whether this pass runs at all. The twin of
// `@ultimat3/db`'s `x_migrations`, one level up: a migration ledger is keyed by migration id
// because a migration applies once and only once, and this one is keyed by RUN because a backfill
// may legitimately be run again. `force` therefore writes a NEW row rather than overwriting the
// one that says what the last pass did — reruns are history, not an edit of it.
//
// The row is a REPORT, never a resume source. Where a resumed pass restarts is decided by the step
// checkpoints in `backfill-pass.ts` and by nothing else; `cursor` here is what an operator reads
// while a pass is running. A second answer to "where were we" is the one thing this file must not
// become — the checkpoints are transactional with the work, and this row is not.

import type { Clock } from '@ultimat3/core';
import { finiteOption, systemClock } from '@ultimat3/core';
import { nowMs } from './clock';

/**
 * `failed` is the LAST ATTEMPT's verdict, not the pass's: the queue owns retries, so a row here
 * goes back to `running` when the next attempt starts. Only `completed` is terminal, and it is the
 * one status that blocks a re-run.
 *
 * The runtime list is the declaration and `BackfillStatus` is derived from it, the shape
 * `PRIMITIVE_KINDS` already has: `x db backfill --status` has to validate a string it was handed,
 * and a second list spelled out in the CLI is a status the ledger can record and the flag rejects.
 */
export const BACKFILL_STATUSES = ['running', 'completed', 'failed'] as const;

export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

/** Narrows a string the CLI, MCP or a URL handed over. Never a cast — the list decides. */
export const isBackfillStatus = (value: string): value is BackfillStatus =>
  (BACKFILL_STATUSES as readonly string[]).includes(value);

export interface BackfillRun {
  /** The job run this pass belongs to, and the ledger's primary key. */
  readonly runId: string;
  readonly name: string;
  readonly checksum: string;
  readonly status: BackfillStatus;
  /** The build that STARTED the pass — a redeploy mid-pass does not rewrite it. */
  readonly appVersion: string;
  readonly rows: number;
  /** Where the pass had got to. `null` before the first batch and once it is over. */
  readonly cursor: string | null;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
}

export interface BackfillFilter {
  readonly name?: string | undefined;
  readonly status?: BackfillStatus | undefined;
  /**
   * The one pass this row belongs to. A backfill's run id IS the queue row's, so `x jobs show
   * <id>` can ask how far the sweep behind that job has got without a second lookup table.
   */
  readonly runId?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Durable, and therefore behind the queue driver: `x_backfills` ships in the same DDL as `x_jobs`
 * and `x_job_steps` (`driver-pg-sql.ts`), so a ledger a pass cannot write is a queue it could not
 * have been claimed from. Optional on `JobDriver` for the same reason `introspect` is — a driver
 * with no ledger runs backfills with no bookkeeping rather than refusing them.
 */
export interface BackfillLedger {
  /** Open this run's row, or adopt the one a previous attempt of the SAME run opened. */
  start(run: {
    readonly runId: string;
    readonly name: string;
    readonly checksum: string;
    readonly appVersion: string;
  }): Promise<void>;
  /** Move the row forward. Absolute position, so a replayed batch reports the same number. */
  progress(
    runId: string,
    at: { readonly rows: number; readonly cursor: string | null },
  ): Promise<void>;
  finish(
    runId: string,
    at: { readonly status: 'completed' | 'failed'; readonly rows: number },
  ): Promise<void>;
  /** Newest first. `x db backfill --list` and the verdict below read the same method. */
  list(filter?: BackfillFilter): Promise<readonly BackfillRun[]>;
}

/** Anything callable. `Function` is a banned type and a real signature would pin one definition. */
type AnyFn = (...args: never[]) => unknown;

/**
 * Between the two bodies, and a byte no source text carries. Concatenating them raw would hash a
 * BOUNDARY rather than a pair — `ab` + `c` and `a` + `bc` are one string — so a statement moving
 * from `handle` into `source` could leave the checksum where it was.
 */
const CHECKSUM_SEPARATOR = '\u0000';

/**
 * What "the same backfill" means: the source text of the two functions that decide which rows a
 * pass visits and what happens to them, which is the whole of what a completed row claims was
 * done. `batch` is deliberately out — paging a sweep differently is a tuning change, and a
 * checksum that moved for it would warn on every one.
 *
 * A code hash is fuzzier than a migration's SQL hash: a bundler that reformats a body moves it
 * with no line of behaviour changing. That is exactly why a mismatch WARNS and never refuses,
 * where `@ultimat3/db`'s `auditLedger` throws on the same fact — SQL text is what it applied.
 */
export function backfillChecksum(source: AnyFn, handle: AnyFn): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${source.toString()}${CHECKSUM_SEPARATOR}${handle.toString()}`)
    .digest('hex')
    .slice(0, 32);
}

export interface BackfillVerdict {
  readonly run: boolean;
  /** The completed pass this verdict is about, when the ledger holds one. */
  readonly previous?: BackfillRun | undefined;
  /** `previous` completed under a different definition. Warned about, never refused. */
  readonly changed: boolean;
}

/**
 * Pure, so the pass, a test and `x db backfill` all read one decision. Only a COMPLETED row
 * blocks: a `running` row is this pass resuming (same run) or a pass another worker holds the one
 * live idempotency key for, and a `failed` one is an attempt the queue is about to retry.
 */
export function decideBackfill(
  completed: BackfillRun | undefined,
  checksum: string,
  force: boolean,
): BackfillVerdict {
  if (completed === undefined) return { run: true, changed: false };
  return { run: force, previous: completed, changed: completed.checksum !== checksum };
}

export function createMemoryBackfillLedger(clock: Clock = systemClock): BackfillLedger {
  const runs = new Map<string, BackfillRun>();
  const patch = (runId: string, fields: Partial<BackfillRun>): void => {
    const existing = runs.get(runId);
    if (existing !== undefined) runs.set(runId, { ...existing, ...fields });
  };
  return {
    start(run) {
      const existing = runs.get(run.runId);
      // A retry adopts its own row: `startedAt` is when the PASS began, not this attempt, and the
      // status goes back to `running` so a row a failed attempt marked stops claiming otherwise.
      // `completedAt` goes with it — `finish` stamps one for `failed` too, and a running pass that
      // kept it would report a completion time in the past on every surface that reads the row.
      runs.set(
        run.runId,
        existing === undefined
          ? { ...run, status: 'running', rows: 0, cursor: null, startedAt: nowMs(clock) }
          : { ...existing, status: 'running', completedAt: undefined },
      );
      return Promise.resolve();
    },
    progress(runId, at) {
      patch(runId, { rows: at.rows, cursor: at.cursor });
      return Promise.resolve();
    },
    finish(runId, at) {
      // A failure keeps its cursor — where a pass stopped is the first thing anyone asks.
      patch(runId, {
        status: at.status,
        rows: at.rows,
        completedAt: nowMs(clock),
        ...(at.status === 'completed' ? { cursor: null } : {}),
      });
      return Promise.resolve();
    },
    list(filter = {}) {
      // Reversed BEFORE the sort: the test clock is frozen, so two rows share a `startedAt` and a
      // stable sort would hand back the oldest of them first under a "newest first" contract.
      const rows = [...runs.values()]
        .reverse()
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter((run) => filter.name === undefined || run.name === filter.name)
        .filter((run) => filter.status === undefined || run.status === filter.status)
        .filter((run) => filter.runId === undefined || run.runId === filter.runId)
        .slice(0, finiteOption('the backfill ledger list', 'limit', filter.limit ?? 100));
      return Promise.resolve(rows);
    },
  };
}
