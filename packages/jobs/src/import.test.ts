// One `importRows()` pass over a memory step store, the way `export-pass.test.ts` drives an
// export: a killed attempt resumes at its byte offset, no page is handled twice past its
// checkpoint, the error report names lines and rules but never a refused value, and the ceiling
// ends the run with that report written.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { DriverUnavailableError } from './errors';
import { encodeExportPage } from './export-format';
import { memoryExportSink } from './export-sink';
import type { ImportReport } from './import';
import { importRows } from './import';
import { importErrorKey } from './import-pass';
import { memoryImportSource } from './import-source';
import { resetJobs } from './job';
import { type StepStore, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

const COLUMNS = ['id', 'title', 'score'];
const Row = t.object({ id: t.string, title: t.string.max(12), score: t.number.int() });
type Row = { readonly id: string; readonly title: string; readonly score: number };

const ROWS = Array.from({ length: 40 }, (_, n) => ({
  id: `r${String(n).padStart(2, '0')}`,
  title: `title ${n}`,
  score: n,
}));

const csvOf = (records: readonly Record<string, string | number>[]): Uint8Array =>
  encodeExportPage({ subject: 'f', format: 'csv', columns: COLUMNS, records, header: true });

interface Harness {
  readonly store: StepStore;
  readonly sink: ReturnType<typeof memoryExportSink>;
  readonly source: ReturnType<typeof memoryImportSource>;
  /** Every page `handle` was given, as the ids in it. */
  readonly handled: string[][];
  /** Page indexes whose `handle` dies AFTER the write, before the checkpoint. */
  readonly failOn: Set<number>;
  /** One attempt; a different `runId` is a different run of the same import. */
  run(runId?: string): Promise<ImportReport>;
}

let sequence = 0;

const harness = (
  file: Uint8Array,
  over: { maxRowErrors?: number; batch?: number; format?: 'csv' | 'ndjson' } = {},
): Harness => {
  sequence += 1;
  const own = sequence;
  const name = `people-${own}`;
  const store = memoryStepStore();
  const sink = memoryExportSink();
  const source = memoryImportSource({ 'up/people.csv': file });
  const handled: string[][] = [];
  const failOn = new Set<number>();
  const handle = importRows<Row, { readonly key: string }>({
    name,
    input: t.object({ key: t.string }),
    tenant: 'none',
    source: () => source,
    key: ({ key }) => key,
    format: over.format ?? 'csv',
    columns: COLUMNS,
    schema: Row,
    handle: ({ rows }) => {
      handled.push(rows.map((row) => row.id));
      if (failOn.has(handled.length - 1)) {
        failOn.delete(handled.length - 1);
        // INPUT to the code under test — the blip a page dies on after its write — not a verdict.
        throw new DriverUnavailableError({ driver: 'db', cause: 'blip', fix: 'retry' });
      }
    },
    errors: { sink: () => sink, prefix: () => 'imports/errors' },
    batch: over.batch ?? 10,
    pageBytes: 256,
    maxRecordBytes: 128,
    ...(over.maxRowErrors === undefined ? {} : { maxRowErrors: over.maxRowErrors }),
  });
  return {
    store,
    sink,
    source,
    handled,
    failOn,
    run: (runId = `run-${own}`) =>
      handle.run({
        input: { key: 'up/people.csv' },
        step: stepRunner({ runId, jobName: name, store }).step,
        ctx: ctxOf(),
        attempt: 1,
        finalAttempt: false,
        progress: () => undefined,
        jobId: `job-${own}`,
        runId,
      }) as Promise<ImportReport>,
  };
};

const decoded = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

beforeEach(() => {
  resetJobs();
});

describe('importRows', () => {
  test('a file many pages long is read in bounded windows and every row arrives once', async () => {
    const file = csvOf(ROWS);
    const h = harness(file);
    const report = await h.run();
    expect(report).toMatchObject({ rows: 40, rejected: 0, parts: 0, bytes: file.byteLength });
    expect(h.handled.flat()).toEqual(ROWS.map((row) => row.id));
    expect(h.handled.every((page) => page.length <= 10)).toBe(true);
    // The memory bound, mechanically: no read asked for more than `pageBytes`.
    expect(h.source.reads().every(([first, last]) => last - first + 1 <= 256)).toBe(true);
    expect(h.source.reads().length).toBeGreaterThan(1);
  });

  test('a killed attempt resumes at its byte offset and handles no checkpointed page again', async () => {
    const h = harness(csvOf(ROWS));
    h.failOn.add(2);
    try {
      await h.run();
      expect.unreachable('the third page should have died');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_DRIVER_UNAVAILABLE');
    }
    const readsBefore = h.source.reads().length;
    const handledBefore = h.handled.length;
    const report = await h.run();
    expect(report.rows).toBe(40);
    expect(new Set(h.handled.flat())).toEqual(new Set(ROWS.map((row) => row.id)));
    // Page 0 is served from its checkpoint: the resumed attempt never hands its rows over again.
    const resumedIds = h.handled.slice(handledBefore).flat();
    expect(resumedIds).not.toContain('r00');
    expect(resumedIds.length).toBeLessThan(40);
    // The resume READ starts where page 1's checkpoint ended, never at byte zero.
    const resumed = h.source.reads()[readsBefore];
    expect(resumed?.[0]).toBeGreaterThan(0);
  });

  test('a refused row is reported by line, field and rule, and its value never leaves', async () => {
    const secret = 'SSN-123-45-6789-way-too-long';
    const records = ROWS.slice(0, 5).map((row, n) => (n === 3 ? { ...row, title: secret } : row));
    const h = harness(csvOf(records));
    const report = await h.run();
    expect(report).toMatchObject({ rows: 4, rejected: 1, parts: 1 });
    const part = decoded(h.sink.objects().get(importErrorKey(report.errorPrefix, 0)));
    expect(JSON.parse(part)).toEqual({ line: 5, field: 'title', code: 'string.max' });
    expect(part).not.toContain(secret);
    expect(part).not.toContain('SSN');
  });

  test('past maxRowErrors the run ends failed, the crossing page unhandled, the report written', async () => {
    const records = ROWS.slice(0, 15).map((row, n) => (n === 12 ? { ...row, score: 'x' } : row));
    const h = harness(csvOf(records), { maxRowErrors: 0 });
    try {
      await h.run();
      expect.unreachable('a rejected row past the ceiling was accepted');
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
      expect(error.code).toBe('X_IMPORT_TOO_MANY_ERRORS');
      expect(error.meta).toMatchObject({ rejected: 1, rows: 10, parts: 1 });
      const prefix = (error.meta as { errorPrefix: string }).errorPrefix;
      expect(
        [...h.sink.objects().keys()].filter((key) => key.startsWith(`${prefix}/`)),
      ).toHaveLength(1);
    }
    // The batch holding row 12 is never handed to `handle`; the batch before it was.
    expect(h.handled.flat()).toEqual(ROWS.slice(0, 10).map((row) => row.id));
  });

  test('each run reports under its own run id, so a re-import never mixes parts', async () => {
    const records = ROWS.map((row, n) => (n % 7 === 0 ? { ...row, score: 'x' } : row));
    const h = harness(csvOf(records));
    const first = await h.run('run-a');
    const second = await h.run('run-b');
    expect(first.errorPrefix).toBe('imports/errors/run-a');
    expect(second.errorPrefix).toBe('imports/errors/run-b');
    const under = (prefix: string): string[] =>
      [...h.sink.objects().keys()].filter((key) => key.startsWith(`${prefix}/`));
    expect(under(first.errorPrefix)).toHaveLength(first.parts);
    expect(under(second.errorPrefix)).toHaveLength(second.parts);
    expect(first.parts).toBeGreaterThan(0);
  });

  test('the ceiling is a count, so rejections under it complete the run', async () => {
    const records = ROWS.slice(0, 15).map((row, n) => (n % 5 === 0 ? { ...row, score: 'x' } : row));
    const report = await harness(csvOf(records), { maxRowErrors: 3 }).run();
    expect(report).toMatchObject({ rows: 12, rejected: 3, parts: 1 });
  });

  test('a renamed header column stops the run before any row is handled', async () => {
    const file = new TextEncoder().encode('id,headline,score\nr1,a,1\n');
    const h = harness(file);
    try {
      await h.run();
      expect.unreachable('a header naming an undeclared column was accepted');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_IMPORT_HEADER_MISMATCH');
    }
    expect(h.handled).toEqual([]);
  });

  test('a csv with no header line at all is a header mismatch, never an empty success', async () => {
    for (const file of ['', '\uFEFF', '\n\r\n\n']) {
      const h = harness(new TextEncoder().encode(file));
      try {
        await h.run();
        expect.unreachable(`${JSON.stringify(file)} imported as zero rows`);
      } catch (error) {
        expect(isUltimateError(error) && error.code).toBe('X_IMPORT_HEADER_MISMATCH');
        expect(isUltimateError(error) && error.meta).toMatchObject({ missing: COLUMNS });
      }
    }
  });

  test('ndjson imports with no header and its real JSON types', async () => {
    const file = encodeExportPage({
      subject: 'f',
      format: 'ndjson',
      columns: COLUMNS,
      records: ROWS.slice(0, 12),
      header: true,
    });
    const h = harness(file, { format: 'ndjson' });
    expect(await h.run()).toMatchObject({ rows: 12, rejected: 0 });
    expect(h.handled.flat()).toHaveLength(12);
  });

  test('a missing object is refused with the key it looked for', async () => {
    const h = harness(new Uint8Array());
    const run = importRows<Row, { key: string }>({
      name: 'people-missing',
      input: t.object({ key: t.string }),
      tenant: 'none',
      source: () => h.source,
      key: () => 'nowhere.csv',
      format: 'csv',
      columns: COLUMNS,
      schema: Row,
      handle: () => undefined,
      errors: { sink: () => h.sink, prefix: () => 'e' },
    });
    await expect(
      run.run({
        input: { key: 'x' },
        step: stepRunner({ runId: 'r', jobName: 'people-missing', store: h.store }).step,
        ctx: ctxOf(),
        attempt: 1,
        finalAttempt: false,
        progress: () => undefined,
        jobId: 'j',
        runId: 'r',
      }),
    ).rejects.toThrow(/nowhere\.csv/);
  });
});

describe('bytes read are the file, not pages times pageBytes', () => {
  test('a file of tiny records costs about one read and one step per pageBytes', async () => {
    // 20,000 two-byte records: `batch` (10) caps a HANDLE call, never how much of a read is used.
    const text = `id\n${'a\n'.repeat(20_000)}`;
    const file = new TextEncoder().encode(text);
    const source = memoryImportSource({ k: file });
    const store = memoryStepStore();
    let rows = 0;
    let calls = 0;
    const handle = importRows<{ id: string }, Record<string, never>>({
      name: 'tiny-records',
      input: t.object({}),
      tenant: 'none',
      source: () => source,
      key: () => 'k',
      format: 'csv',
      columns: ['id'],
      schema: t.object({ id: t.string }),
      handle: ({ rows: page }) => {
        calls += 1;
        rows += page.length;
        expect(page.length).toBeLessThanOrEqual(10);
      },
      errors: { sink: () => memoryExportSink(), prefix: () => 'e' },
      batch: 10,
      pageBytes: 4_096,
      maxRecordBytes: 128,
    });
    await handle.run({
      input: {},
      step: stepRunner({ runId: 'tiny', jobName: 'tiny-records', store }).step,
      ctx: ctxOf(),
      attempt: 1,
      finalAttempt: false,
      progress: () => undefined,
      jobId: 'tiny',
      runId: 'tiny',
    });
    expect(rows).toBe(20_000);
    const pages = Math.ceil(file.byteLength / (4_096 - 128));
    // `batch` splits a page into handle calls; a window's tail batch is the only short one.
    expect(calls).toBeLessThanOrEqual(2_000 + pages);
    const read = source.reads().reduce((total, [first, last]) => total + last - first + 1, 0);
    // Measured: 40,003 bytes in 10 reads. Before, 2,001 reads of 4 KiB — 8.2 MB for a 40 KB file.
    expect(source.reads().length).toBeLessThanOrEqual(pages + 1);
    expect(read).toBeLessThanOrEqual(file.byteLength + pages * 128);
  });
});

describe('the declaration', () => {
  const declare = (over: Record<string, unknown>) => () => {
    sequence += 1;
    return importRows({
      name: `bad-${sequence}`,
      input: t.object({}),
      tenant: 'none',
      source: () => memoryImportSource({}),
      key: () => 'k',
      format: 'csv',
      columns: ['a'],
      schema: t.object({ a: t.string }),
      handle: () => undefined,
      errors: { sink: () => memoryExportSink(), prefix: () => 'e' },
      ...over,
    });
  };

  test('a page no longer than its longest record is refused where it is written', () => {
    expect(declare({ pageBytes: 100, maxRecordBytes: 100 })).toThrow(/longer than the longest/);
    expect(declare({ batch: 0 })).toThrow(/at least one/);
    expect(declare({ maxRowErrors: -1 })).toThrow(/maxRowErrors/);
    expect(declare({ columns: ['a', 'a'] })).toThrow(/1 distinct/);
    expect(declare({ format: 'xml' })).toThrow(/format/);
  });
});
