// `backfill()` — one pass over every row a chain matches, declared as a `job` and NOT as a ninth
// primitive. A backfill is durable background work with an input schema, a retry policy, an
// idempotency key and a queue, which is the definition of a `job` — so this file is a FACTORY over
// `job()`, exactly as `llm()` is one over `action()`. That is what gives a backfill `.enqueue()`,
// the worker's cancellation, the dead-letter path, `x jobs show` and a manifest row without a line
// here, and it is why nothing in the framework grows a ninth kind of thing to hold table sweeps.
//
// The declaration lives here and the pass lives in `backfill-pass.ts` — the same split `job.ts`
// and `execute.ts` already have, and the reason the iteration, the checkpoints and the
// `x_backfills` ledger are one file's problem rather than this one's.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { backfillChecksum } from './backfill-ledger';
import { backfillPass } from './backfill-pass';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';

/**
 * Rows per statement and per durable step. Not `entity`'s `DEFAULT_PAGE_SIZE`: that number is a
 * page somebody scrolls, and a backfill of a million rows at 50 writes twenty thousand step rows
 * to move the same data. One statement's worth of work that a worker can still finish inside a
 * lease is the size that belongs here.
 */
export const DEFAULT_BACKFILL_BATCH = 1_000;

export interface BackfillBatch<Row> {
  /** The page `page()` would have returned here: tenancy, soft delete, projection, preloads. */
  readonly rows: readonly Row[];
  readonly ctx: Ctx;
  /**
   * The run's cancellation composed with this batch's own ceiling — the same seam `ctx.signal` is
   * elsewhere. Past it this step may no longer write, so hand it to whatever the body calls.
   */
  readonly signal: AbortSignal;
  /** 0-based position in the pass, and the step name this batch is checkpointed under. */
  readonly index: number;
}

export interface BackfillDefinition<Row> {
  /**
   * REQUIRED, unlike a job's. A backfill's name is a durable key — the queue row, the step trace
   * and the ledger of what has already been run all carry it — so it is never left to whichever
   * export name a module happened to use.
   */
  readonly name: string;
  /**
   * The rows to visit, as a chain: `() => db.posts.where({ published: true })`, or one narrowed by
   * the run's own context — `({ ctx }) => db.posts.where({ orgId: ctx.actor.orgId })`. Read once
   * per attempt and never enqueued, so what a run visits cannot drift from what was declared.
   * `orderBy` is optional — the driver's own total order ends in the primary key, which is what
   * lets every batch resume from the last one's cursor.
   */
  source(args: { readonly ctx: Ctx }): ReadBuilder<Row>;
  /**
   * One page, in the batch's own durable step. Deliberately handed no `step`: a step name minted
   * inside this body would have to be unique across the whole run, and the natural spelling
   * (`step.run('rewrite', …)`) collides with itself on the second batch (`X_STEP_DUPLICATE`).
   *
   * At least once, like every other job body — an attempt cancelled between the last row and the
   * checkpoint replays this page. Write through `upsertAll`, `updateWhere` or an idempotent
   * statement; never `count + 1`.
   */
  handle(batch: BackfillBatch<Row>): Promise<void> | void;
  /** Rows per statement and per step. Defaults to `DEFAULT_BACKFILL_BATCH`. */
  readonly batch?: number;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** Per attempt, not per pass: a resumed attempt picks up at the last checkpoint. */
  readonly timeout?: DurationInput;
}

/** What one completed pass reports — bounded, so `x jobs show` can print it. */
export interface BackfillReport {
  readonly name: string;
  /** Batches THIS pass handled, replayed ones included. `0` when it was skipped. */
  readonly batches: number;
  readonly rows: number;
  /** True when `x_backfills` already held a completed pass under this name and `force` was not set. */
  readonly skipped: boolean;
  /** The completed pass the ledger answered with, when there was one. */
  readonly previousRunId?: string | undefined;
}

/**
 * A backfill's payload is its identity plus the one decision a queue row is allowed to carry.
 * What to visit is declared, so nothing here can drift from the definition; `force` changes only
 * whether a name the ledger already records as completed runs a SECOND pass, and never what that
 * pass would do.
 */
export interface BackfillInput {
  /**
   * Run even though `x_backfills` holds a completed pass under this name. The rerun is a NEW
   * ledger row — history is never overwritten, so what each pass swept stays readable.
   */
  readonly force?: boolean | undefined;
}

export function backfill<Row>(definition: BackfillDefinition<Row>): JobHandle<BackfillInput> {
  const size = definition.batch ?? DEFAULT_BACKFILL_BATCH;
  // Refused where it was written. `inBatches()` refuses the same number one statement in, which
  // for a backfill means a dead-lettered job and a stack trace instead of a failing build.
  assert(
    Number.isSafeInteger(size) && size >= 1,
    `backfill "${definition.name}" declares batch: ${String(size)} — a batch is a whole number of rows, at least one`,
    `set batch: ${DEFAULT_BACKFILL_BATCH} on backfill("${definition.name}") — the rows one statement reads and one durable step handles`,
  );
  // Hashed once, at declaration: the definition cannot change while the process runs, and a hash
  // per attempt would charge every batch of every pass for a fact that is fixed at import.
  const checksum = backfillChecksum(definition.source, definition.handle);

  return job<BackfillInput>({
    name: definition.name,
    input: t.object({ force: t.boolean.optional() }),
    // One live run per name, forced or not. A second enqueue while the pass is still going is the
    // same pass, and deduping it is what makes "kick it again" safe rather than a second writer on
    // one table — which is exactly what a `force` in the key would have allowed.
    idempotencyKey: () => definition.name,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) => backfillPass({ definition, size, checksum }, args),
  });
}
