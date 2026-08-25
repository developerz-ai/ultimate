// `exportRows()` — a paged read streamed to object storage with a resumable cursor, declared as a
// `job` and NOT as a ninth primitive. An export is durable background work with an input schema, a
// retry policy, an idempotency key and a queue, which is the definition of a `job` — so this file
// is a FACTORY over `job()`, exactly as `backfill()`, `purge()` and `webhook()` are and as `llm()`
// is over `action()`. That is what gives an export `.enqueue()`, the worker's cancellation, the
// dead-letter path, `x jobs show` and a manifest row without a line here.
//
// WHY IT IS THE FRAMEWORK'S: the memory bound. Accumulating a result set before writing it is the
// failure this exists to prevent, and it is the failure every hand-rolled exporter starts with —
// `const all = await repo.all(); await disk.put(key, csv(all))` works on the developer's 200 rows
// and OOM-kills the pod on the customer's two million. What ships is the paging, the checkpoint,
// the one-object-per-page artifact and the csv the reviewer's spreadsheet will not execute. What
// never ships is which columns leave the building, or who may ask for them.
//
// The declaration lives here and the pass lives in `export-pass.ts` — the same split `backfill.ts`
// and `backfill-pass.ts` already have.

import type { Clock, Ctx } from '@ultimat3/core';
import { assert, systemClock } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Pacer } from './backfill-rate';
import { createPacer } from './backfill-rate';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { ExportFormat, ExportRecord } from './export-format';
import { EXPORT_FORMATS } from './export-format';
import { exportPass } from './export-pass';
import type { ExportSink } from './export-sink';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';

/**
 * Rows per statement, per durable step and per part. The same reasoning `DEFAULT_BACKFILL_BATCH`
 * carries: one statement's worth of work a worker can finish inside a lease. Smaller than a
 * backfill's because every page here is also an OBJECT — a page is encoded whole before it is
 * written, so the page size is the heap bound as well as the statement size.
 */
export const DEFAULT_EXPORT_BATCH = 500;

/**
 * The largest a single part may encode to. A heap bound, not a file-size preference: a page of 500
 * rows that are each 2 KB is a megabyte held at once, and a row that is a megabyte of JSON turns
 * the same page into half a gigabyte. Past it the pass refuses (`X_EXPORT_PART_TOO_LARGE`) instead
 * of finding out on a pod with a memory limit.
 */
export const DEFAULT_EXPORT_MAX_PART_BYTES = 8 * 1_024 * 1_024;

export interface ExportDefinition<Row, I> {
  /**
   * REQUIRED, unlike a job's. An export's name is a durable key — the queue row, the step trace and
   * every part's own step all carry it — so it is never left to whichever export name a module used.
   */
  readonly name: string;
  /**
   * The payload, declared by the APP. Unlike `backfill()`, which takes no parameters, an export is
   * always an export OF something: an org, a date range, a saved filter. A pointer, never a record
   * — what to read is resolved from the app's own tables inside `source`.
   */
  readonly input: StandardSchemaV1<unknown, I>;
  /**
   * REQUIRED, exactly as on `job()`, and the security boundary of this whole feature: an export
   * concentrates a tenant's rows into ONE downloadable object, so a pass that runs under the wrong
   * org is the worst shape a cross-tenant read can take.
   *
   * `tenant: 'none'` STRIPS the org and every tenant-scoped read inside the pass then fails closed
   * with `X_TENANCY_ACTOR_ORG_REQUIRED` — which is correct and is deliberately NOT relaxed.
   * `backfill()` gets a cross-tenant scope opened for it (`backfill-scope.ts`) because its lazy
   * chain leaves an author nothing to wrap; an export gets no such grant, and the difference is
   * the direction of the data. A sweep that rewrites every tenant's rows is an operator action
   * with an audit trail; an export that READS every tenant's rows writes them into one artifact
   * somebody can download. Use `'none'` for a table that has no tenant column at all.
   */
  readonly tenant: JobTenant<I>;
  /**
   * The rows to export, as a chain: `({ input }) => db.orders.where({ orgId: input.orgId })`. Read
   * once per attempt and never enqueued, so what a run exports cannot drift from what was declared.
   * `orderBy` is optional — the driver's own total order ends in the primary key, which is what
   * lets every page resume from the last one's cursor.
   */
  source(args: { readonly input: I; readonly ctx: Ctx }): ReadBuilder<Row>;
  /** The artifact's key prefix: `<prefix>/part-00000.csv`, `<prefix>/manifest.json`. */
  prefix(input: I): string;
  readonly format: ExportFormat;
  /**
   * The columns, in order, and the app's alone. Both encoders project through this list, so a
   * `row()` answering a key it does not carry is refused rather than dropped — which is what stops
   * `row: (r) => ({ ...r })` shipping every column the entity gains from the next migration on.
   */
  readonly columns: readonly string[];
  /** One row -> its cells. Where a date gets its explicit zone and a Money its currency. */
  row(record: Row): ExportRecord;
  /** Where the parts land. A `StorageDriver` satisfies this by having the method it already has. */
  readonly sink: ExportSink;
  /** Rows per statement, per step and per part. Defaults to `DEFAULT_EXPORT_BATCH`. */
  readonly batch?: number;
  /** Defaults to `DEFAULT_EXPORT_MAX_PART_BYTES`. */
  readonly maxPartBytes?: number;
  /**
   * Pages per second. NO DEFAULT, which is where an export differs from a backfill: that one
   * throttles by default because it competes for WRITE capacity on the rows the app is still
   * serving, and this is a bounded read somebody is usually waiting for. Declare it for an export
   * big enough to matter to the pool; there is no way to spell "unthrottled" except by omitting it.
   */
  readonly rate?: number;
  /** The clock the manifest's `completedAt` and the pacer are read from. */
  readonly clock?: Clock;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** Per attempt, not per pass: a resumed attempt picks up at the last checkpoint. */
  readonly timeout?: DurationInput;
}

/** What one completed pass reports — bounded, so `x jobs show` can print it. */
export interface ExportReport {
  readonly name: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly parts: number;
  readonly rows: number;
  readonly bytes: number;
}

/** Everything fixed at declaration, validated and built once. Read by `exportPass`. */
export interface ExportPlan<Row, I> {
  readonly definition: ExportDefinition<Row, I>;
  readonly size: number;
  readonly maxPartBytes: number;
  /** Absent unless a `rate` was declared — see `ExportDefinition.rate`. */
  readonly pace: Pacer | undefined;
  nowMs(): number;
}

export function exportRows<Row, I>(definition: ExportDefinition<Row, I>): JobHandle<I> {
  const size = definition.batch ?? DEFAULT_EXPORT_BATCH;
  // Refused where it was written. `inBatches()` refuses the same number one statement in, which for
  // an export means a dead-lettered job and a stack trace instead of a failing build.
  assert(
    Number.isSafeInteger(size) && size >= 1,
    `export "${definition.name}" declares batch: ${String(size)} — a batch is a whole number of rows, at least one`,
    `set batch: ${DEFAULT_EXPORT_BATCH} on exportRows("${definition.name}") — the rows one statement reads, one step checkpoints and one part holds`,
  );
  const maxPartBytes = definition.maxPartBytes ?? DEFAULT_EXPORT_MAX_PART_BYTES;
  assert(
    Number.isSafeInteger(maxPartBytes) && maxPartBytes >= 1,
    `export "${definition.name}" declares maxPartBytes: ${String(maxPartBytes)}, which no part can fit in`,
    `set maxPartBytes: ${DEFAULT_EXPORT_MAX_PART_BYTES} on exportRows("${definition.name}"), or leave it out — the number is the heap one page may occupy`,
  );
  assert(
    (EXPORT_FORMATS as readonly string[]).includes(definition.format),
    `export "${definition.name}" declares format: ${String(definition.format)}`,
    `set format to one of ${EXPORT_FORMATS.join(' | ')} on exportRows("${definition.name}")`,
  );
  // A column list nothing can be projected through is an artifact with no data in it, and both
  // encoders would happily write one — an empty csv row per source row, forever.
  assert(
    definition.columns.length > 0 && new Set(definition.columns).size === definition.columns.length,
    `export "${definition.name}" declares ${definition.columns.length} column(s) and ${new Set(definition.columns).size} distinct one(s)`,
    `declare at least one column on exportRows("${definition.name}") and no duplicates — the list is the csv header and the ndjson key order, and a repeat writes the same cell twice`,
  );
  const clock = definition.clock ?? systemClock;
  // Built at declaration for the reason `backfill()` builds its own there: the interval belongs to
  // the table and the pool, not to whichever attempt holds the run.
  const pace =
    definition.rate === undefined
      ? undefined
      : createPacer({ rate: definition.rate, job: definition.name, clock });

  return job<I>({
    name: definition.name,
    input: definition.input,
    // ONE live pass per artifact, derived rather than declared: two runs writing the same prefix
    // race over every part key, and the loser's bytes win half the objects. It is also why there is
    // no `idempotencyKey` on this declaration — a second spelling of "which artifact is this" is a
    // second answer to the question the key exists to settle.
    idempotencyKey: (input) => `${definition.name}:${definition.prefix(input)}`,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) =>
      exportPass<Row, I>({ definition, size, maxPartBytes, pace, nowMs: () => nowMs(clock) }, args),
  });
}
