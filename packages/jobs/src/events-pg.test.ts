// J9: `step.waitForEvent` was backed by a process-local memory bus, with a comment saying it is
// "swapped at boot for the NATS/Redis-streams bus". No such bus existed and the production boot
// installed the memory one — so a Stripe webhook landing on web-3 published into web-3's heap and
// the worker resuming on worker-7 re-suspended every 30s until the 24h timeout dead-lettered it.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import {
  SQL_EVENT_FIND,
  SQL_EVENT_LIST,
  SQL_EVENT_NOW,
  SQL_EVENT_PUBLISH,
  SQL_EVENT_PURGE_COUNTED,
} from './driver-pg-sql';
import { eventsPurgeTarget } from './events';
import { createPgEventBus } from './events-pg';

function recorder(rows: readonly unknown[] = []) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve(rows as readonly R[]);
    },
  };
  return { executor, calls };
}

describe('the pg event bus', () => {
  test('a step on ANOTHER process finds an event this one published', async () => {
    // One table, so the pod that publishes and the pod that resumes are never the same heap.
    const { executor } = recorder([{ payload: { invoice: 'in_1' }, published_at: '1000000' }]);
    const bus = createPgEventBus({ executor });

    const hit = await bus.find('invoice.paid', 'org-1', 0);

    expect(hit).toEqual({ payload: { invoice: 'in_1' }, publishedAt: 1_000_000 });
  });

  test('publish sends a TTL and no instant: the database stamps the row, and its stamps come back', async () => {
    const { executor, calls } = recorder([{ published_at: '5000000', expires_at: '8600000' }]);
    const bus = createPgEventBus({ executor, defaultTtl: '1h' });

    const event = await bus.publish('invoice.paid', { invoice: 'in_1' }, { correlationKey: 'o-1' });

    expect(calls[0]?.sql).toBe(SQL_EVENT_PUBLISH);
    // id, name, payload, key, ttl — nothing this process's clock produced.
    expect(calls[0]?.params.slice(1)).toEqual([
      'invoice.paid',
      JSON.stringify({ invoice: 'in_1' }),
      'o-1',
      3_600_000,
    ]);
    expect(SQL_EVENT_PUBLISH).toContain(
      "statement_timestamp() + ($5::bigint * interval '1 millisecond')",
    );
    expect(SQL_EVENT_PUBLISH).not.toContain('to_timestamp');
    expect(event).toMatchObject({
      correlationKey: 'o-1',
      publishedAt: 5_000_000,
      expiresAt: 8_600_000,
    });
  });

  test('now() is the database clock, floored to the millisecond', async () => {
    const { executor, calls } = recorder([{ now: '1790000000123' }]);
    expect(await createPgEventBus({ executor }).now()).toBe(1_790_000_000_123);
    expect(calls[0]?.sql).toBe(SQL_EVENT_NOW);
    expect(SQL_EVENT_NOW).toContain('floor(');
  });

  test("every event statement reads the STATEMENT's time, never the transaction's", () => {
    // `now()` is when the transaction began: a bus on a long transaction's connection stamped an
    // event at its start (`events-pg.live.test.ts` proves it on a server).
    for (const statement of [
      SQL_EVENT_PUBLISH,
      SQL_EVENT_NOW,
      SQL_EVENT_FIND,
      SQL_EVENT_PURGE_COUNTED,
    ]) {
      expect(statement).not.toContain('now()');
      expect(statement).toContain('statement_timestamp()');
    }
  });

  test('the lookup honours order, expiry and the correlation key', () => {
    // Same three rules the memory bus follows, so a step behaves identically on either bus:
    // earliest match at or after the wait began, never an expired one, never another run's.
    expect(SQL_EVENT_FIND).toContain('order by published_at');
    expect(SQL_EVENT_FIND).toContain('expires_at > statement_timestamp()');
    expect(SQL_EVENT_FIND).toContain('published_at >= to_timestamp($3 / 1000.0)');
    expect(SQL_EVENT_FIND).toContain('($2::text is null or correlation_key = $2)');
  });

  test('an unmatched event is `undefined`, which is what re-suspends the step', async () => {
    const { executor } = recorder([]);
    expect(await createPgEventBus({ executor }).find('never.published', undefined, 0)).toBe(
      undefined,
    );
  });
});

describe('the pg event bus, read back and swept', () => {
  test('list() decodes every column and drops a null correlation key rather than keeping it', async () => {
    // A `correlationKey: null` on the record would not equal the memory bus's absent key, and
    // `find` compares them — a run keyed on `undefined` must not match a row keyed on `null`.
    const { executor, calls } = recorder([
      {
        id: 'ev-1',
        name: 'invoice.paid',
        payload: { invoice: 'in_1' },
        correlation_key: 'org-1',
        published_at: '1000000',
        expires_at: '1604800000',
      },
      {
        id: 'ev-2',
        name: 'invoice.paid',
        payload: null,
        correlation_key: null,
        published_at: 2_000_000,
        expires_at: 3_000_000,
      },
    ]);

    const events = await createPgEventBus({ executor, listLimit: 25 }).list('invoice.paid');

    expect(events).toEqual([
      {
        id: 'ev-1',
        name: 'invoice.paid',
        payload: { invoice: 'in_1' },
        correlationKey: 'org-1',
        publishedAt: 1_000_000,
        expiresAt: 1_604_800_000,
      },
      {
        id: 'ev-2',
        name: 'invoice.paid',
        payload: null,
        publishedAt: 2_000_000,
        expiresAt: 3_000_000,
      },
    ]);
    expect(Object.hasOwn(events[1] as object, 'correlationKey')).toBe(false);
    expect(calls[0]?.sql).toBe(SQL_EVENT_LIST);
    expect(calls[0]?.params).toEqual(['invoice.paid', 25]);
  });

  test('an unfiltered list passes a null name, never a missing predicate', async () => {
    const { executor, calls } = recorder([]);
    await createPgEventBus({ executor }).list();
    expect(calls[0]?.params).toEqual([null, 1_000]);
  });

  test('purgeExpired is ONE counted DELETE, awaited, and answers what the database removed', async () => {
    const { executor, calls } = recorder([{ removed: '3' }]);
    const bus = createPgEventBus({ executor });
    expect(await bus.purgeExpired()).toBe(3);
    expect(calls.map((call) => call.sql)).toEqual([SQL_EVENT_PURGE_COUNTED]);
    expect(calls[0]?.params).toEqual([]);
    // Counted in the statement: a bare `returning` ships every deleted row back to be counted.
    expect(SQL_EVENT_PURGE_COUNTED).toContain('count(*)');
  });

  test('a failed purge REJECTS: the sweep step that asked retries, nothing is swallowed', async () => {
    const executor: PgExecutor = {
      query: () => Promise.reject(new Error('deadlock detected')),
    };
    const outcome = await createPgEventBus({ executor })
      .purgeExpired()
      .catch((error: unknown) => error);
    expect((outcome as Error).message).toBe('deadlock detected');
  });

  test('the bus is a PurgeTarget named for its table, on its own clock', async () => {
    const { executor, calls } = recorder([{ removed: 2 }]);
    const target = eventsPurgeTarget(createPgEventBus({ executor }));
    expect(target.name).toBe('x_job_events');
    // The sweep's instant is the job's process clock; this table's is the database's.
    expect(await target.purgeExpired(1)).toBe(2);
    expect(calls[0]?.params).toEqual([]);
  });

  test('size() is -1, the honest "not a number this bus keeps" — never 0, which reads as empty', async () => {
    const { executor } = recorder([]);
    const bus = createPgEventBus({ executor });
    await bus.publish('invoice.paid', {});
    expect(bus.size()).toBe(-1);
  });
});
