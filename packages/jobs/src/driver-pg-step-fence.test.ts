// `SQL_STEP_PUT`'s fence, at the pg store: a write made under a claim binds that claim, and the
// statement answering no row is the claim having been taken — `X_JOB_LEASE_LOST`, never a silent
// overwrite. The behaviour on a real database is `driver-answers-fixture.ts`, on both drivers.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import { SQL_STEP_PUT } from './driver-pg-sql';

const STEP = {
  runId: 'run-1',
  name: 'charge',
  status: 'completed',
  startedAt: 1,
  attempts: 1,
} as const;
const FENCE = { job: 'chargeCard', jobId: 'job-1', workerId: 'w1', claim: 2 };

function storeAnswering(rows: readonly unknown[]) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve(rows as readonly R[]);
    },
  };
  return { steps: postgresJobDriver({ executor }).steps, calls };
}

describe('the pg step store fences a write on its claim', () => {
  test('the claim is bound last, and the statement reads it exactly as SQL_ACK does', async () => {
    const { steps, calls } = storeAnswering([{ written: 1 }]);
    await steps.put(STEP, FENCE);
    expect(calls[0]?.sql).toBe(SQL_STEP_PUT);
    expect(calls[0]?.params.slice(11)).toEqual(['job-1', 'w1', 2]);
    expect(SQL_STEP_PUT).toContain("state = 'running' and claimed_by = $13 and claims = $14::int");
  });

  test('no row back under a fence is X_JOB_LEASE_LOST', async () => {
    const { steps } = storeAnswering([]);
    const refused = await steps.put(STEP, FENCE).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('X_JOB_LEASE_LOST');
  });

  test('an unfenced write binds no claim and is never refused: a transfer has no row to hold', async () => {
    const { steps, calls } = storeAnswering([]);
    await steps.put(STEP);
    expect(calls[0]?.params.slice(11)).toEqual([null, null, null]);
  });
});
