// The `x_backfills` row one `backfill()` pass writes, and the decisions taken off it: a running row
// that becomes a completed one, a failure that keeps its cursor, a retry adopting its own row, a
// completed name that blocks a re-enqueue, `force` writing a NEW row and a moved checksum that
// warns without running. Split from `backfill-pass.test.ts` at the file-size ceiling; both drive
// `backfill-pass-fixture.ts`, so the pass under the row here is the pass pinned there.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { memoryRepo, tableFor } from '@ultimat3/entity';
import { backfill } from './backfill';
import {
  ctx,
  harness,
  installLedger,
  ORG,
  type Row,
  RUN_ID,
  rows,
  SEED,
} from './backfill-pass-fixture';
import { resetJobDriver } from './driver';
import { resetJobs } from './job';
import { createMemoryStepStore, createStepRunner, StepSuspension } from './steps';

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetJobDriver();
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
      tenant: 'none',
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
      tenant: 'none',
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

describe('a replayed batch writes no ledger row', () => {
  test('a resumed pass reports only the batches it actually ran', async () => {
    const ledger = installLedger();
    const pass = harness({ batch: 3 });
    pass.failOn = new Set([2]);
    await expect(pass.run()).rejects.toThrow('batch 2 failed');

    const progress = spyOn(ledger, 'progress');
    try {
      pass.failOn = new Set();
      await pass.run();

      // Batches 0 and 1 are served from storage without their bodies running — that is what makes
      // a resume cheap — and the progress write sat OUTSIDE the step, so each of them re-issued an
      // `x_backfills` UPDATE reporting a position the row already held. On a 5M-row sweep killed
      // at batch 4,800 that is 4,800 statements before a new row is read, paid on every attempt
      // and inside the visibility lease the heartbeat is renewing.
      expect(progress.mock.calls.map((call) => call[1].rows)).toEqual([9, 10]);
    } finally {
      progress.mockRestore();
    }

    // The row still ends where the pass ended: progress is absolute, so the first batch that DOES
    // run reports everything behind it, and `finish` writes the total either way.
    expect((await ledger.list())[0]).toMatchObject({ status: 'completed', rows: 10 });
  });
});
