// J2: the transactional outbox was documented as ON BY DEFAULT and existed in no deployment.
// `SQL_OUTBOX_*` had zero non-test callers, `x_outbox` was never created, and `setJobsFacade` was
// never called — so every `handle.enqueue()` published straight to the driver, outside the
// caller's transaction. What this file pins is the half that makes it transactional: `stage()`
// writes on the CALLER'S connection and nothing else does.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import {
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED_MANY,
  SQL_OUTBOX_STAGE,
  SQL_OUTBOX_STAGE_MANY,
} from './driver-pg-sql';
import type { OutboxRecord } from './outbox';
import { postgresOutboxStore } from './outbox-pg';

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
  runId: 'run-1',
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
    const store = postgresOutboxStore({
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
      'run-1',
      null,
      null,
    ]);
  });

  test('a debounced, expiring row binds both at stage and reads both back from the claim', async () => {
    const transaction = recorder();
    const debounced = { ...record, onConflict: 'replace' as const, expiresAt: 9_000 };
    await postgresOutboxStore({ executor: recorder(), txExecutor: () => transaction }).stage(
      tx('tx-1'),
      debounced,
    );
    expect(transaction.calls[0]?.params.slice(-2)).toEqual(['replace', 9_000]);
    const pool = recorder([
      {
        ...{ id: 'row-1', run_id: 'run-1', job: 'chargeCard', queue: 'payments' },
        ...{ input: { orderId: 'o-1' }, idempotency_key: 'order:o-1', max_attempts: 3 },
        ...{ run_at: '1000', staged_at: '1000', tenant_id: 'org-1', enqueued_by: 'user-9' },
        traceparent: record.traceparent,
        on_conflict: 'replace',
        expires_at: '9000',
      },
    ]);
    const claimed = await postgresOutboxStore({ executor: pool, txExecutor: () => pool }).claim(1);
    expect(claimed[0]).toEqual(debounced);
  });

  test('commit() writes NOTHING — the rows committed with the business rows', async () => {
    const pool = recorder();
    const transaction = recorder();
    const store = postgresOutboxStore({ executor: pool, txExecutor: () => transaction });
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
    const store = postgresOutboxStore({ executor: recorder(), txExecutor: () => transaction });
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
        run_id: 'run-1',
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
    const store = postgresOutboxStore({ executor: pool, txExecutor: () => pool });

    const claimed = await store.claim(10);

    expect(pool.calls[0]?.sql).toBe(SQL_OUTBOX_CLAIM);
    expect(claimed[0]).toEqual(record);
  });

  test('the claim skips locked rows so two relays do not serialise', () => {
    expect(SQL_OUTBOX_CLAIM).toContain('for update skip locked');
    expect(SQL_OUTBOX_CLAIM).toContain('where published_at is null');
    expect(SQL_OUTBOX_CLAIM).toContain('order by staged_at');
  });

  test('stageMany() is ONE statement on the transaction executor, and commit() reports every row', async () => {
    const pool = recorder();
    const transaction = recorder();
    const store = postgresOutboxStore({ executor: pool, txExecutor: () => transaction });
    const second = { ...record, id: 'row-2', input: undefined };
    const open = tx('tx-many');

    await store.stageMany?.(open, [record, second]);
    await store.stageMany?.(open, []);

    expect(pool.calls).toHaveLength(0);
    expect(transaction.calls.map((call) => call.sql)).toEqual([SQL_OUTBOX_STAGE_MANY]);
    const rows = JSON.parse(String(transaction.calls[0]?.params[0])) as Record<string, unknown>[];
    expect(rows.map((row) => [row['id'], row['input']])).toEqual([
      ['row-1', { orderId: 'o-1' }],
      ['row-2', null],
    ]);
    expect((await store.commit(open)).map((row) => row.id)).toEqual(['row-1', 'row-2']);
  });

  test('markPublishedMany() is one fenced statement on the pool, under this relay by default', async () => {
    const pool = recorder();
    const store = postgresOutboxStore({
      executor: pool,
      txExecutor: () => recorder(),
      relayId: 'relay-a',
    });
    await store.markPublishedMany?.(['row-1', 'row-2'], 5_000);
    await store.markPublishedMany?.([], 5_000);
    expect(pool.calls).toEqual([
      { sql: SQL_OUTBOX_MARK_PUBLISHED_MANY, params: [['row-1', 'row-2'], 5_000, 'relay-a'] },
    ]);
    expect(SQL_OUTBOX_MARK_PUBLISHED_MANY).toContain('published_at is null and claimed_by = $3');
  });
});
