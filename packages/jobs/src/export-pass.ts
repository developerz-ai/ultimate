// One `exportRows()` pass: the iteration, its durable checkpoints, and the manifest that closes
// the artifact. Split out of `export.ts` for the reason `backfill-pass.ts` is split out of
// `backfill.ts` — that file declares an export, this one runs it.
//
// THE PAGING IS `backfill-pass.ts`'s, not a second idiom. `inBatches()` reads the source one
// statement per page, each page runs inside its own `step.run`, and what a step persists is the
// CURSOR and two counters, never the page: `steps.ts` hands a completed step's output back for the
// whole run, so checkpointing rows would retain every row already exported until the job ended —
// which is the leak that turns an export of a large table into an OOM.
//
// THE PART KEY IS WHAT MAKES AT-LEAST-ONCE SAFE. A page is named by its INDEX, so a page that ran
// twice rewrites the same object with the same bytes. There is no idempotency argument to make
// about the app's rows and no append anywhere, because a duplicate part cannot be expressed.

import { assert, logger } from '@ultimat3/core';
import type { BatchIterator } from '@ultimat3/entity';
import { JobAbortedError } from './errors';
import type { ExportPlan, ExportReport } from './export';
import { ExportPartTooLargeError } from './export-errors';
import { encodeExportPage } from './export-format';
import type { ExportManifest } from './export-sink';
import { exportManifestKey, exportPartKey } from './export-sink';
import type { JobRunArgs } from './job';

/** Every page is a step, and this is the name it is checkpointed under. */
const STEP_PREFIX = 'page:';
/** The manifest is a step too, so a retry after a written manifest does not write a second one. */
const MANIFEST_STEP = 'manifest';

/** What a page persists: a bounded position and two counters. Never the page. See the header. */
interface Checkpoint {
  /** Where the next page starts; `null` once the source is exhausted. */
  readonly cursor: string | null;
  readonly rows: number;
  readonly bytes: number;
}

interface Iteration<Row> {
  readonly batches: BatchIterator<Row>;
  readonly pull: AsyncIterator<readonly Row[]>;
}

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * `steps.ts` hands a completed step's output back through an unchecked `as T`, so a checkpoint READ
 * from storage is this shape by claim and never by check. Checked here because the failure is
 * silent and expensive in both directions: an absent cursor is not `null`, so the loop would reopen
 * the source at the top and export the whole table a second time into part 0 onward.
 */
function asCheckpoint(value: unknown, step: string): Checkpoint {
  const cursor = fieldOf(value, 'cursor');
  const rows = fieldOf(value, 'rows');
  const bytes = fieldOf(value, 'bytes');
  assert(
    (cursor === null || typeof cursor === 'string') &&
      typeof rows === 'number' &&
      typeof bytes === 'number',
    `step "${step}" replayed ${JSON.stringify(value)}, which is not an export checkpoint`,
    `x jobs show <jobId> --json prints the run's steps — a run id whose "${step}" was written by something other than this export has to be retired, not resumed`,
  );
  return { cursor, rows, bytes };
}

export async function exportPass<Row, I>(
  plan: ExportPlan<Row, I>,
  args: JobRunArgs<I>,
): Promise<ExportReport> {
  const { definition, size, maxPartBytes, pace } = plan;
  const { step, runId, input, ctx } = args;
  const name = definition.name;
  const prefix = definition.prefix(input);
  assert(
    prefix.length > 0 && !prefix.startsWith('/') && !prefix.includes('..'),
    `export "${name}" prefix() answered "${prefix}", which is not a key prefix`,
    `return a relative, non-empty prefix from prefix() on exportRows("${name}") — "exports/<orgId>/<exportId>" is the shape, and a leading slash or a ".." reaches keys this export does not own`,
  );

  let cursor: string | null = null;
  let rows = 0;
  let bytes = 0;
  let parts = 0;
  let live: Iteration<Row> | undefined;

  /**
   * The iteration positioned at `cursor`, opened on the first page this attempt actually runs, so a
   * resumed pass sends no statement for a page it already wrote. `batches.cursor` IS where the next
   * statement starts, so comparing it with the checkpoint's is the whole staleness test.
   */
  const iterate = async (): Promise<Iteration<Row>> => {
    if (live !== undefined && live.batches.cursor === cursor) return live;
    await live?.batches.close();
    const opened = definition.source({ input, ctx }).after(cursor).inBatches(size);
    live = { batches: opened, pull: opened[Symbol.asyncIterator]() };
    return live;
  };

  try {
    for (let index = 0; ; index += 1) {
      const stepName = `${STEP_PREFIX}${index}`;
      const checkpoint = asCheckpoint(
        await step.run(stepName, async (signal): Promise<Checkpoint> => {
          // INSIDE the body, which is the whole of it: a completed step is served from storage
          // without its body running, so an attempt resuming at page 500 replays 500 checkpoints
          // and pays none of their pauses.
          await pace?.wait({ signal, step: stepName });
          const iteration = await iterate();
          const next = await iteration.pull.next();
          if (next.done === true) return { cursor: null, rows: 0, bytes: 0 };
          const body = encodeExportPage({
            subject: name,
            format: definition.format,
            columns: definition.columns,
            records: next.value.map((record) => definition.row(record)),
            // Part 0 only: the header belongs in the file once, and every line in both formats
            // ends in a newline, so the parts concatenate into one valid file.
            header: index === 0,
          });
          if (body.byteLength > maxPartBytes) {
            throw new ExportPartTooLargeError({
              export: name,
              part: index,
              bytes: body.byteLength,
              maxBytes: maxPartBytes,
            });
          }
          // Asked before the write and not only before the read: past the deadline this attempt no
          // longer owns the run, and `steps.ts` would refuse the checkpoint anyway — so a `put`
          // here is an object written by a worker whose successor is already re-running the page.
          if (signal.aborted) throw new JobAbortedError({ job: name, step: stepName });
          await definition.sink.put(exportPartKey(prefix, index, definition.format), body);
          return {
            cursor: iteration.batches.cursor,
            rows: next.value.length,
            bytes: body.byteLength,
          };
        }),
        stepName,
      );
      rows += checkpoint.rows;
      bytes += checkpoint.bytes;
      cursor = checkpoint.cursor;
      // `inBatches()` never yields an empty page, so `rows` is what tells a written part from the
      // one step an exhausted source costs.
      if (checkpoint.rows > 0) parts += 1;
      if (cursor === null) break;
    }
  } finally {
    // Whatever the iteration holds belongs to this attempt, and an attempt that failed, was
    // cancelled or finished is done with it either way.
    await live?.batches.close();
  }

  const manifestKey = exportManifestKey(prefix);
  // A step of its own, so a retry after the manifest landed does not write a second one — and so
  // that "the artifact is closed" is a checkpoint like every other fact this pass records.
  await step.run(MANIFEST_STEP, async (): Promise<null> => {
    const manifest: ExportManifest = {
      export: name,
      runId,
      prefix,
      format: definition.format,
      columns: [...definition.columns],
      parts,
      rows,
      bytes,
      // `toISOString()` is UTC by definition and carries its zone in the string — the one date in
      // this framework that needs no `timeZone` argument, because it names no locale's calendar.
      completedAt: new Date(plan.nowMs()).toISOString(),
    };
    await definition.sink.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
    return null;
  });

  logger.info('jobs.export.completed', { export: name, prefix, parts, rows, bytes });
  return { name, prefix, manifestKey, parts, rows, bytes };
}
