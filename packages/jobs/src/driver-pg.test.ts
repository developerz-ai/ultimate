import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import {
  SQL_ACK,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_HEARTBEAT,
  SQL_JOBS_TABLE,
  SQL_NACK,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { DriverUnavailableError } from './errors';

function recordingExecutor(rows: readonly unknown[] = []): PgExecutor & {
  readonly calls: { sql: string; params: readonly unknown[] }[];
} {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve(rows as readonly R[]);
    },
  };
}

describe('pg queue SQL', () => {
  test('the claim uses FOR UPDATE SKIP LOCKED — without it N workers serialise', () => {
    expect(SQL_CLAIM).toContain('for update skip locked');
    expect(SQL_CLAIM).toContain("set state      = 'running'");
    // Lease reclaim: a crashed worker's job becomes claimable again.
    expect(SQL_CLAIM).toContain("state = 'running' and visible_at <= now()");
    expect(SQL_CLAIM).toContain('attempt    = j.attempt + 1');
  });

  test('idempotency is enforced by a partial unique index over live states only', () => {
    expect(SQL_JOBS_TABLE).toContain(
      'create unique index if not exists x_jobs_idempotency_live_idx',
    );
    expect(SQL_JOBS_TABLE).toContain("where state in ('ready', 'delayed', 'running', 'suspended')");
    expect(SQL_ENQUEUE).toContain('on conflict (idempotency_key)');
    expect(SQL_ENQUEUE).toContain('do nothing');
  });

  test('nack only burns an attempt when the failure counts as one', () => {
    expect(SQL_NACK).toContain(
      'case when $3::boolean then attempt else greatest(attempt - 1, 0) end',
    );
  });

  test('ack and heartbeat target a single row by id', () => {
    expect(SQL_ACK).toContain('where id = $1');
    expect(SQL_HEARTBEAT).toContain("where id = $1 and state = 'running'");
  });

  test('the scheduler leader uses a session advisory lock', () => {
    expect(SQL_TRY_ADVISORY_LOCK).toContain('pg_try_advisory_lock');
  });
});

describe('pg driver', () => {
  test('claim passes the queue list, limit, worker id and visibility timeout in order', async () => {
    const executor = recordingExecutor();
    const driver = createPgDriver({ executor });
    await driver.claim({
      queues: ['default', 'mail'],
      limit: 7,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-a',
    });
    expect(executor.calls[0]?.sql).toBe(SQL_CLAIM);
    expect(executor.calls[0]?.params).toEqual([['default', 'mail'], 7, 'worker-a', 30_000]);
  });

  test('a deduped enqueue reports the existing live row instead of inserting', async () => {
    let call = 0;
    const executor: PgExecutor = {
      query<R>(): Promise<readonly R[]> {
        call += 1;
        // First call: the INSERT ... DO NOTHING returns no row. Second: the live-row lookup.
        const rows = call === 1 ? [] : [{ id: 'job-1', run_id: 'run-1' }];
        return Promise.resolve(rows as unknown as readonly R[]);
      },
    };
    const result = await createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: 'default',
      input: { orgId: 'org-1' },
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
    });
    expect(result).toEqual({ id: 'job-1', runId: 'run-1', deduped: true });
  });

  test('no executor and no DATABASE_URL is a labelled X_DRIVER_UNAVAILABLE', async () => {
    await expect(createPgDriver().stats()).rejects.toThrow(DriverUnavailableError);
  });
});
