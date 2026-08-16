// J2: the transactional outbox was documented as ON BY DEFAULT and existed in no deployment.
// `SQL_OUTBOX_*` had zero non-test callers, `x_outbox` was never created, and `setJobsFacade` was
// never called — so every `handle.enqueue()` published straight to the driver, outside the
// caller's transaction. What this file pins is the half that makes it transactional: `stage()`
// writes on the CALLER'S connection and nothing else does.

import { describe, expect, test } from 'bun:test';
import type { Tx } from '@ultimat3/entity';
import type { PgExecutor } from './driver-pg';
import { SQL_OUTBOX_CLAIM, SQL_OUTBOX_STAGE } from './driver-pg-sql';
import type { OutboxRecord } from './outbox';
import { createPgOutboxStore } from './outbox-pg';

function recorder(rows: readonly unknown[] = []): PgExecutor & {
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

const tx = (id: string): Tx => ({ id, onRollback: () => undefined });

const record: OutboxRecord = {
  id: 'row-1',
  job: 'chargeCard',
  queue: 'payments',
  input: { orderId: 'o-1' },
  idempotencyKey: 'order:o-1',
  maxAttempts: 3,
  runAt: 1_000,
  stagedAt: 1_000,
  tenantId: 'org-1',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  enqueuedBy: 'user-9',
};

describe('the pg outbox store', () => {
  test('stage() runs on the TRANSACTION executor, never the pool', async () => {
    // The whole guarantee. A stage on the pooled connection commits immediately and independently
    // — the exact "enqueue then rollback" the outbox exists to remove.
    const pool = recorder();
    const transaction = recorder();
    const store = createPgOutboxStore({
      executor: pool,
      txExecutor: () => transaction,
    });

    await store.stage(tx('tx-1'), record);

    expect(pool.calls).toHaveLength(0);
    expect(transaction.calls[0]?.sql).toBe(SQL_OUTBOX_STAGE);
    expect(transaction.calls[0]?.params).toEqual([
      'row-1',
      'chargeCard',
      'payments',
      JSON.stringify({ orderId: 'o-1' }),
      'order:o-1',
      3,
      1_000,
      1_000,
      'org-1',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'user-9',
    ]);
  });

  test('commit() writes NOTHING — the rows committed with the business rows', async () => {
    const pool = recorder();
    const transaction = recorder();
    const store = createPgOutboxStore({ executor: pool, txExecutor: () => transaction });
    const open = tx('tx-1');

    await store.stage(open, record);
    const committed = await store.commit(open);

    expect(committed).toEqual([record]);
    // One statement, the stage. A commit hook would be one more thing between the two writes.
    expect(transaction.calls).toHaveLength(1);
    expect(pool.calls).toHaveLength(0);
  });

  test('rollback() writes nothing either — the ROLLBACK already took the rows', async () => {
    const transaction = recorder();
    const store = createPgOutboxStore({ executor: recorder(), txExecutor: () => transaction });
    const open = tx('tx-1');
    await store.stage(open, record);
    await store.rollback(open);
    expect(transaction.calls).toHaveLength(1);
    // And the bookkeeping is gone, so a later commit of the same token reports nothing.
    expect(await store.commit(open)).toEqual([]);
  });

  test('the relay reads unpublished rows on the POOL, with the trace intact', async () => {
    const pool = recorder([
      {
        id: 'row-1',
        job: 'chargeCard',
        queue: 'payments',
        input: { orderId: 'o-1' },
        idempotency_key: 'order:o-1',
        max_attempts: 3,
        run_at: '1000',
        staged_at: '1000',
        tenant_id: 'org-1',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        enqueued_by: 'user-9',
      },
    ]);
    const store = createPgOutboxStore({ executor: pool, txExecutor: () => pool });

    const claimed = await store.claim(10);

    expect(pool.calls[0]?.sql).toBe(SQL_OUTBOX_CLAIM);
    expect(claimed[0]).toEqual(record);
  });

  test('the claim skips locked rows so two relays do not serialise', () => {
    expect(SQL_OUTBOX_CLAIM).toContain('for update skip locked');
    expect(SQL_OUTBOX_CLAIM).toContain('where published_at is null');
    expect(SQL_OUTBOX_CLAIM).toContain('order by staged_at');
  });
});
