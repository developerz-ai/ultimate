// `backfill()` is a factory over `job()`, so what needs pinning here is not that a job exists —
// `job.test.ts` owns that — but the pass: every row visited once, a killed attempt resuming on the
// page it stopped at WITHOUT re-reading the ones before it, and a checkpoint that is a cursor
// rather than the rows behind it. The source is a real `@ultimat3/entity` chain over a real
// `memoryRepo`, so the cursors, the keyset paging and `inBatches()`'s own refusals are the shipped
// ones and not a fixture that agrees with the factory by construction.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, isUltimateError } from '@ultimat3/core';
import type { BatchIterator, ReadBuilder, Repo } from '@ultimat3/entity';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
import { getJob, isJobHandle, resetJobs } from './job';
import type { StepRecord, StepStore } from './steps';
import { createMemoryStepStore, createStepRunner } from './steps';

const rows = entity('backfill_test_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';

/** Sortable ids, ten apart, so the keyset cursor between two pages is a real position. */
const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;

const row = (index: number, orgId: string = ORG): Row => ({
  id: id(index),
  orgId,
  title: `row-${index}`,
});

/** Ten rows for the org under test, two more no pass may ever touch. */
const SEED: readonly Row[] = [
  ...Array.from({ length: 10 }, (_unused, index) => row(index * 10)),
  row(900, OTHER),
  row(910, OTHER),
];

/** What the wrappers below record: statements sent, iterations opened, iterations closed. */
interface Watch {
  reads: number;
  opens: number;
  closes: number;
}

const newWatch = (): Watch => ({ reads: 0, opens: 0, closes: 0 });

/** `cursor` is a getter on the real iterator, so it is forwarded rather than spread-copied. */
const watchedIterator = (iterator: BatchIterator<Row>, watch: Watch): BatchIterator<Row> => {
  const close = async (): Promise<void> => {
    watch.closes += 1;
    await iterator.close();
  };
  return {
    get cursor(): string | null {
      return iterator.cursor;
    },
    [Symbol.asyncIterator]: () => iterator[Symbol.asyncIterator](),
    close,
    [Symbol.asyncDispose]: close,
  };
};

/** `after()` returns a NEW chain, so the wrapper has to survive it — the factory calls both. */
const watchedChain = (chain: ReadBuilder<Row>, watch: Watch): ReadBuilder<Row> => ({
  ...chain,
  after: (cursor) => watchedChain(chain.after(cursor), watch),
  inBatches: (size) => {
    watch.opens += 1;
    return watchedIterator(chain.inBatches(size), watch);
  },
});

const countingRepo = (repo: Repo<Row>, watch: Watch): Repo<Row> => ({
  ...repo,
  findMany: async (args) => {
    watch.reads += 1;
    return repo.findMany(args);
  },
});

interface Harness {
  readonly watch: Watch;
  readonly store: StepStore;
  /** Titles handed to the body, one entry per batch it actually ran. */
  readonly seen: readonly (readonly string[])[];
  /** Every batch index the body should reject on. */
  failOn: ReadonlySet<number>;
  run(): Promise<unknown>;
  steps(): Promise<readonly StepRecord[]>;
}

const RUN_ID = 'run-backfill-1';

const ctx: Ctx = createContext();

/**
 * One backfill over `SEED`, driven through a real step runner rather than a worker: this file is
 * about the pass and its checkpoints, and `execute.ts` already owns what a driver does with the
 * outcome. Every `run()` is a fresh attempt against the SAME store and run id, which is exactly
 * what a retry is.
 */
const harness = (options: { batch?: number; name?: string } = {}): Harness => {
  const watch = newWatch();
  const store = createMemoryStepStore();
  const seen: string[][] = [];
  const table = tableFor(rows, countingRepo(memoryRepo(rows, SEED), watch));
  const state: Harness = {
    watch,
    store,
    seen,
    failOn: new Set<number>(),
    async run() {
      const runner = createStepRunner({ runId: RUN_ID, jobName: 'backfill', store });
      return handle.run({
        input: {},
        step: runner.step,
        ctx,
        attempt: 1,
        jobId: 'job-1',
        runId: RUN_ID,
      });
    },
    steps: () => store.list(RUN_ID),
  };
  const handle = backfill<Row>({
    name: options.name ?? 'rewrite-titles',
    ...(options.batch === undefined ? {} : { batch: options.batch }),
    source: () => watchedChain(table.where({ orgId: ORG }), watch),
    handle: ({ rows: page, index }) => {
      if (state.failOn.has(index)) throw new Error(`batch ${String(index)} failed`);
      seen.push(page.map((entry) => entry.title));
    },
  });
  return state;
};

beforeEach(() => {
  resetJobs();
});

describe('the factory', () => {
  test('returns a registered job handle keyed by the declared name', () => {
    const handle = backfill<Row>({
      name: 'rewrite-titles',
      queue: 'maintenance',
      retry: { attempts: 7, backoff: 'fixed' },
      source: () => tableFor(rows, memoryRepo(rows, SEED)).where({ orgId: ORG }),
      handle: () => undefined,
    });

    expect(isJobHandle(handle)).toBe(true);
    expect(getJob('rewrite-titles')).toBe(handle);
    expect(handle.queue).toBe('maintenance');
    expect(handle.retry.attempts).toBe(7);
    // One live run per name: a second enqueue while the pass is going is the same pass.
    expect(handle.idempotencyKeyFor({})).toBe('rewrite-titles');
  });

  test('refuses a batch size that is not a whole number of rows, where it was written', () => {
    for (const batch of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        backfill<Row>({
          name: `bad-${String(batch)}`,
          batch,
          source: () => tableFor(rows, memoryRepo(rows, SEED)).where({ orgId: ORG }),
          handle: () => undefined,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isUltimateError(thrown)).toBe(true);
      expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT');
      // Refused before `job()` ran, so the name is still free for the corrected definition.
      expect(getJob(`bad-${String(batch)}`)).toBeUndefined();
    }
  });

  test('defaults to one statement per DEFAULT_BACKFILL_BATCH rows', async () => {
    const test10 = harness();
    await test10.run();
    // Ten rows, one default-sized batch: the default is what the pass used.
    expect(DEFAULT_BACKFILL_BATCH).toBeGreaterThan(10);
    expect(test10.seen.length).toBe(1);
    expect(test10.watch.reads).toBe(1);
  });
});

describe('one pass', () => {
  test('visits every matching row once, in key order, one statement per batch', async () => {
    const pass = harness({ batch: 3 });

    const report = await pass.run();

    expect(pass.seen).toEqual([
      ['row-0', 'row-10', 'row-20'],
      ['row-30', 'row-40', 'row-50'],
      ['row-60', 'row-70', 'row-80'],
      ['row-90'],
    ]);
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10 });
    // Four batches, four statements: the exhausted source costs no extra read.
    expect(pass.watch.reads).toBe(4);
    // One iteration for the whole pass, closed once on the way out.
    expect(pass.watch.opens).toBe(1);
    expect(pass.watch.closes).toBe(1);
  });

  test('an empty source is one step, no body call and a zero report', async () => {
    const pass = harness({ batch: 3, name: 'empty-pass' });
    const table = tableFor(rows, memoryRepo(rows, []));
    const empty = backfill<Row>({
      name: 'nothing-to-do',
      batch: 3,
      source: () => table.where({ orgId: ORG }),
      handle: () => expect.unreachable('an empty source has no batch to hand over'),
    });
    const runner = createStepRunner({ runId: RUN_ID, jobName: 'nothing', store: pass.store });

    const report = await empty.run({
      input: {},
      step: runner.step,
      ctx,
      attempt: 1,
      jobId: 'job-2',
      runId: RUN_ID,
    });

    expect(report).toEqual({ name: 'nothing-to-do', batches: 0, rows: 0 });
    expect((await pass.steps()).map((record) => record.name)).toEqual(['batch:0']);
  });

  test('checkpoints a bounded cursor and a count — never the page', async () => {
    const pass = harness({ batch: 3 });

    await pass.run();

    const steps = await pass.steps();
    // Deterministic and positional: a replay finds a step by the name the next attempt mints.
    expect(steps.map((record) => record.name)).toEqual([
      'batch:0',
      'batch:1',
      'batch:2',
      'batch:3',
    ]);
    const checkpoints = steps.map((record) => record.output as Record<string, unknown>);
    for (const [index, output] of checkpoints.entries()) {
      expect(steps[index]?.status).toBe('completed');
      // `steps.ts` retains a completed step's output for the whole run, so a checkpoint carrying
      // its page would hold every row the pass has touched until the job ended.
      expect(Object.keys(output).sort()).toEqual(['cursor', 'rows']);
      expect(typeof output.rows).toBe('number');
      expect(output.cursor === null || typeof output.cursor === 'string').toBe(true);
    }
    // The pass ends because the source did, and that is what the last checkpoint records.
    expect(checkpoints.at(-1)?.cursor).toBeNull();
  });
});

describe('resume', () => {
  test('a failed attempt resumes on its own page and re-reads none before it', async () => {
    const pass = harness({ batch: 3 });
    pass.failOn = new Set([1]);

    await expect(pass.run()).rejects.toThrow('batch 1 failed');

    // Two statements: the batch that worked and the one that failed.
    expect(pass.watch.reads).toBe(2);
    expect(pass.seen).toEqual([['row-0', 'row-10', 'row-20']]);
    expect(pass.watch.closes).toBe(1);

    pass.failOn = new Set();
    const report = await pass.run();

    // Batch 0 came from storage, so the second attempt read three pages, not four.
    expect(pass.watch.reads).toBe(5);
    expect(pass.seen).toEqual([
      ['row-0', 'row-10', 'row-20'],
      ['row-30', 'row-40', 'row-50'],
      ['row-60', 'row-70', 'row-80'],
      ['row-90'],
    ]);
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10 });
  });

  test('a completed pass replays whole: no statement, no body call, the same report', async () => {
    const pass = harness({ batch: 3 });
    const first = await pass.run();

    const readsAfterFirst = pass.watch.reads;
    const second = await pass.run();

    expect(second).toEqual(first);
    expect(pass.watch.reads).toBe(readsAfterFirst);
    expect(pass.watch.opens).toBe(1);
    expect(pass.seen.length).toBe(4);
  });

  test('a step re-opened in the middle rebuilds the iteration at the checkpoint', async () => {
    const pass = harness({ batch: 3 });
    await pass.run();

    // What `retryFromStep` does: drop ONE step so it re-executes, leaving the ones after it
    // memoized. The cursor therefore JUMPS over a page the live iteration never read, and an
    // iteration trusted to be in step with the checkpoints would hand batch 3 the rows of batch 2.
    await pass.store.del(RUN_ID, 'batch:1');
    await pass.store.del(RUN_ID, 'batch:3');
    const readsAfterFirst = pass.watch.reads;
    const seenAfterFirst = pass.seen.length;

    const report = await pass.run();

    expect(pass.seen.slice(seenAfterFirst)).toEqual([['row-30', 'row-40', 'row-50'], ['row-90']]);
    // One statement per re-opened step, and a second iteration because the cursor jumped.
    expect(pass.watch.reads).toBe(readsAfterFirst + 2);
    expect(pass.watch.opens).toBe(3);
    expect(pass.watch.closes).toBe(3);
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10 });
  });

  test('a replayed step that is not a checkpoint fails the run instead of restarting it', async () => {
    const pass = harness({ batch: 3 });
    await pass.run();
    const first = await pass.store.get(RUN_ID, 'batch:0');
    expect(first).toBeDefined();
    // `steps.ts` returns a completed step's output through an unchecked cast, so this is what a
    // run id carrying another job's step under the same name looks like from in here. An absent
    // cursor is not `null`: unchecked, the pass would reopen the source at the top and walk the
    // whole table again, reporting a clean resume.
    if (first !== undefined) await pass.store.put({ ...first, output: { done: true } });
    const readsAfterFirst = pass.watch.reads;

    await expect(pass.run()).rejects.toThrow(/not a backfill checkpoint/);

    expect(pass.watch.reads).toBe(readsAfterFirst);
  });
});
