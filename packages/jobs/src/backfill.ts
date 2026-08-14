// `backfill()` — one pass over every row a chain matches, declared as a `job` and NOT as a ninth
// primitive. A backfill is durable background work with an input schema, a retry policy, an
// idempotency key and a queue, which is the definition of a `job` — so this file is a FACTORY over
// `job()`, exactly as `llm()` is one over `action()`. That is what gives a backfill `.enqueue()`,
// the worker's cancellation, the dead-letter path, `x jobs show` and a manifest row without a line
// here, and it is why nothing in the framework grows a ninth kind of thing to hold table sweeps.
//
// What the factory adds is the iteration. `inBatches()` reads the source one statement per page,
// and each page is handled inside its own `step.run`, so an attempt killed mid-pass resumes on the
// page it stopped at instead of reading the table again from the top. What a step persists is the
// CURSOR and the row count, never the page: `steps.ts` hands a completed step's output back for the
// whole run, so checkpointing rows would retain every row of every batch already processed until
// the job ended — the leak that turns a backfill of a large table into an OOM.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { BatchIterator, ReadBuilder } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { JobHandle, JobRunArgs } from './job';
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

/** Every batch is a step, and this is the name it is checkpointed under. See `pass()`. */
const STEP_PREFIX = 'batch:';

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
  /** Batches this pass handled, replayed ones included. */
  readonly batches: number;
  readonly rows: number;
}

/**
 * A backfill's payload is its identity and nothing else. What to visit is declared, so a queue row
 * carries no parameters that could drift from the definition, and a run enqueued last week resumes
 * against today's source rather than a stale copy of it.
 */
export type BackfillInput = Record<string, never>;

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

export function backfill<Row>(definition: BackfillDefinition<Row>): JobHandle<BackfillInput> {
  const size = definition.batch ?? DEFAULT_BACKFILL_BATCH;
  // Refused where it was written. `inBatches()` refuses the same number one statement in, which
  // for a backfill means a dead-lettered job and a stack trace instead of a failing build.
  assert(
    Number.isSafeInteger(size) && size >= 1,
    `backfill "${definition.name}" declares batch: ${String(size)} — a batch is a whole number of rows, at least one`,
    `set batch: ${DEFAULT_BACKFILL_BATCH} on backfill("${definition.name}") — the rows one statement reads and one durable step handles`,
  );

  return job<BackfillInput>({
    name: definition.name,
    input: t.object({}),
    // One live run per name. A second enqueue while the pass is still going is the same pass, and
    // deduping it is what makes "kick it again" safe rather than a second writer on one table.
    idempotencyKey: () => definition.name,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) => pass(definition, size, args),
  });
}

/**
 * The pass itself: one `step.run` per batch, named by position so a replay finds it. Completed
 * steps are served from storage without touching the database, so a resumed attempt walks its own
 * history to the last checkpoint and opens the source there.
 */
async function pass<Row>(
  definition: BackfillDefinition<Row>,
  size: number,
  args: JobRunArgs<BackfillInput>,
): Promise<BackfillReport> {
  const { ctx, step } = args;
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
      const name = `${STEP_PREFIX}${index}`;
      const checkpoint = asCheckpoint(
        await step.run(name, async (signal): Promise<Checkpoint> => {
          const iteration = await iterate();
          const next = await iteration.pull.next();
          if (next.done === true) return { cursor: null, rows: 0 };
          await definition.handle({ rows: next.value, ctx, signal, index });
          return { cursor: iteration.batches.cursor, rows: next.value.length };
        }),
        name,
      );
      rows += checkpoint.rows;
      // `inBatches()` never yields an empty batch, so rows is what tells a handled page from the
      // one step an exhausted source costs.
      if (checkpoint.rows > 0) batches += 1;
      cursor = checkpoint.cursor;
      if (cursor === null) break;
    }
  } finally {
    // Whatever the iteration holds belongs to this attempt, and an attempt that failed, was
    // cancelled or finished is done with it either way.
    await live?.batches.close();
  }

  return { name: definition.name, batches, rows };
}
