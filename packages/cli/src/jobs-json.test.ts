// The one rule these projections exist to keep: `data` is plain JSON. `undefined` survives an
// object literal and disappears at `JSON.stringify`, so a missing `?? null` is a key that is
// present in the human render and absent from `--json` — the exact drift `--json` promises not to.

import { describe, expect, test } from 'bun:test';
import type { JobRecord } from '@ultimat3/jobs';
import {
  createMemoryDriver,
  inspectBackfills,
  inspectDeadLetters,
  inspectJob,
  inspectQueues,
} from '@ultimat3/jobs';
import type { DrainFailure, DrainSkip } from './jobs-drain';
import {
  backfillToJson,
  deadLetterToJson,
  depthToJson,
  drainFailureToJson,
  drainSkipToJson,
  jobRecordToJson,
  jobTraceToJson,
} from './jobs-json';
import { listJobs } from './jobs-report';

/** Every key that survives `JSON.stringify` — anything holding `undefined` is silently dropped. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const bareRecord = (): JobRecord => ({
  id: 'job_1',
  name: 'send-email',
  queue: 'default',
  input: { to: 'a@b.c' },
  idempotencyKey: 'key-1',
  runId: 'run_1',
  attempt: 1,
  maxAttempts: 3,
  state: 'ready',
  runAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
});

describe('unit · jobRecordToJson', () => {
  test('every absent optional becomes null, so no key vanishes from --json', () => {
    const json = jobRecordToJson(bareRecord());
    expect(json).toEqual(roundTrip(json) as never);
    expect(json).toMatchObject({
      tenantId: null,
      lastError: null,
      claimedBy: null,
      visibleAt: null,
    });
  });

  test('runAt stays the raw epoch, matching the table column exactly', () => {
    expect(jobRecordToJson(bareRecord())).toMatchObject({ runAt: 1_700_000_000_000 });
  });

  test('input is excluded: it is app-defined `unknown`, not something provably JSON-safe', () => {
    const json = jobRecordToJson({ ...bareRecord(), input: () => 'not json' });
    expect(Object.keys(json as Record<string, unknown>)).not.toContain('input');
  });
});

describe('unit · queue projections', () => {
  test('the depth report and dead letters survive a JSON round trip unchanged', async () => {
    const driver = createMemoryDriver();
    await driver.enqueue({
      name: 'send-email',
      queue: 'default',
      input: {},
      idempotencyKey: 'k1',
      maxAttempts: 3,
    });
    const depth = depthToJson(await inspectQueues(driver));
    expect(depth).toEqual(roundTrip(depth) as never);
    expect(depth).toMatchObject({ driver: 'memory' });

    const letters = (await inspectDeadLetters(driver)).map(deadLetterToJson);
    expect(letters).toEqual(roundTrip(letters) as never);
  });

  test('a job trace projects its steps and retry delays as plain JSON', async () => {
    const driver = createMemoryDriver();
    const { id, runId } = await driver.enqueue({
      name: 'checkout',
      queue: 'default',
      input: {},
      idempotencyKey: 'k2',
      maxAttempts: 3,
    });
    await driver.steps.put({
      runId,
      name: 'charge-card',
      status: 'completed',
      output: { ok: true },
      startedAt: 1,
      completedAt: 2,
      attempts: 1,
    });
    const trace = await inspectJob(driver, id);
    const json = jobTraceToJson(trace as NonNullable<typeof trace>);
    expect(json).toEqual(roundTrip(json) as never);
    expect(json).toMatchObject({
      id,
      runId,
      steps: [{ name: 'charge-card', status: 'completed' }],
    });
    expect((await listJobs(driver)).rows).toHaveLength(1);
  });

  test('a job that is not a backfill carries an explicit null, never a missing key', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'send-email',
      queue: 'default',
      input: {},
      idempotencyKey: 'k3',
      maxAttempts: 3,
    });
    const trace = await inspectJob(driver, id);
    const json = jobTraceToJson(trace as NonNullable<typeof trace>);
    expect(json).toEqual(roundTrip(json) as never);
    expect(Object.keys(json as Record<string, unknown>)).toContain('backfill');
    expect(json).toMatchObject({ backfill: null });
  });

  test("a backfill run's progress rides on its own trace, so --json never drops it", async () => {
    const driver = createMemoryDriver();
    const { id, runId } = await driver.enqueue({
      name: 'reindex-posts',
      queue: 'default',
      input: {},
      idempotencyKey: 'k4',
      maxAttempts: 3,
    });
    // The ledger is keyed by run id, which is how `x jobs show <id>` joins the two with no
    // second lookup table — write the row against this job's run and it must come back here.
    await driver.backfills?.start({
      runId,
      name: 'reindex-posts',
      checksum: 'abc123',
      appVersion: '1.2.0',
    });
    await driver.backfills?.progress(runId, { rows: 250, cursor: 'post_250' });

    const trace = await inspectJob(driver, id);
    const json = jobTraceToJson(trace as NonNullable<typeof trace>);

    expect(json).toEqual(roundTrip(json) as never);
    expect(json).toMatchObject({
      backfill: { runId, name: 'reindex-posts', rows: 250, cursor: 'post_250', status: 'running' },
    });
  });
});

describe('unit · backfillToJson', () => {
  test('every absent value is already null at the source, so no key vanishes', async () => {
    const driver = createMemoryDriver();
    await driver.backfills?.start({
      runId: 'run_1',
      name: 'reindex-posts',
      checksum: 'abc123',
      appVersion: '1.2.0',
    });
    const [progress] = await inspectBackfills(driver);
    const json = backfillToJson(progress as NonNullable<typeof progress>);

    expect(json).toEqual(roundTrip(json) as never);
    expect(json).toMatchObject({
      runId: 'run_1',
      name: 'reindex-posts',
      status: 'running',
      checksum: 'abc123',
      appVersion: '1.2.0',
      rows: 0,
      cursor: null,
      completedAt: null,
      durationMs: null,
    });
    // ISO in, ISO out: the projection re-formats no date, because it has no zone to do it with.
    expect(json).toMatchObject({ startedAt: progress?.startedAt ?? 'missing' });
  });
});

describe('unit · drain projections', () => {
  test('a failure carries the finding whole, with docs and at nulled rather than dropped', () => {
    const failure: DrainFailure = {
      id: 'job_1',
      name: 'send-email',
      finding: { code: 'X_NOT_IMPLEMENTED', cause: 'redis', fix: 'use driver: "pg"' },
    };
    const json = drainFailureToJson(failure);
    expect(json).toEqual(roundTrip(json) as never);
    expect(json).toMatchObject({ finding: { docs: null, at: null } });
  });

  test('a skip names the job, its queue, its state and why the drain left it alone', () => {
    const skip: DrainSkip = {
      id: 'job_2',
      name: 'checkout',
      queue: 'billing',
      state: 'delayed',
      reason: 'no lease could be taken',
    };
    expect(drainSkipToJson(skip)).toEqual({
      id: 'job_2',
      name: 'checkout',
      queue: 'billing',
      state: 'delayed',
      reason: 'no lease could be taken',
    });
  });
});
