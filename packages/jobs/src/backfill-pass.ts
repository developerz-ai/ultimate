// One `backfill()` pass: the iteration, its durable checkpoints, and the `x_backfills` row that
// reports them. Split out of `backfill.ts` for the reason `execute.ts` is split out of `job.ts` —
// that file declares a backfill, this one runs it.
//
// `inBatches()` reads the source one statement per page, and each page is handled inside its own
// `step.run`, so an attempt killed mid-pass resumes on the page it stopped at instead of reading
// the table again from the top. What a step persists is the CURSOR and the row count, never the
// page: `steps.ts` hands a completed step's output back for the whole run, so checkpointing rows
// would retain every row of every batch already processed until the job ended — the leak that
// turns a backfill of a large table into an OOM.
//
// The ledger is the OTHER half and never a second copy of this one: a step checkpoint is written
// in step with the work and decides where a resumed pass restarts, while the `x_backfills` row is
// a report an operator reads and the record that a completed name has already been swept.

import { appVersion, assert, logger, resolveEnvironment } from '@ultimat3/core';
import type { BatchIterator } from '@ultimat3/entity';
import type { BackfillDefinition, BackfillInput, BackfillReport } from './backfill';
import { checkBackfillEnvironment } from './backfill-gate';
import type { BackfillLedger, BackfillRun } from './backfill-ledger';
import { decideBackfill } from './backfill-ledger';
import type { Pacer } from './backfill-rate';
import { jobDriver } from './driver';
import { BackfillStalledError } from './errors';
import type { JobRunArgs } from './job';
import { isStepSuspension } from './steps';

/** Every batch is a step, and this is the name it is checkpointed under. See `backfillPass()`. */
const STEP_PREFIX = 'batch:';

/** What a step persists: a bounded position, never the page it came from. See the file header. */
interface Checkpoint {
  /** Where the next batch starts; `null` once the pass is over. */
  readonly cursor: string | null;
  readonly rows: number;
}

/** One live iteration and the pull that advances it. Rebuilt when the checkpoints disagree. */
interface Iteration<Row> {
  readonly batches: BatchIterator<Row>;
  readonly pull: AsyncIterator<readonly Row[]>;
}

/** Everything about the backfill that is fixed at declaration, hashed, sized and paced once. */
export interface BackfillPlan<Row> {
  readonly definition: BackfillDefinition<Row>;
  readonly size: number;
  readonly checksum: string;
  /** The declared `rate`, already an interval. Built at declaration for the reason `size` is. */
  readonly pace: Pacer;
}

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * `steps.ts` hands a completed step's output back through an unchecked `as T`, so a checkpoint
 * READ from storage is this shape by claim and never by check. It is checked here because the
 * failure it would otherwise cause is silent and expensive: an absent cursor is not `null`, so the
 * loop would reopen the source at the top and walk the whole table a second time.
 */
function asCheckpoint(value: unknown, step: string): Checkpoint {
  const cursor = fieldOf(value, 'cursor');
  const rows = fieldOf(value, 'rows');
  assert(
    (cursor === null || typeof cursor === 'string') && typeof rows === 'number',
    `step "${step}" replayed ${JSON.stringify(value)}, which is not a backfill checkpoint`,
    `x jobs show <jobId> --json prints the run's steps — a run id whose "${step}" was written by something other than this backfill has to be retired, not resumed`,
  );
  return { cursor, rows };
}

/**
 * The newest COMPLETED pass under this name, or nothing. A `running` row is this pass resuming or
 * one another worker holds the single live idempotency key for, and a `failed` one is an attempt
 * the queue is about to retry — neither is a sweep that has already happened.
 */
async function completedRun(
  ledger: BackfillLedger | undefined,
  name: string,
): Promise<BackfillRun | undefined> {
  if (ledger === undefined) return undefined;
  const rows = await ledger.list({ name, status: 'completed', limit: 1 });
  return rows[0];
}

/**
 * Record the attempt that ended badly and let the original error through untouched: the queue's
 * retry decision is made on it, so a bookkeeping failure that replaced it would dead-letter — or
 * silently retry — for the wrong reason. Logged rather than swallowed, because a ledger nobody
 * can write is worth exactly one line.
 */
async function markFailed(
  ledger: BackfillLedger | undefined,
  runId: string,
  rows: number,
): Promise<void> {
  try {
    await ledger?.finish(runId, { status: 'failed', rows });
  } catch (error) {
    logger.warn('jobs.backfill.ledger-failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The stall detector. `count()` is the same predicate `source` selects on, so a source that ran
 * out while the count still matches rows means the two disagree — the sweep reported success over
 * rows nobody visited, which is an authoring bug in any business and not a condition the queue can
 * retry its way out of. Silent without a declared `count()`: the framework will not guess a number
 * on the author's behalf, because a dry run that lied about convergence is the failure this exists
 * to close.
 */
async function assertConverged<Row>(
  definition: BackfillDefinition<Row>,
  ctx: JobRunArgs<BackfillInput>['ctx'],
  swept: number,
): Promise<void> {
  if (definition.count === undefined) return;
  const remaining = await definition.count({ ctx });
  if (remaining > 0) {
    throw new BackfillStalledError({ backfill: definition.name, remaining, swept });
  }
}

/**
 * The pass itself: one `step.run` per batch, named by position so a replay finds it. Completed
 * steps are served from storage without touching the database, so a resumed attempt walks its own
 * history to the last checkpoint and opens the source there.
 */
export async function backfillPass<Row>(
  plan: BackfillPlan<Row>,
  args: JobRunArgs<BackfillInput>,
): Promise<BackfillReport> {
  const { definition, size, checksum, pace } = plan;
  const { ctx, step, runId } = args;
  const name = definition.name;
  // Before the ledger is even opened: a sweep this deploy may not run must leave no row saying it
  // started. Enforced here and not only in `x db backfill`, because app code that calls
  // `.enqueue()` directly never passes through a command — a rail only the CLI holds is a
  // convention (axiom 3). No ledger row, so the queue's own retry/dead-letter path is what an
  // operator reads, exactly as it is for any other permanently-failing job.
  // `resolveEnvironment()` is asked ONLY when a declaration named environments: it throws on a
  // typo'd `ULTIMATE_ENV`, which is core's contract for its own key — but a sweep that declared
  // nothing must not start failing over a variable it never reads.
  const declaredEnvironments = definition.environments;
  if (declaredEnvironments !== undefined && declaredEnvironments.length > 0) {
    const mismatch = checkBackfillEnvironment(name, declaredEnvironments, resolveEnvironment());
    if (mismatch !== undefined) throw mismatch;
  }
  // Absent on a driver that ships no ledger, which runs the pass with no bookkeeping rather than
  // refusing it — the same degradation `introspect` already has.
  const ledger = jobDriver()?.backfills;

  const previous = await completedRun(ledger, name);
  const verdict = decideBackfill(previous, checksum, args.input.force === true);
  if (!verdict.run) {
    if (verdict.changed) {
      // A warning and never a refusal, unlike `@ultimat3/db`'s `auditLedger`: this checksum is
      // over function source text, which a bundler can move without a line of behaviour changing.
      logger.warn('jobs.backfill.definition-changed', {
        backfill: name,
        completedAs: previous?.checksum,
        now: checksum,
        fix: `enqueue ${name} with { force: true } to sweep again under the new definition`,
      });
    }
    logger.info('jobs.backfill.skipped', { backfill: name, completedBy: previous?.runId });
    return {
      name,
      batches: 0,
      rows: 0,
      skipped: true,
      ...(previous === undefined ? {} : { previousRunId: previous.runId }),
    };
  }
  await ledger?.start({ runId, name, checksum, appVersion: appVersion() });

  let cursor: string | null = null;
  let rows = 0;
  let batches = 0;
  let live: Iteration<Row> | undefined;

  /**
   * The iteration positioned at `cursor`, opened on the first batch this attempt actually runs so
   * a resumed pass sends no statement for a page it already handled.
   *
   * `batches.cursor` IS where the next statement starts, so comparing it with the checkpoint's is
   * the whole staleness test — and it is not academic: `retryFromStep` re-opens ONE step in the
   * middle of a finished run, which moves the checkpoints somewhere this iteration is not. Rebuilt
   * from the checkpoint rather than read from wherever the old one was parked.
   */
  const iterate = async (): Promise<Iteration<Row>> => {
    if (live !== undefined && live.batches.cursor === cursor) return live;
    await live?.batches.close();
    const opened = definition.source({ ctx }).after(cursor).inBatches(size);
    live = { batches: opened, pull: opened[Symbol.asyncIterator]() };
    return live;
  };

  try {
    for (let index = 0; ; index += 1) {
      const stepName = `${STEP_PREFIX}${index}`;
      const checkpoint = asCheckpoint(
        await step.run(stepName, async (signal): Promise<Checkpoint> => {
          // INSIDE the body, which is the whole of it: a completed step is served from storage
          // without its body running, so an attempt resuming at batch 500 replays 500 checkpoints
          // and pays none of their pauses. Paced outside the step, a resumed pass would spend the
          // entire throttle of everything it had already done before touching a new row.
          //
          // The signal is the run's cancellation composed with this step's ceiling, so a cancelled
          // pass unwinds out of the wait instead of sitting in a timer nobody is waiting for.
          await pace.wait({ signal, step: stepName });
          const iteration = await iterate();
          const next = await iteration.pull.next();
          if (next.done === true) return { cursor: null, rows: 0 };
          await definition.handle({ rows: next.value, ctx, signal, index });
          return { cursor: iteration.batches.cursor, rows: next.value.length };
        }),
        stepName,
      );
      rows += checkpoint.rows;
      cursor = checkpoint.cursor;
      // `inBatches()` never yields an empty batch, so rows is what tells a handled page from the
      // one step an exhausted source costs — and what keeps the exhausted step off the ledger,
      // whose last write is `finish` either way.
      if (checkpoint.rows > 0) {
        batches += 1;
        // Absolute, so a replayed batch reports the position it reported the first time.
        await ledger?.progress(runId, { rows, cursor });
      }
      if (cursor === null) break;
    }
    // The source is exhausted; the declaration's own count is the only thing that can say whether
    // that means the work is done. One statement per PASS, not per batch — the question is "did
    // this converge", asked once, where the answer is finally decidable. Inside the `try` so the
    // ledger records the attempt as `failed`: a pass that left rows behind must not write the
    // completed row that stops the next deploy re-running it.
    await assertConverged(definition, ctx, rows);
  } catch (error) {
    // Control flow, not a failure: a suspended run is parked and will be back on this step.
    if (!isStepSuspension(error)) await markFailed(ledger, runId, rows);
    throw error;
  } finally {
    // Whatever the iteration holds belongs to this attempt, and an attempt that failed, was
    // cancelled or finished is done with it either way.
    await live?.batches.close();
  }

  await ledger?.finish(runId, { status: 'completed', rows });
  return { name, batches, rows, skipped: false };
}
