// One `importRows()` pass: the page loop, its byte-offset checkpoints and the error report. Split
// out of `import.ts` as `export-pass.ts` is out of `export.ts` — that file declares, this runs.
//
// A PAGE IS A STEP. Its output — the next byte offset, the line, two counters, the error part and
// the csv header order — is the checkpoint, so a killed attempt resumes at the byte it stopped on.
// Never the rows: `steps.ts` hands every completed step's output back for the whole run.

import { assert, logger } from '@ultimat3/core';
import { coerceInput, formatPath, validateAsync } from '@ultimat3/schema';
import { JobAbortedError } from './errors';
import { EXPORT_PART_DIGITS } from './export-sink';
import type { ImportPlan, ImportReport } from './import';
import { ImportHeaderMismatchError, ImportTooManyErrorsError } from './import-errors';
import type { RawRecord } from './import-format';
import { readCsvHeader, readImportRecord, splitRecords } from './import-format';
import type { JobRunArgs } from './job';

const STEP_PREFIX = 'page:';
const STAT_STEP = 'stat';

/** `<prefix>/errors-00000.ndjson`, keyed by PAGE index, so a replayed page overwrites its part. */
export const importErrorKey = (prefix: string, page: number): string =>
  `${prefix}/errors-${String(page).padStart(EXPORT_PART_DIGITS, '0')}.ndjson`;

/** One refused row. The line, the field and the rule — NEVER the value the app refused. */
export interface ImportRowError {
  readonly line: number;
  readonly field: string | null;
  readonly code: string;
}

interface Checkpoint {
  readonly offset: number;
  readonly line: number;
  readonly rows: number;
  readonly rejected: number;
  /** The page index whose error part this page wrote, or `null` for a clean page. */
  readonly errorPart: number | null;
  /** The csv header's column order once page 0 read it; carried, never re-read. */
  readonly header: readonly string[] | null;
}

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** `steps.ts` replays through an unchecked `as T`; an offset read wrong re-imports from zero. */
function asCheckpoint(value: unknown, step: string): Checkpoint {
  const offset = fieldOf(value, 'offset');
  const line = fieldOf(value, 'line');
  const rows = fieldOf(value, 'rows');
  const rejected = fieldOf(value, 'rejected');
  const errorPart = fieldOf(value, 'errorPart');
  const header = fieldOf(value, 'header');
  assert(
    typeof offset === 'number' &&
      typeof line === 'number' &&
      typeof rows === 'number' &&
      typeof rejected === 'number' &&
      (errorPart === null || typeof errorPart === 'number') &&
      (header === null || (Array.isArray(header) && header.every((h) => typeof h === 'string'))),
    `step "${step}" replayed a value that is not an import checkpoint`,
    `x jobs show <jobId> --json prints the run's steps — a run whose "${step}" was written by something other than this import has to be retired, not resumed`,
  );
  return { offset, line, rows, rejected, errorPart, header: header as readonly string[] | null };
}

interface Judged<Rec> {
  readonly rows: Rec[];
  readonly errors: ImportRowError[];
  readonly rejected: number;
}

/** Every record of one page through the format and then the schema. */
async function judge<Rec, I>(
  plan: ImportPlan<Rec, I>,
  columns: readonly string[],
  records: readonly RawRecord[],
): Promise<Judged<Rec>> {
  const { format, schema } = plan.definition;
  const rows: Rec[] = [];
  const errors: ImportRowError[] = [];
  let rejected = 0;
  for (const raw of records) {
    const read = readImportRecord(format, columns, raw.text);
    if ('rejected' in read) {
      rejected += 1;
      errors.push({ line: raw.line, field: read.field, code: read.rejected });
      continue;
    }
    // A csv cell is text, exactly the HTTP boundary's problem; ndjson carries real JSON values.
    const value = format === 'csv' ? coerceInput(schema, read.record) : read.record;
    const result = await validateAsync(schema, value);
    if (result.issues === undefined) {
      rows.push(result.value);
      continue;
    }
    rejected += 1;
    for (const issue of result.issues) {
      const field = formatPath(issue.path);
      errors.push({
        line: raw.line,
        field: field === '' ? null : field,
        code: issue.rule ?? 'schema.invalid',
      });
    }
  }
  return { rows, errors, rejected };
}

export async function importPass<Rec, I>(
  plan: ImportPlan<Rec, I>,
  args: JobRunArgs<I>,
): Promise<ImportReport> {
  const { definition, batch, pageBytes, maxRecordBytes, maxRowErrors, pace } = plan;
  const { step, input, ctx } = args;
  const name = definition.name;
  const key = definition.key(input);
  const declaredPrefix = definition.errors.prefix(input);
  assert(
    declaredPrefix.length > 0 && !declaredPrefix.startsWith('/') && !declaredPrefix.includes('..'),
    `import "${name}" errors.prefix() answered "${declaredPrefix}", which is not a key prefix`,
    `return a relative, non-empty prefix from errors.prefix() on importRows("${name}") — "imports/<orgId>/<importId>" is the shape`,
  );

  // Under the RUN: parts are keyed by page index, so a second import of the same file under one
  // prefix would leave the first run's later parts beside its own and read as one report.
  const errorPrefix = `${declaredPrefix}/${args.runId}`;

  // A step, so every attempt reads the file at the length the first one measured.
  const size = await step.run(STAT_STEP, async (): Promise<number> => {
    const object = await definition.source().stat(key);
    assert(
      object !== undefined,
      `import "${name}" found no object at "${key}"`,
      `upload the file to "${key}" before enqueueing importRows("${name}"), or fix key() on the declaration`,
    );
    return object.size;
  });

  let state: Checkpoint = {
    offset: 0,
    line: 1,
    rows: 0,
    rejected: 0,
    errorPart: null,
    header: null,
  };
  let rows = 0;
  let rejected = 0;
  let parts = 0;

  for (let index = 0; state.offset < size; index += 1) {
    const stepName = `${STEP_PREFIX}${index}`;
    const at = state;
    const body = async (signal: AbortSignal): Promise<Checkpoint> => {
      await pace?.wait({ signal, step: stepName });
      const last = Math.min(at.offset + pageBytes, size) - 1;
      const { bytes } = await definition.source().get(key, { range: [at.offset, last] });
      assert(
        bytes.byteLength > 0,
        `import "${name}" read no bytes at offset ${at.offset} of "${key}", which stat measured at ${size}`,
        `x jobs show <jobId> --json, then re-upload "${key}" under a new key — the object changed under a running import`,
      );
      const final = at.offset + bytes.byteLength >= size;
      // The WHOLE window is used, `batch` records at a time: `batch` bounds one `handle` call, never
      // how much of a read is kept, or a file of tiny rows costs one full read per batch.
      let cursor = at.offset;
      let line = at.line;
      let header = at.header;
      let pageRows = 0;
      let pageRejected = 0;
      const errors: ImportRowError[] = [];
      const report = async (): Promise<number | null> => {
        if (errors.length === 0) return null;
        const lines = errors.map((error) => `${JSON.stringify(error)}\n`).join('');
        await definition.errors.sink().put(importErrorKey(errorPrefix, index), encode(lines));
        return index;
      };
      while (cursor < at.offset + bytes.byteLength) {
        const headerNeeded = definition.format === 'csv' && header === null;
        const window = splitRecords({
          subject: name,
          format: definition.format,
          bytes: bytes.subarray(cursor - at.offset),
          offset: cursor,
          line,
          final,
          maxRecordBytes,
          maxRecords: batch + (headerNeeded ? 1 : 0),
        });
        if (window.next === cursor) break;
        cursor = window.next;
        line = window.nextLine;
        let records = window.records;
        if (headerNeeded && records[0] !== undefined) {
          header = readCsvHeader(name, definition.columns, records[0]);
          records = records.slice(1);
        }
        const judged = await judge(plan, header ?? definition.columns, records);
        errors.push(...judged.errors);
        if (rejected + pageRejected + judged.rejected > maxRowErrors) {
          const errorPart = await report();
          throw new ImportTooManyErrorsError({
            import: name,
            rejected: rejected + pageRejected + judged.rejected,
            maxRowErrors,
            rows: rows + pageRows,
            errorPrefix,
            parts: parts + (errorPart === null ? 0 : 1),
          });
        }
        if (judged.rows.length > 0) {
          // Past the deadline this attempt no longer owns the run; its successor re-runs the page.
          if (signal.aborted) throw new JobAbortedError({ job: name, step: stepName });
          await definition.handle({ rows: judged.rows, ctx, input });
        }
        pageRows += judged.rows.length;
        pageRejected += judged.rejected;
      }
      assert(
        cursor > at.offset,
        `import "${name}" made no progress at offset ${at.offset} of "${key}"`,
        `raise pageBytes above maxRecordBytes on importRows("${name}") — a window must be able to hold a whole record`,
      );
      return {
        offset: cursor,
        line,
        rows: pageRows,
        rejected: pageRejected,
        errorPart: await report(),
        header,
      };
    };
    state = asCheckpoint(await step.run(stepName, body), stepName);
    rows += state.rows;
    rejected += state.rejected;
    if (state.errorPart !== null) parts += 1;
  }

  // A file with no first line at all — empty, a BOM, blank lines — has no header to compare, and
  // "zero rows imported" would be a success over a file that never said what it holds.
  if (definition.format === 'csv' && state.header === null) {
    throw new ImportHeaderMismatchError({
      import: name,
      columns: definition.columns,
      missing: definition.columns,
      undeclared: [],
    });
  }

  logger.info('jobs.import.completed', { import: name, key, rows, rejected, parts, bytes: size });
  return { name, key, errorPrefix, rows, rejected, parts, bytes: size };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
