// Decoding is where a queue quietly lies. Every timestamp column arrives as `number | string` —
// a bigint is a string in every Postgres client — and every absent column arrives as `null`, so a
// decoder that passed either through hands `JobRecord.runAt` a string that compares wrong and
// `tenantId: null` to a tenant guard that only refuses `undefined`.

import { describe, expect, test } from 'bun:test';
import type { BackfillRow, JobRow, StepRow } from './driver-pg-rows';
import { num, toBackfillRun, toJobRecord, toStepRecord } from './driver-pg-rows';

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

  test('a suspended step carries its wake time and the event it waits for, as numbers', () => {
    expect(
      toStepRecord(
        stepRow({
          status: 'suspended',
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
      status: 'suspended',
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
