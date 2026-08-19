// J9: `step.waitForEvent` was backed by a process-local memory bus, with a comment saying it is
// "swapped at boot for the NATS/Redis-streams bus". No such bus existed and the production boot
// installed the memory one — so a Stripe webhook landing on web-3 published into web-3's heap and
// the worker resuming on worker-7 re-suspended every 30s until the 24h timeout dead-lettered it.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import {
  SQL_EVENT_FIND,
  SQL_EVENT_LIST,
  SQL_EVENT_PUBLISH,
  SQL_EVENT_PURGE,
} from './driver-pg-sql';
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

const clock = { now: () => new Date(1_000_000), monotonic: () => 1_000_000 };

describe('the pg event bus', () => {
  test('a step on ANOTHER process finds an event this one published', async () => {
    // One table, so the pod that publishes and the pod that resumes are never the same heap.
    const { executor } = recorder([{ payload: { invoice: 'in_1' }, published_at: '1000000' }]);
    const bus = createPgEventBus({ executor, clock });

    const hit = await bus.find('invoice.paid', 'org-1', 0);

    expect(hit).toEqual({ payload: { invoice: 'in_1' }, publishedAt: 1_000_000 });
  });

  test('publish writes the row with an explicit expiry', async () => {
    const { executor, calls } = recorder();
    const bus = createPgEventBus({ executor, clock, defaultTtl: '1h' });

    const event = await bus.publish('invoice.paid', { invoice: 'in_1' }, { correlationKey: 'o-1' });

    expect(calls[0]?.sql).toBe(SQL_EVENT_PUBLISH);
    expect(calls[0]?.params.slice(1)).toEqual([
      'invoice.paid',
      JSON.stringify({ invoice: 'in_1' }),
      'o-1',
      1_000_000,
      1_000_000 + 3_600_000,
    ]);
    expect(event.correlationKey).toBe('o-1');
  });

  test('the lookup honours order, expiry and the correlation key', () => {
    // Same three rules the memory bus follows, so a step behaves identically on either bus:
    // earliest match at or after the wait began, never an expired one, never another run's.
    expect(SQL_EVENT_FIND).toContain('order by published_at');
    expect(SQL_EVENT_FIND).toContain('expires_at > now()');
    expect(SQL_EVENT_FIND).toContain('published_at >= to_timestamp($3 / 1000.0)');
    expect(SQL_EVENT_FIND).toContain('($2::text is null or correlation_key = $2)');
  });

  test('an unmatched event is `undefined`, which is what re-suspends the step', async () => {
    const { executor } = recorder([]);
    expect(await createPgEventBus({ executor, clock }).find('never.published', undefined, 0)).toBe(
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

    const events = await createPgEventBus({ executor, clock, listLimit: 25 }).list('invoice.paid');

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
    await createPgEventBus({ executor, clock }).list();
    expect(calls[0]?.params).toEqual([null, 1_000]);
  });

  test('purgeExpired fires the DELETE and answers 0 — this bus keeps no count', async () => {
    const { executor, calls } = recorder([]);
    const bus = createPgEventBus({ executor, clock });
    expect(bus.purgeExpired()).toBe(0);
    // Synchronous by signature, a round trip in fact: the statement is issued, not awaited.
    await Promise.resolve();
    expect(calls.map((call) => call.sql)).toEqual([SQL_EVENT_PURGE]);
    expect(calls[0]?.params).toEqual([]);
  });

  test('a failed purge never rejects into a caller — housekeeping does not break a publish', async () => {
    const executor: PgExecutor = {
      query<R>(sql: string): Promise<readonly R[]> {
        return sql === SQL_EVENT_PURGE
          ? Promise.reject(new Error('deadlock detected'))
          : Promise.resolve([] as readonly R[]);
      },
    };
    const bus = createPgEventBus({ executor, clock });
    expect(bus.purgeExpired()).toBe(0);
    // An unhandled rejection here would fail the process, not this call: the assertion is that a
    // publish issued in the same turn still settles normally.
    await expect(bus.publish('invoice.paid', { invoice: 'in_2' })).resolves.toMatchObject({
      name: 'invoice.paid',
    });
  });

  test('size() is -1, the honest "not a number this bus keeps" — never 0, which reads as empty', async () => {
    const { executor } = recorder([]);
    const bus = createPgEventBus({ executor, clock });
    await bus.publish('invoice.paid', {});
    expect(bus.size()).toBe(-1);
  });
});
