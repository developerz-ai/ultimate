// `importRows()` — a file in object storage read a page at a time into the app's tables, declared
// as a `job` and NOT as a ninth primitive: the twin of `exportRows()`, a FACTORY over `job()` as
// `backfill()`, `purge()` and `webhook()` are. That is what gives an import `.enqueue()`, the
// worker's cancellation, the dead-letter path, `x jobs show` and a manifest row.
//
// WHY IT IS THE FRAMEWORK'S: the memory bound and the resume. `parse(await disk.get(key))` holds
// the whole upload, and a retried job re-applies every row from zero. What ships is the quote-aware
// record boundary, the byte-offset checkpoint and the per-row error report; which columns mean
// what, and who may import, never do. The pass lives in `import-pass.ts`.

import type { Clock, Ctx } from '@ultimat3/core';
import { assert, liveClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Pacer } from './backfill-rate';
import { backfillPacer } from './backfill-rate';
import type { DurationInput } from './clock';
import type { ExportFormat } from './export-format';
import { EXPORT_FORMATS } from './export-format';
import type { ExportSink } from './export-sink';
import { importPass } from './import-pass';
import type { ImportSource } from './import-source';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';

/** Records per `handle` call: one statement's worth. A page hands over its whole read in these. */
export const DEFAULT_IMPORT_BATCH = 500;
/** Bytes one page reads. The heap bound: a window is held, never the file. */
export const DEFAULT_IMPORT_PAGE_BYTES = 1_024 * 1_024;
/** The longest one record may be. Must stay below `pageBytes`, so every window holds a record. */
export const DEFAULT_IMPORT_MAX_RECORD_BYTES = 64 * 1_024;
/** Refused rows past which the import ends failed. `0` stops at the first bad page. */
export const DEFAULT_IMPORT_MAX_ROW_ERRORS = 1_000;

export interface ImportDefinition<Rec, I> {
  /** REQUIRED, as on `exportRows()`: the queue row, the step trace and every page carry it. */
  readonly name: string;
  /** The payload: a pointer to the file (`{ orgId, uploadKey }`), never its rows. */
  readonly input: StandardSchemaV1<unknown, I>;
  /**
   * REQUIRED, exactly as on `job()`. `handle` runs under it, so a scoped write in a `'none'` import
   * fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED` — deliberately not relaxed: an import writes
   * one file's rows, and the file names no tenant the app did not put in `input`.
   */
  readonly tenant: JobTenant<NoInfer<I>>;
  /** Where the file is — a THUNK, read per page: `source: () => disk('imports')`. */
  readonly source: () => ImportSource;
  /**
   * The file's object key, from the input. `I` and `Rec` are inferred from `input` and `schema`
   * ALONE (`NoInfer` everywhere else), so a helper typed for half the input cannot narrow it.
   */
  key(input: NoInfer<I>): string;
  readonly format: ExportFormat;
  /** The declared columns. A csv header must name exactly these; ndjson keys must be among them. */
  readonly columns: readonly string[];
  /**
   * Each record, keyed by column, through this. A csv record is text, coerced as an HTTP form is
   * (`coerceInput`): an unquoted empty cell is `null`, a quoted `""` is `''`. No formula guard is
   * undone: an import cannot know a leading `'` was the exporter's.
   */
  readonly schema: StandardSchemaV1<unknown, Rec>;
  /**
   * One page of accepted rows. AT LEAST ONCE per page: a page that dies after `handle` and before
   * its checkpoint runs again. `upsertAll` is the idempotent spelling, as for `backfill()`.
   */
  handle(args: {
    readonly rows: readonly NoInfer<Rec>[];
    readonly ctx: Ctx;
    readonly input: NoInfer<I>;
  }): unknown;
  /** Where refused rows are reported: `<prefix>/<runId>/errors-00000.ndjson`, one part per page. */
  readonly errors: { readonly sink: () => ExportSink; prefix(input: NoInfer<I>): string };
  /** Records per `handle` call, never per read. Defaults to `DEFAULT_IMPORT_BATCH`. */
  readonly batch?: number;
  /** Defaults to `DEFAULT_IMPORT_PAGE_BYTES`. */
  readonly pageBytes?: number;
  /** Defaults to `DEFAULT_IMPORT_MAX_RECORD_BYTES`; below `pageBytes`. */
  readonly maxRecordBytes?: number;
  /** Defaults to `DEFAULT_IMPORT_MAX_ROW_ERRORS`. */
  readonly maxRowErrors?: number;
  /** Pages per second. No default, as an export's: omit it for unthrottled. */
  readonly rate?: number;
  readonly clock?: Clock;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** Per attempt: a resumed attempt picks up at the last checkpointed byte offset. */
  readonly timeout?: DurationInput;
}

/** What one completed pass reports — bounded, so `x jobs show` can print it. */
export interface ImportReport {
  readonly name: string;
  readonly key: string;
  /** Where this run's refused rows are: `<errors.prefix>/<runId>`, the parts under it. */
  readonly errorPrefix: string;
  readonly rows: number;
  readonly rejected: number;
  /** Error parts written. */
  readonly parts: number;
  readonly bytes: number;
}

/** Everything fixed at declaration, validated once. Read by `importPass`. */
export interface ImportPlan<Rec, I> {
  readonly definition: ImportDefinition<Rec, I>;
  readonly batch: number;
  readonly pageBytes: number;
  readonly maxRecordBytes: number;
  readonly maxRowErrors: number;
  readonly pace: Pacer | undefined;
}

export function importRows<Rec, I>(definition: ImportDefinition<Rec, I>): JobHandle<I> {
  const name = definition.name;
  const batch = definition.batch ?? DEFAULT_IMPORT_BATCH;
  const pageBytes = definition.pageBytes ?? DEFAULT_IMPORT_PAGE_BYTES;
  const maxRecordBytes = definition.maxRecordBytes ?? DEFAULT_IMPORT_MAX_RECORD_BYTES;
  const maxRowErrors = definition.maxRowErrors ?? DEFAULT_IMPORT_MAX_ROW_ERRORS;
  assert(
    Number.isSafeInteger(batch) && batch >= 1,
    `import "${name}" declares batch: ${String(batch)} — a batch is a whole number of records, at least one`,
    `set batch: ${DEFAULT_IMPORT_BATCH} on importRows("${name}") — the records one page hands handle()`,
  );
  assert(
    Number.isSafeInteger(maxRecordBytes) &&
      Number.isSafeInteger(pageBytes) &&
      maxRecordBytes >= 1 &&
      maxRecordBytes < pageBytes,
    `import "${name}" declares pageBytes: ${String(pageBytes)} and maxRecordBytes: ${String(maxRecordBytes)} — a page must be longer than the longest record, or a record can fill a window with no end in it`,
    `set pageBytes: ${DEFAULT_IMPORT_PAGE_BYTES} and maxRecordBytes: ${DEFAULT_IMPORT_MAX_RECORD_BYTES} on importRows("${name}"), or leave both out`,
  );
  assert(
    Number.isSafeInteger(maxRowErrors) && maxRowErrors >= 0,
    `import "${name}" declares maxRowErrors: ${String(maxRowErrors)}`,
    `set maxRowErrors: ${DEFAULT_IMPORT_MAX_ROW_ERRORS} on importRows("${name}") — a whole number, 0 to stop at the first bad page`,
  );
  assert(
    (EXPORT_FORMATS as readonly string[]).includes(definition.format),
    `import "${name}" declares format: ${String(definition.format)}`,
    `set format to one of ${EXPORT_FORMATS.join(' | ')} on importRows("${name}")`,
  );
  assert(
    definition.columns.length > 0 && new Set(definition.columns).size === definition.columns.length,
    `import "${name}" declares ${definition.columns.length} column(s) and ${new Set(definition.columns).size} distinct one(s)`,
    `declare at least one column on importRows("${name}") and no duplicates — the list is what a csv header must name`,
  );
  const clock = definition.clock ?? liveClock;
  const pace =
    definition.rate === undefined
      ? undefined
      : backfillPacer({ rate: definition.rate, job: name, clock });
  const plan: ImportPlan<Rec, I> = {
    definition,
    batch,
    pageBytes,
    maxRecordBytes,
    maxRowErrors,
    pace,
  };

  return job<I>({
    name,
    input: definition.input,
    // ONE live pass per file, derived rather than declared, as an export's per prefix: two passes
    // over one file would hand every row to `handle` twice and race over every error part.
    idempotencyKey: (input) => `${name}:${definition.key(input)}`,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) => importPass<Rec, I>(plan, args),
  });
}
