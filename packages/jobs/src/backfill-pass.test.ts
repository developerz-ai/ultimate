// One `backfill()` pass, end to end: every row visited once, a killed attempt resuming on the page
// it stopped at WITHOUT re-reading the ones before it, and a checkpoint that is a cursor rather
// than the rows behind it. The `x_backfills` row the same pass writes is
// `backfill-pass-ledger.test.ts`, off the SAME harness; `backfill.test.ts` owns the declaration,
// `backfill-ledger.test.ts` the ledger on its own and `backfill-throttle.test.ts` the pacing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { memoryRepo, tableFor } from '@ultimat3/entity';
import { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
import { ctx, harness, ORG, type Row, RUN_ID, rows } from './backfill-pass-fixture';
import { resetJobDriver } from './driver';
import { resetJobs } from './job';
import type { StepStore } from './steps';
import { createMemoryStepStore, createStepRunner } from './steps';

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

  test('handle is AT LEAST ONCE: a page whose checkpoint never landed is handed over again', async () => {
    // The window the contract names, and the reason a handler has to be idempotent: `handle`
    // runs INSIDE the step body and the record is written after it returns, so a process killed,
    // cancelled or lease-expired between the two leaves a page that was swept and not recorded.
    // The order is deliberate — checkpointing first would report a page nobody wrote, and a lost
    // page is unrecoverable where a repeated one is the handler's problem.
    const inner = createMemoryStepStore();
    let dropped = false;
    const losesOneCheckpoint: StepStore = {
      ...inner,
      put: async (record) => {
        if (record.name === 'batch:1' && !dropped) {
          dropped = true;
          throw new Error('checkpoint lost');
        }
        await inner.put(record);
      },
    };
    const pass = harness({ batch: 3, store: losesOneCheckpoint });

    await expect(pass.run()).rejects.toThrow('checkpoint lost');
    const report = await pass.run();

    // `batch:1` twice, everything else once: the retry found no record of the page the first
    // attempt had already handed to the body.
    expect(pass.seen).toEqual([
      ['row-0', 'row-10', 'row-20'],
      ['row-30', 'row-40', 'row-50'],
      ['row-30', 'row-40', 'row-50'],
      ['row-60', 'row-70', 'row-80'],
      ['row-90'],
    ]);
    // The report counts checkpoints, never body calls — so the replayed page is not double-counted
    // and `rows` is still the ten rows the table holds.
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
