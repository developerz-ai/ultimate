// One `backfill()` pass, end to end: every row visited once, a killed attempt resuming on the page
// it stopped at WITHOUT re-reading the ones before it, a checkpoint that is a cursor rather than
// the rows behind it, and the `x_backfills` row that reports all of it. The source is a real
// `@ultimat3/entity` chain over a real `memoryRepo`, so the cursors, the keyset paging and
// `inBatches()`'s own refusals are the shipped ones and not a fixture that agrees by construction.
// `backfill.test.ts` owns the declaration; `backfill-ledger.test.ts` owns the ledger on its own.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, logger } from '@ultimat3/core';
import type { BatchIterator, ReadBuilder, Repo } from '@ultimat3/entity';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { BackfillInput } from './backfill';
import { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
import type { BackfillLedger } from './backfill-ledger';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { resetJobs } from './job';
import type { StepRecord, StepStore } from './steps';
import { createMemoryStepStore, createStepRunner, StepSuspension } from './steps';

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
  /** A run id of its own is a NEW pass; the default is a retry of the same one. */
  run(options?: { runId?: string; input?: BackfillInput }): Promise<unknown>;
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
    async run(runOptions = {}) {
      const runId = runOptions.runId ?? RUN_ID;
      const runner = createStepRunner({ runId, jobName: 'backfill', store });
      return handle.run({
        input: runOptions.input ?? {},
        step: runner.step,
        ctx,
        attempt: 1,
        jobId: 'job-1',
        runId,
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

/**
 * The ledger hangs off the installed queue driver, so a test that wants one installs a driver.
 * Every test above this line runs with none — which is the documented degradation, and why the
 * pass and its checkpoints are pinned without one.
 */
const installLedger = (): BackfillLedger => {
  const driver = createMemoryDriver();
  setJobDriver(driver);
  const ledger = driver.backfills;
  if (ledger === undefined) throw new Error('the memory driver must ship a backfill ledger');
  return ledger;
};

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetJobDriver();
});

describe('one pass', () => {
  test('defaults to one statement per DEFAULT_BACKFILL_BATCH rows', async () => {
    const test10 = harness();
    await test10.run();
    // Ten rows, one default-sized batch: the default is what the pass used.
    expect(DEFAULT_BACKFILL_BATCH).toBeGreaterThan(10);
    expect(test10.seen.length).toBe(1);
    expect(test10.watch.reads).toBe(1);
  });

  test('visits every matching row once, in key order, one statement per batch', async () => {
    const pass = harness({ batch: 3 });

    const report = await pass.run();

    expect(pass.seen).toEqual([
      ['row-0', 'row-10', 'row-20'],
      ['row-30', 'row-40', 'row-50'],
      ['row-60', 'row-70', 'row-80'],
      ['row-90'],
    ]);
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10, skipped: false });
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

    expect(report).toEqual({ name: 'nothing-to-do', batches: 0, rows: 0, skipped: false });
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
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10, skipped: false });
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
    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10, skipped: false });
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

describe('the x_backfills ledger', () => {
  test('one pass is one row: running while it sweeps, completed with what it swept', async () => {
    const ledger = installLedger();
    const pass = harness({ batch: 3 });

    await pass.run();

    const runs = await ledger.list({ name: 'rewrite-titles' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: RUN_ID,
      name: 'rewrite-titles',
      status: 'completed',
      rows: 10,
      cursor: null,
      appVersion: 'dev',
    });
    // The definition's own hash, so a later edit is decidable rather than guessed at.
    expect(runs[0]?.checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  test('progress moves with the pass, batch by batch, and survives the failure that stops it', async () => {
    const ledger = installLedger();
    const pass = harness({ batch: 3 });
    pass.failOn = new Set([2]);

    await expect(pass.run()).rejects.toThrow('batch 2 failed');

    const failed = (await ledger.list())[0];
    // Two batches landed before the third threw, and where it stopped is kept.
    expect(failed).toMatchObject({ status: 'failed', rows: 6 });
    expect(typeof failed?.cursor).toBe('string');

    pass.failOn = new Set();
    await pass.run();

    // A retry is the SAME pass: it adopts its own row rather than opening a second one.
    const runs = await ledger.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', rows: 10, cursor: null });
    expect(runs[0]?.startedAt).toBe(failed?.startedAt ?? -1);
  });

  test('a completed name re-enqueued is a no-op with a report', async () => {
    const ledger = installLedger();
    const pass = harness({ batch: 3 });
    await pass.run();
    const readsAfterFirst = pass.watch.reads;
    const seenAfterFirst = pass.seen.length;

    const report = await pass.run({ runId: 'run-backfill-2' });

    expect(report).toEqual({
      name: 'rewrite-titles',
      batches: 0,
      rows: 0,
      skipped: true,
      previousRunId: RUN_ID,
    });
    // No statement, no body call, and no row for a pass that never opened one.
    expect(pass.watch.reads).toBe(readsAfterFirst);
    expect(pass.seen.length).toBe(seenAfterFirst);
    expect(await ledger.list()).toHaveLength(1);
  });

  test('force sweeps again and writes a NEW row, keeping the one it reruns', async () => {
    const ledger = installLedger();
    const pass = harness({ batch: 3 });
    await pass.run();

    const report = await pass.run({ runId: 'run-backfill-2', input: { force: true } });

    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10, skipped: false });
    expect(pass.seen.length).toBe(8);
    const runs = await ledger.list({ name: 'rewrite-titles' });
    expect(runs.map((run) => run.runId)).toEqual(['run-backfill-2', RUN_ID]);
    // History, not an edit of it: both passes stay readable.
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
  });

  test('a definition that moved since the completed pass warns, and still does not run', async () => {
    const ledger = installLedger();
    const first = harness({ batch: 3 });
    await first.run();
    resetJobs();

    // The same durable name, a different body — what editing a shipped backfill looks like.
    const table = tableFor(rows, memoryRepo(rows, SEED));
    const edited = backfill<Row>({
      name: 'rewrite-titles',
      batch: 3,
      source: () => table.where({ orgId: ORG }),
      handle: () => expect.unreachable('a completed name is a no-op until it is forced'),
    });
    const runner = createStepRunner({
      runId: 'run-edited',
      jobName: 'backfill',
      store: first.store,
    });
    const warn = spyOn(logger, 'warn');

    const report = await edited.run({
      input: {},
      step: runner.step,
      ctx,
      attempt: 1,
      jobId: 'job-3',
      runId: 'run-edited',
    });

    const changed = warn.mock.calls.filter(
      (call) => call[0] === 'jobs.backfill.definition-changed',
    );
    warn.mockRestore();
    // A warning and never a refusal: this checksum is over source text, which a bundler moves.
    expect(changed).toHaveLength(1);
    expect(report).toMatchObject({ skipped: true, previousRunId: RUN_ID });
    expect(await ledger.list()).toHaveLength(1);
  });

  test('a suspended pass is parked, not failed', async () => {
    const ledger = installLedger();
    const store = createMemoryStepStore();
    const table = tableFor(rows, memoryRepo(rows, SEED));
    const parked = backfill<Row>({
      name: 'parks-itself',
      batch: 3,
      source: () => table.where({ orgId: ORG }),
      handle: () => {
        throw new StepSuspension({ step: 'batch:0', resumeAt: 1, reason: 'sleep' });
      },
    });
    const runner = createStepRunner({ runId: 'run-parked', jobName: 'backfill', store });

    await expect(
      parked.run({
        input: {},
        step: runner.step,
        ctx,
        attempt: 1,
        jobId: 'job-4',
        runId: 'run-parked',
      }),
    ).rejects.toBeInstanceOf(StepSuspension);

    // Control flow, not a failure: a parked run is coming back to this exact step.
    expect((await ledger.list())[0]).toMatchObject({ status: 'running', rows: 0 });
  });

  test('with no driver installed the pass runs and reports, unblocked and unrecorded', async () => {
    // The documented degradation: a driver that ships no ledger runs backfills with no
    // bookkeeping rather than refusing them — so a completed name has nothing to block on.
    const pass = harness({ batch: 3 });
    await pass.run();

    const report = await pass.run({ runId: 'run-backfill-2' });

    expect(report).toEqual({ name: 'rewrite-titles', batches: 4, rows: 10, skipped: false });
    expect(pass.seen.length).toBe(8);
  });
});
