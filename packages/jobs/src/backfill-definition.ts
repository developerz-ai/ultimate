// What `backfill()` takes and answers: the two source shapes (a local chain, a remote page
// function), the scoped variant keyed per input, and the payload a queue row carries. Apart from
// `backfill.ts` so the factory, the pass and the registry read one set of types.

import type { Ctx, Environment } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { RetryPolicy } from './retry';
import type { JobTenant } from './tenant';

export interface BackfillBatch<Row, I = undefined> {
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
  /** The scoped pass's own input — `undefined` for a backfill declaring none. */
  readonly input: I;
}

interface BackfillCommon<Row, I, P> {
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
  readonly tenant: JobTenant<P>;
  /**
   * One page, in the batch's own durable step. Deliberately handed no `step`: a step name minted
   * inside this body would have to be unique across the whole run, and the natural spelling
   * (`step.run('rewrite', …)`) collides with itself on the second batch (`X_STEP_DUPLICATE`).
   *
   * At least once, like every other job body — an attempt cancelled between the last row and the
   * checkpoint replays this page. Write through `upsertAll`, `updateWhere` or an idempotent
   * statement; never `count + 1`.
   */
  handle(batch: BackfillBatch<Row, I>): Promise<void> | void;
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
   * Optional for `pages` too: a remote may not know, and then the stall check is silent.
   * Optional, and what it buys is that a dry run cannot lie and "did it converge" becomes
   * arithmetic: a pass whose source is exhausted while this still answers above zero has two
   * predicates that disagree, which is `X_BACKFILL_STALLED` and an authoring bug in any business.
   */
  count?(args: { readonly ctx: Ctx; readonly input: I }): Promise<number> | number;
}

/** One page of a remote source: its rows, and where the next page starts — `null` ends the pass. */
export interface BackfillPage<Row> {
  readonly rows: readonly Row[];
  readonly next: string | null;
}

/**
 * A remote source, one page per durable step. Only `{ cursor, rows: n }` is checkpointed — never
 * the rows (`backfill-pass.ts`) — so a pass killed mid-page asks for THAT page again and no earlier
 * one. `signal` is the run's cancellation composed with the step's ceiling.
 */
export type BackfillPages<Row, I> = (args: {
  readonly ctx: Ctx;
  readonly cursor: string | null;
  readonly signal: AbortSignal;
  readonly input: I;
}) => Promise<BackfillPage<Row>>;

interface FromSource<Row> {
  /**
   * The rows to visit, as a chain: `() => db.posts.where({ published: true })`, or one narrowed by
   * the run's own context — `({ ctx }) => db.posts.where({ orgId: ctx.actor.orgId })`. Read once
   * per attempt and never enqueued, so what a run visits cannot drift from what was declared.
   * `orderBy` is optional — the driver's own total order ends in the primary key, which is what
   * lets every batch resume from the last one's cursor.
   */
  source(args: { readonly ctx: Ctx }): ReadBuilder<Row>;
  readonly pages?: never;
}

interface FromPages<Row, I> {
  readonly source?: never;
  /** A remote source: exactly one of `source` and `pages` (`X_BACKFILL_SOURCE_INVALID`). */
  readonly pages: BackfillPages<Row, I>;
}

/** An unscoped sweep: one pass per name, over a local chain or a remote page function. */
export type BackfillDefinition<Row> = BackfillCommon<Row, undefined, BackfillInput> &
  (FromSource<Row> | FromPages<Row, undefined>) & {
    readonly input?: never;
    readonly scope?: never;
  };

/**
 * One pass per SCOPE: `sync-invoices` per account. The ledger key and the live idempotency key are
 * `<name>:<scope(input)>`, so two scopes keep two ledgers and never dedupe onto each other. An
 * `input` with no `scope` is `X_BACKFILL_SOURCE_INVALID`.
 */
export type ScopedBackfillDefinition<Row, I> = BackfillCommon<Row, I, ScopedBackfillInput<I>> &
  (FromSource<Row> | FromPages<Row, I>) & {
    readonly input: StandardSchemaV1<unknown, I>;
    scope(input: I): string;
  };

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

/** A scoped pass's payload: the force decision, and the input its scope is derived from. */
export interface ScopedBackfillInput<I> {
  readonly force?: boolean | undefined;
  readonly input: I;
}
