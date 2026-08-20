// Decoding is where a queue quietly lies. Every timestamp column arrives as `number | string` —
// a bigint is a string in every Postgres client — and every absent column arrives as `null`, so a
// decoder that passed either through hands `JobRecord.runAt` a string that compares wrong and
// `tenantId: null` to a tenant guard that only refuses `undefined`.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { BACKFILL_STATUSES } from './backfill-ledger';
import { JOB_STATES } from './driver';
import type { BackfillRow, JobRow, StepRow } from './driver-pg-rows';
import { num, toBackfillRun, toJobRecord, toStepRecord } from './driver-pg-rows';
import { isStepStatus, STEP_STATUSES } from './steps';

/** Row builders at file scope: the validation block below needs all three. */
const stepRowFor = (overrides: Partial<StepRow> = {}): StepRow => ({
  run_id: 'run-1',
  name: 'charge',
  status: 'completed',
  output: { chargeId: 'ch_1' },
  started_at: '1000',
  completed_at: null,
  wake_at: null,
  event: null,
  correlation_key: null,
  attempts: 1,
  error: null,
  ...overrides,
});

const backfillRowFor = (overrides: Partial<BackfillRow> = {}): BackfillRow => ({
  run_id: 'run-1',
  name: 'sweep',
  checksum: 'aaaa',
  status: 'running',
  app_version: '1.2.0',
  rows_processed: '4200',
  last_cursor: 'id-42',
  started_at: '1000',
  completed_at: null,
  ...overrides,
});

const jobRowFor = (overrides: Partial<JobRow> = {}): JobRow => jobRow(overrides);

const jobRow = (overrides: Partial<JobRow> = {}): JobRow => ({
  id: 'job-1',
  name: 'sendInvite',
  queue: 'mail',
  input: { orgId: 'org-1' },
  idempotency_key: 'invite:org-1',
  run_id: 'run-1',
  attempt: 2,
  max_attempts: 5,
  state: 'running',
  tenant_id: null,
  last_error: null,
  claimed_by: null,
  run_at: '1735700400000',
  visible_at: null,
  created_at: '1735700000000',
  updated_at: 1_735_700_500_000,
  ...overrides,
});

describe('num', () => {
  test('a bigint string becomes a number, because every client hands one back as text', () => {
    expect(num('4200')).toBe(4200);
    expect(num(17)).toBe(17);
  });

  test('an absent count is 0, never NaN — this feeds QueueStats, which a dashboard renders', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });
});

describe('toJobRecord', () => {
  test('every epoch column comes back as a NUMBER, whichever way the client typed it', () => {
    const record = toJobRecord(jobRow());
    expect(record.runAt).toBe(1_735_700_400_000);
    expect(record.createdAt).toBe(1_735_700_000_000);
    expect(record.updatedAt).toBe(1_735_700_500_000);
  });

  test('a null column is ABSENT from the record, never null — a tenant guard tests for undefined', () => {
    const record = toJobRecord(jobRow());
    expect(Object.hasOwn(record, 'tenantId')).toBe(false);
    expect(Object.hasOwn(record, 'lastError')).toBe(false);
    expect(Object.hasOwn(record, 'claimedBy')).toBe(false);
    expect(Object.hasOwn(record, 'visibleAt')).toBe(false);
    expect(record.tenantId).toBeUndefined();
  });

  test('the optional trace columns are absent whether the row said null or omitted them', () => {
    expect(Object.hasOwn(toJobRecord(jobRow()), 'traceparent')).toBe(false);
    const nulled = toJobRecord(jobRow({ traceparent: null, enqueued_by: null }));
    expect(Object.hasOwn(nulled, 'traceparent')).toBe(false);
    expect(Object.hasOwn(nulled, 'enqueuedBy')).toBe(false);
  });

  test('a populated row carries every column across, snake to camel', () => {
    expect(
      toJobRecord(
        jobRow({
          tenant_id: 'org-1',
          last_error: 'smtp timeout',
          claimed_by: 'worker-a',
          visible_at: '1735700460000',
          traceparent: '00-abc-def-01',
          enqueued_by: 'user-7',
        }),
      ),
    ).toEqual({
      id: 'job-1',
      name: 'sendInvite',
      queue: 'mail',
      input: { orgId: 'org-1' },
      idempotencyKey: 'invite:org-1',
      runId: 'run-1',
      attempt: 2,
      maxAttempts: 5,
      state: 'running',
      runAt: 1_735_700_400_000,
      createdAt: 1_735_700_000_000,
      updatedAt: 1_735_700_500_000,
      tenantId: 'org-1',
      lastError: 'smtp timeout',
      claimedBy: 'worker-a',
      visibleAt: 1_735_700_460_000,
      traceparent: '00-abc-def-01',
      enqueuedBy: 'user-7',
    });
  });
});

describe('toStepRecord', () => {
  const stepRow = (overrides: Partial<StepRow> = {}): StepRow => ({
    run_id: 'run-1',
    name: 'charge',
    status: 'completed',
    output: { chargeId: 'ch_1' },
    started_at: '1000',
    completed_at: null,
    wake_at: null,
    event: null,
    correlation_key: null,
    attempts: 1,
    error: null,
    ...overrides,
  });

  test('a step still running has no completedAt KEY, so a replay reads it as unfinished', () => {
    const record = toStepRecord(stepRow());
    expect(record.startedAt).toBe(1000);
    expect(Object.hasOwn(record, 'completedAt')).toBe(false);
    expect(Object.hasOwn(record, 'wakeAt')).toBe(false);
    expect(Object.hasOwn(record, 'event')).toBe(false);
    expect(Object.hasOwn(record, 'correlationKey')).toBe(false);
    expect(Object.hasOwn(record, 'error')).toBe(false);
  });

  // `'waiting'`, not `'suspended'`: `'suspended'` is a JOB state (`JobRecord['state']`), and
  // `StepStatus` is `completed | sleeping | waiting | failed`. `toStepRecord` casts the column
  // with `as`, so the wrong vocabulary flowed through this mapper unchallenged — `steps.ts` writes
  // `'waiting'` for a `waitForEvent` step, and that row is the one carrying all three of
  // `wake_at`, `event` and `correlation_key`.
  test('a waiting step carries its wake time and the event it waits for, as numbers', () => {
    expect(
      toStepRecord(
        stepRow({
          status: 'waiting',
          wake_at: '9000',
          completed_at: '5000',
          event: 'invoice.paid',
          correlation_key: 'org-1',
          error: 'timed out once',
        }),
      ),
    ).toEqual({
      runId: 'run-1',
      name: 'charge',
      status: 'waiting',
      output: { chargeId: 'ch_1' },
      startedAt: 1000,
      attempts: 1,
      completedAt: 5000,
      wakeAt: 9000,
      event: 'invoice.paid',
      correlationKey: 'org-1',
      error: 'timed out once',
    });
  });
});

describe('toBackfillRun', () => {
  test('a still-running pass keeps its cursor as null and omits completedAt', () => {
    const row: BackfillRow = {
      run_id: 'run-1',
      name: 'sweep',
      checksum: 'aaaa',
      status: 'running',
      app_version: '1.2.0',
      rows_processed: '4200',
      last_cursor: 'id-42',
      started_at: '1000',
      completed_at: null,
    };
    const run = toBackfillRun(row);
    // `cursor` is null-BEARING on purpose — it is where the pass got to, and "no cursor yet" is a
    // value a surface prints, unlike `completedAt`, whose absence means "still going".
    expect(run.cursor).toBe('id-42');
    expect(run.rows).toBe(4200);
    expect(Object.hasOwn(run, 'completedAt')).toBe(false);
  });
});

// The three decoders each cast a `text` column onto a closed union — `row.status as
// StepRecord['status']`, `row.state as JobRecord['state']`, `row.status as BackfillStatus`. A cast
// is not a check, and this data crosses a process boundary: the row was written by whatever build
// was deployed when the job was enqueued. `isBackfillStatus` one file over already states the rule
// this broke — "Narrows a string the CLI, MCP or a URL handed over. Never a cast — the list
// decides" — and `toBackfillRun` was the one caller ignoring it.
//
// What a laundered status COSTS is `steps.ts:263`: `if (existing?.status === 'completed')` returns
// the memoized output, and every other value falls through and RE-EXECUTES the step. So a status
// this build cannot read turns "this step already ran" into "run it again" — a second charge on
// `step.run('charge', …)`, in a file whose header promises the welcome email is not sent twice.
describe('a status column is validated, never cast', () => {
  const codeOf = (run: () => unknown): string => {
    try {
      run();
      return 'resolved';
    } catch (error) {
      return isUltimateError(error) ? error.code : String(error);
    }
  };

  test('a step status this build does not know is refused, not passed through', () => {
    // `'suspended'` is a JOB state, never a `StepStatus`. It reached `StepRecord.status` unchanged.
    expect(codeOf(() => toStepRecord(stepRowFor({ status: 'suspended' })))).toBe(
      'X_JOB_ROW_STATUS_UNKNOWN',
    );
    expect(codeOf(() => toStepRecord(stepRowFor({ status: '' })))).toBe('X_JOB_ROW_STATUS_UNKNOWN');
  });

  test('every status the step vocabulary declares still decodes', () => {
    for (const status of STEP_STATUSES) {
      expect(toStepRecord(stepRowFor({ status })).status).toBe(status);
    }
  });

  test('a job state this build does not know is refused', () => {
    expect(codeOf(() => toJobRecord(jobRowFor({ state: 'paused' })))).toBe(
      'X_JOB_ROW_STATUS_UNKNOWN',
    );
    for (const state of JOB_STATES) {
      expect(toJobRecord(jobRowFor({ state })).state).toBe(state);
    }
  });

  test('a backfill status this build does not know is refused', () => {
    expect(codeOf(() => toBackfillRun(backfillRowFor({ status: 'cancelled' })))).toBe(
      'X_JOB_ROW_STATUS_UNKNOWN',
    );
    for (const status of BACKFILL_STATUSES) {
      expect(toBackfillRun(backfillRowFor({ status })).status).toBe(status);
    }
  });

  // The refusal is an instruction: an operator reading it has to learn WHICH column held WHAT, and
  // that the row is almost certainly a newer deploy's, not corruption.
  test('the refusal names the column, the value and the table it came from', () => {
    try {
      toStepRecord(stepRowFor({ status: 'compensated' }));
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      expect(error.cause).toContain('compensated');
      expect(error.cause).toContain('status');
      expect(error.cause).toContain('ultimate_job_steps');
      expect(error.fix).toContain('x jobs');
    }
  });
});

// What a rolling deploy does now, said out loud, because refusing changed it.
//
// A status string only reaches these columns because some build of this framework wrote it, so
// the two directions are not symmetric. N+1 reading N's rows is the normal direction and cannot
// refuse: a release that only ADDS a status still knows every older one, which the first test
// below pins by decoding the whole vocabulary. N reading N+1's row is the rare direction — a
// status added in N+1, seen by a worker still on N — and that one job now fails loudly with
// `X_JOB_ROW_STATUS_UNKNOWN` instead of silently re-running its steps.
describe('two builds sharing one queue', () => {
  test('the older build refuses ONE row and leaves the rest of the queue readable', () => {
    const fromNewerDeploy = stepRowFor({ name: 'compensate', status: 'compensated' });
    const written = STEP_STATUSES.map((status) => stepRowFor({ name: status, status }));

    expect(() => toStepRecord(fromNewerDeploy)).toThrow(/X_JOB_ROW_STATUS_UNKNOWN/);
    // Every row this build did write still decodes: the refusal is per row, not per queue.
    expect(written.map((row) => toStepRecord(row).status)).toEqual([...STEP_STATUSES]);
  });

  // The severity, demonstrated rather than asserted in prose: `stepRun` returns the memoized
  // output only for `'completed'`, so a laundered status is not a cosmetic type hole — it is a
  // step that runs a second time. This is the behaviour the cast used to produce.
  test('a status that is not exactly `completed` is what makes a step re-run', () => {
    const memoized = STEP_STATUSES.filter((status) => status === 'completed');
    const rerun = STEP_STATUSES.filter((status) => status !== 'completed');

    expect(memoized).toEqual(['completed']);
    // Anything outside the vocabulary lands in the second bucket, which is why it may not land.
    expect(rerun).not.toContain('compensated');
    expect(isStepStatus('compensated')).toBe(false);
  });
});
