// The outbox claim is a LEASE, and both stores have to answer the same question. Pinned in ONE
// file with the pg statement beside the memory behaviour, the shape `driver-parity.test.ts` uses:
// `for update skip locked` in a BARE select holds its row locks only until that statement ends —
// under autocommit that is before `claim()` resolves — so two relays polling the same table read
// the same unpublished rows and both publish them. The job's idempotency key collapses the repeat
// only while the first job is still live, because the conflict target is a partial index over the
// live states; a repeat that lands after the first job finished inserts a second row.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { PgExecutor } from './driver-pg';
import { SQL_OUTBOX_CLAIM, SQL_OUTBOX_MARK_PUBLISHED, SQL_OUTBOX_RELEASE } from './driver-pg-sql';
import type { OutboxRecord } from './outbox';
import { createMemoryOutboxStore } from './outbox';
import { createPgOutboxStore } from './outbox-pg';

const tx = (id: string): Tx => ({ id, onRollback: () => undefined }) as unknown as Tx;

const row = (id: string, stagedAt: number): OutboxRecord => ({
  id,
  job: 'notifySubscribers',
  queue: 'default',
  input: {},
  idempotencyKey: `notify:${id}`,
  maxAttempts: 3,
  runAt: stagedAt,
  stagedAt,
});

const LEASE_MS = 30_000;

async function committed(clock: ReturnType<typeof frozenClock>, ids: readonly string[]) {
  const store = createMemoryOutboxStore({ clock, claimLeaseMs: LEASE_MS });
  const open = tx('tx-1');
  let stagedAt = 0;
  for (const id of ids) {
    stagedAt += 1;
    await store.stage(open, row(id, stagedAt));
  }
  await store.commit(open);
  return store;
}

describe('the memory store claims a row, it does not merely read it', () => {
  test('a second claim inside the lease window returns NOTHING', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a', 'row-b']);

    const first = await store.claim(10);
    const second = await store.claim(10);

    expect(first.map((record) => record.id)).toEqual(['row-a', 'row-b']);
    // The second relay: same table, 200ms later, nothing published yet. Before the claim was a
    // lease this answered the identical batch and every row was enqueued twice.
    expect(second).toEqual([]);
    // Still pending — claimed is not published, and the relay's backlog gauge must not lie.
    expect(await store.pendingCount()).toBe(2);
  });

  test('a lapsed lease is reclaimable, so a relay that died mid-batch strands nothing', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a']);

    await store.claim(10);
    clock.advance(LEASE_MS - 1);
    expect(await store.claim(10)).toEqual([]);
    clock.advance(1);

    expect((await store.claim(10)).map((record) => record.id)).toEqual(['row-a']);
  });

  test('release() hands the claim back at once, for the batch a failed publish stopped', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a', 'row-b']);

    const claimed = await store.claim(10);
    await store.release?.(claimed.map((record) => record.id));

    // Without this the wedged batch would wait out the whole lease before ANY relay retried it:
    // a pool blip during a failover would become tens of seconds of unpublished, committed work.
    expect((await store.claim(10)).map((record) => record.id)).toEqual(['row-a', 'row-b']);
  });

  test('a published row is gone from the claim whatever its lease said', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a']);

    const [claimed] = await store.claim(10);
    await store.markPublished('row-a', 0, claimed?.claimedBy);
    clock.advance(LEASE_MS * 2);

    expect(await store.claim(10)).toEqual([]);
    expect(await store.pendingCount()).toBe(0);
    expect(store.retained()).toBe(0);
  });
});

describe('a lapsed claimant may not touch the rows a newer one holds', () => {
  test('a stale release does NOT unclaim the batch the new claimant is publishing', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a', 'row-b']);

    // T0 relay A claims. T1 A stalls past the whole window. T2 relay B reclaims and starts
    // publishing. T3 A wakes on a publish failure and hands ITS batch back.
    const a = await store.claim(10);
    clock.advance(LEASE_MS);
    const b = await store.claim(10);
    expect(b.map((record) => record.id)).toEqual(['row-a', 'row-b']);

    await store.release?.(
      a.map((record) => record.id),
      a[0]?.claimedBy,
    );

    // Unfenced, A's release freed rows B is mid-batch on, and relay C claims them: the duplicate
    // publish the lease exists to prevent, reached the long way round.
    expect(await store.claim(10)).toEqual([]);
    expect(await store.pendingCount()).toBe(2);
  });

  test('a stale markPublished does NOT retire a row the new claimant has not published', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a']);

    const a = await store.claim(10);
    clock.advance(LEASE_MS);
    const b = await store.claim(10);

    await store.markPublished('row-a', clock.now().getTime(), a[0]?.claimedBy);

    // Unfenced this loses the row outright: A never published it and B is only about to.
    expect(await store.pendingCount()).toBe(1);
    expect(store.retained()).toBe(1);

    // And the holder's own mark still lands.
    await store.markPublished('row-a', clock.now().getTime(), b[0]?.claimedBy);
    expect(await store.pendingCount()).toBe(0);
  });

  test('the holder may still release its own batch — the fence is ownership, not a freeze', async () => {
    const clock = frozenClock(0);
    const store = await committed(clock, ['row-a']);

    const a = await store.claim(10);
    await store.release?.(['row-a'], a[0]?.claimedBy);

    expect((await store.claim(10)).map((record) => record.id)).toEqual(['row-a']);
  });
});

describe('the claim order is TOTAL, so two relays compose the same batch', () => {
  test('rows sharing a staged_at claim in id order, every time', async () => {
    const clock = frozenClock(0);
    const store = createMemoryOutboxStore({ clock, claimLeaseMs: LEASE_MS });
    const open = tx('tx-1');
    // One transaction: `stagedAt` is stamped once per enqueue from the same clock reading, so
    // every row in it ties. Staged out of id order, which is what makes the tie observable.
    await store.stage(open, row('row-b', 5));
    await store.stage(open, row('row-a', 5));
    await store.commit(open);

    const first = await store.claim(10);
    await store.release?.(
      first.map((record) => record.id),
      first[0]?.claimedBy,
    );
    const second = await store.claim(10);

    // `id` is a UUIDv7 in every real row — minted by `uuid()`, monotonic — so the tiebreak is
    // stage order and not an arbitrary one, and it needs no column that is not already there.
    expect(first.map((record) => record.id)).toEqual(['row-a', 'row-b']);
    expect(second.map((record) => record.id)).toEqual(['row-a', 'row-b']);
  });
});

describe('the pg statement answers the same question', () => {
  test('the claim UPDATES in the same statement that locks — one statement, or no lock at all', () => {
    // The lock and the state change commit together, the CTE shape `SQL_CLAIM` already uses.
    expect(SQL_OUTBOX_CLAIM).toContain('for update skip locked');
    expect(SQL_OUTBOX_CLAIM).toMatch(/update x_outbox\b/);
    expect(SQL_OUTBOX_CLAIM).toContain('set claimed_at = now()');
    // The reclaim window, without which a relay that died mid-batch strands its rows forever.
    expect(SQL_OUTBOX_CLAIM).toContain('claimed_at is null');
    // `update ... returning` has no defined row order and the relay publishes in the order it is
    // handed rows — an app staging `createInvoice` then `chargeCard` in one transaction.
    expect(SQL_OUTBOX_CLAIM.trimEnd().endsWith('order by staged_at, id')).toBe(true);
    // And the same TOTAL key inside the CTE: `staged_at` alone ties for every row staged in one
    // transaction, so which rows a `limit` takes would be the planner's choice, not an order.
    expect(SQL_OUTBOX_CLAIM.match(/order by staged_at, id/g)).toHaveLength(2);
  });

  test('the release is fenced on `published_at is null` AND on the claimant', () => {
    // It may never unclaim a row another pass already published — nor one a NEWER claimant now
    // holds: a relay whose lease lapsed mid-batch would otherwise free rows another is publishing.
    expect(SQL_OUTBOX_RELEASE).toContain('published_at is null');
    expect(SQL_OUTBOX_RELEASE).toContain('set claimed_at = null');
    expect(SQL_OUTBOX_RELEASE).toContain('claimed_by = $2');
  });

  test('the mark is fenced on the claimant too, so a stale relay cannot retire a live row', () => {
    // Marking published is losing the row: the relay that holds it has not published it yet.
    expect(SQL_OUTBOX_MARK_PUBLISHED).toContain('claimed_by = $3');
    expect(SQL_OUTBOX_MARK_PUBLISHED).toContain('published_at is null');
  });

  test('the store passes the lease window and a claimant with the limit', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        calls.push({ sql, params });
        return Promise.resolve([] as readonly R[]);
      },
    };
    const store = createPgOutboxStore({
      executor,
      txExecutor: () => executor,
      claimLeaseMs: LEASE_MS,
      relayId: 'relay-7',
    });

    await store.claim(25);
    await store.release?.(['row-a']);
    await store.markPublished('row-a', 9_000);

    expect(calls[0]).toEqual({ sql: SQL_OUTBOX_CLAIM, params: [25, LEASE_MS, 'relay-7'] });
    // The claimant rides on every mutation, not only on the claim: the fence is in the WHERE.
    expect(calls[1]).toEqual({ sql: SQL_OUTBOX_RELEASE, params: [['row-a'], 'relay-7'] });
    expect(calls[2]).toEqual({
      sql: SQL_OUTBOX_MARK_PUBLISHED,
      params: ['row-a', 9_000, 'relay-7'],
    });
  });

  test('release with no ids issues no statement at all', async () => {
    let queries = 0;
    const executor: PgExecutor = {
      query<R>(): Promise<readonly R[]> {
        queries += 1;
        return Promise.resolve([] as readonly R[]);
      },
    };
    const store = createPgOutboxStore({ executor, txExecutor: () => executor });

    await store.release?.([]);

    expect(queries).toBe(0);
  });
});
