// Both subscription stores answer one question one way: keyed by endpoint (a re-subscribe moves the
// device to whoever subscribed last), listed per actor in code-point order, and an owner-scoped
// remove that cannot delete somebody else's device.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PushSubscriptionRecord } from './push';
import { SQL_PUSH_SUBSCRIPTIONS_TABLE } from './push-schema';
import { memoryPushSubscriptionStore } from './push-store';
import { postgresPushSubscriptionStore } from './push-store-pg';

const AT = new Date('2026-10-08T12:00:00.000Z');

const record = (endpoint: string, actorId: string, locale = 'en'): PushSubscriptionRecord => ({
  endpoint,
  keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` },
  locale,
  timeZone: 'Europe/Berlin',
  actorId,
  createdAt: AT.getTime(),
  expirationTime: null,
});

describe('unit · memory push subscription store', () => {
  test('one row per endpoint: a re-subscribe hands the device over and keeps the first createdAt', async () => {
    const store = memoryPushSubscriptionStore();
    await store.save(record('https://p/b', 'ana'));
    await store.save(record('https://p/a', 'ana'));
    await store.save({ ...record('https://p/b', 'ben', 'de'), createdAt: AT.getTime() + 5 });
    expect((await store.listFor('ana')).map((row) => row.endpoint)).toEqual(['https://p/a']);
    expect(await store.listFor('ben')).toEqual([{ ...record('https://p/b', 'ben', 'de') }]);
  });

  test('an owner-scoped remove leaves another actor’s device; an unscoped one is the 410', async () => {
    const store = memoryPushSubscriptionStore();
    await store.save(record('https://p/a', 'ana'));
    expect(await store.remove('https://p/a', 'ben')).toBe(false);
    expect(await store.listFor('ana')).toHaveLength(1);
    expect(await store.remove('https://p/a')).toBe(true);
    expect(await store.remove('https://p/a')).toBe(false);
  });
});

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const recording = (rows: readonly unknown[], calls: Call[]): PgExecutor => ({
  query: <R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> => {
    calls.push({ sql, params });
    return Promise.resolve(rows as readonly R[]);
  },
});

describe('unit · postgres push subscription store', () => {
  test('the table is keyed by endpoint and indexed by actor', () => {
    expect(SQL_PUSH_SUBSCRIPTIONS_TABLE).toContain(
      'create table if not exists x_push_subscriptions',
    );
    expect(SQL_PUSH_SUBSCRIPTIONS_TABLE).toMatch(/endpoint\s+text\s+primary key/);
    expect(SQL_PUSH_SUBSCRIPTIONS_TABLE).toContain('on x_push_subscriptions (actor_id)');
  });

  test('save is an upsert on endpoint that moves the actor and keys, never created_at', async () => {
    const calls: Call[] = [];
    await postgresPushSubscriptionStore({ executor: recording([], calls) }).save(
      record('https://p/a', 'ana'),
    );
    const [call] = calls;
    expect(call?.sql).toContain('on conflict (endpoint) do update set');
    expect(call?.sql).toContain('actor_id = excluded.actor_id');
    expect(call?.sql).not.toContain('created_at = excluded');
    expect(call?.params).toEqual([
      'https://p/a',
      'ana',
      'p-https://p/a',
      'a-https://p/a',
      'en',
      'Europe/Berlin',
      null,
      AT,
    ]);
  });

  test('listFor reads one actor in code-point order and maps every column back', async () => {
    const calls: Call[] = [];
    const store = postgresPushSubscriptionStore({
      executor: recording(
        [
          {
            endpoint: 'https://p/a',
            actor_id: 'ana',
            p256dh: 'p',
            auth: 'a',
            locale: 'de',
            time_zone: 'Europe/Berlin',
            expiration_time: '1791460800000',
            created_at: AT.toISOString(),
          },
        ],
        calls,
      ),
    });
    expect(await store.listFor('ana')).toEqual([
      {
        endpoint: 'https://p/a',
        keys: { p256dh: 'p', auth: 'a' },
        locale: 'de',
        timeZone: 'Europe/Berlin',
        actorId: 'ana',
        expirationTime: 1791460800000,
        createdAt: AT.getTime(),
      },
    ]);
    expect(calls[0]?.sql).toContain('where actor_id = $1 order by endpoint collate "C"');
  });

  test('remove binds the owner, or null for the sender’s unconditional delete', async () => {
    const calls: Call[] = [];
    const store = postgresPushSubscriptionStore({
      executor: recording([{ endpoint: 'x' }], calls),
    });
    expect(await store.remove('https://p/a', 'ana')).toBe(true);
    expect(await store.remove('https://p/a')).toBe(true);
    expect(calls.map((call) => call.params)).toEqual([
      ['https://p/a', 'ana'],
      ['https://p/a', null],
    ]);
    expect(calls[0]?.sql).toContain('($2::text is null or actor_id = $2)');
  });
});
