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

import type { Ctx, Environment } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { backfillChecksum } from './backfill-ledger';
import { backfillPass } from './backfill-pass';
import { createPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';
import type { BackfillCount } from './backfill-registry';
import { stampBackfill } from './backfill-registry';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';

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
   * REQUIRED, exactly as it is on `job()` — a backfill IS a job, so it declares the org its pass
   * runs under rather than inheriting the worker's. A payload carries only `force`, so the two
   * honest spellings are `tenant: () => '<org>'` for a sweep declared against one tenant, and
   * `tenant: 'none'` for one that spans every tenant.
   *
   * `'none'` is where a backfill differs from a plain `job`, and the difference is forced by the
   * shape of `source`: it hands back a LAZY chain, so every page's plan is built inside the
   * iteration — after the declaring frame has closed — and there is nothing an author could wrap
   * in `crossTenant(reason, fn)`. So `backfillPass` opens that scope itself, for a `'none'`
   * declaration only (`backfill-scope.ts`). A declared tenant is handed its context untouched and
   * every page is scoped to that org, exactly as a request would be.
   */
  readonly tenant: JobTenant<BackfillInput>;
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
  /**
   * Batches per second. Defaults to `DEFAULT_BACKFILL_RATE`, which is slow on purpose: this pass
   * shares its pool with the requests the app is still serving. Fractions are a rate too —
   * `rate: 0.5` is one batch every two seconds. To sweep faster raise it; there is no way to
   * turn it off, because a backfill that saturates the pool has no correct value here.
   */
  readonly rate?: number;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** Per attempt, not per pass: a resumed attempt picks up at the last checkpoint. */
  readonly timeout?: DurationInput;
  /**
   * The migration this sweep needs applied first — the id `x db gen` wrote, e.g.
   * `20260814120000_add_publish_at`. Declared DATA, and checked by whoever can read `x_migrations`
   * (`x db backfill`): this package holds no `@ultimat3/db` dependency, and growing one so a queue
   * could read a migration ledger would put the migration engine on tier 3's import graph.
   *
   * Deliberately NOT a `dependsOn` graph over other backfills. The real dependency is almost
   * always "after code that tolerates both shapes is serving", which the framework cannot observe,
   * so a graph would encode an ordering it has no way to be right about.
   */
  readonly requires?: string;
  /**
   * The environments this sweep may run in. Omitted means EVERY one — never an implied
   * "cleanups are production": a staging rehearsal is correct practice, so which deploys a sweep
   * belongs to is the app's convention and this field is only the mechanism that carries it
   * (axiom 8). A mismatch is `X_BACKFILL_ENVIRONMENT`, refused inside the pass as well as by the
   * CLI, because a backfill enqueued by app code never passes through a command.
   */
  readonly environments?: readonly Environment[];
  /**
   * How many rows still match — the SAME predicate `source` selects on, counted rather than read.
   * Optional, and what it buys is that a dry run cannot lie and "did it converge" becomes
   * arithmetic: a pass whose source is exhausted while this still answers above zero has two
   * predicates that disagree, which is `X_BACKFILL_STALLED` and an authoring bug in any business.
   */
  count?(args: { readonly ctx: Ctx }): Promise<number> | number;
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
  const rate = definition.rate ?? DEFAULT_BACKFILL_RATE;
  // Refused in the same voice and for the same reason as `batch` above — except that an unpaced
  // sweep is not a dead-lettered job but a saturated pool, which the app finds out about first.
  assert(
    Number.isFinite(rate) && rate > 0,
    `backfill "${definition.name}" declares rate: ${String(rate)} — a rate is batches per second, greater than zero`,
    `set rate: ${DEFAULT_BACKFILL_RATE} on backfill("${definition.name}"), or leave it out — to sweep faster raise the number, there is no unthrottled mode`,
  );
  // Hashed once, at declaration: the definition cannot change while the process runs, and a hash
  // per attempt would charge every batch of every pass for a fact that is fixed at import.
  // `rate` is NOT in it, for the reason `batch` is not: pacing is a tuning knob, and changing one
  // does not make a completed sweep a different sweep.
  const checksum = backfillChecksum(definition.source, definition.handle);
  // Built here rather than per attempt: the interval belongs to the table and the pool, not to
  // whichever attempt holds the run, so a retrying pass keeps the pace it was declared with.
  const pace = createPacer({ rate, job: definition.name });

  // Bound to the definition rather than passed bare: `count` is declared as a method, so a
  // reference torn off the object literal would run with `this` undefined the first time an
  // author writes `count: ({ ctx }) => this.something`.
  const declaredCount = definition.count;
  const count: BackfillCount | undefined =
    declaredCount === undefined ? undefined : (args) => declaredCount.call(definition, args);

  const handle = job<BackfillInput>({
    name: definition.name,
    input: t.object({ force: t.boolean.optional() }),
    // One live run per name, forced or not. A second enqueue while the pass is still going is the
    // same pass, and deduping it is what makes "kick it again" safe rather than a second writer on
    // one table — which is exactly what a `force` in the key would have allowed.
    idempotencyKey: () => definition.name,
    // Forwarded verbatim, like every other job field this factory carries: a backfill that
    // declared its tenant and then ran under somebody else's would be a factory deciding authz.
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) => backfillPass({ definition, size, checksum, pace }, args),
  });
  // Stamped, never registered by the app: this is what makes a declared-but-never-enqueued sweep
  // visible to `x db backfill --pending`, and the `origin` WeakMap is `task.ts`'s mechanism rather
  // than a second one. `job()` above already refused a duplicate name, so this cannot overwrite.
  stampBackfill(handle, {
    checksum,
    requires: definition.requires,
    environments: definition.environments,
    count,
  });
  return handle;
}
