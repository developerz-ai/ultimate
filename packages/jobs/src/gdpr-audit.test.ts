// `auditedErase` in isolation: the record an erase writes names the JOB primitive — a job ran it,
// not an action — and the run id, never the subject's key. The whole erase: `gdpr.job.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuditRecord } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import { installAuditSink, resetAuditSink } from '@ultimat3/core/adapter';
import { auditedErase } from './gdpr-audit';
import type { StepApi } from './steps-api';

afterEach(() => {
  resetAuditSink();
});

// Only `run` is reached; a replay-free step that calls `fn` once is the whole contract here.
const step = {
  run: async (_name: string, fn: (signal: AbortSignal) => unknown) =>
    fn(new AbortController().signal),
} as unknown as StepApi;

const input = { job: 'gd.erase', subject: 'gd_people', runId: 'run_1', ctx: ctxOf() };

const capture = (): AuditRecord[] => {
  const records: AuditRecord[] = [];
  installAuditSink({ write: (record) => void records.push(record) });
  return records;
};

describe('auditedErase', () => {
  test("records the erase as primitive 'job' on surface 'job'", async () => {
    const records = capture();
    expect(await auditedErase(input, step, async () => 'done')).toBe('done');
    expect(records.map((r) => [r.name, r.primitive, r.surface, r.mutator, r.outcome])).toEqual([
      ['gd.erase', 'job', 'job', false, 'allowed'],
    ]);
    expect(records[0]?.idempotencyKey).toBe('gd.erase:run_1');
  });

  test("a thrown erase is a failed 'job' record, and the erase's error wins", async () => {
    const records = capture();
    const thrown = new RangeError('erase refused');
    await expect(
      auditedErase(input, step, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(records.map((r) => [r.primitive, r.outcome, r.failure?.error])).toEqual([
      ['job', 'failed', thrown],
    ]);
  });
});
