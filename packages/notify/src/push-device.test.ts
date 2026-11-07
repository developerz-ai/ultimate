// The device stores answer one question one way: keyed `(platform, token)`, the same ordering in
// memory and in Postgres, a re-register that moves the device and keeps its first `createdAt`, and
// a remove that names its owner reaching only that owner's row.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { isDeviceToken, memoryPushDeviceStore } from './push-device';
import {
  postgresPushDeviceStore,
  SQL_PUSH_DEVICE_BAD_TOKEN,
  SQL_PUSH_DEVICE_BAD_TOKEN_CLEAR,
  SQL_PUSH_DEVICE_LIST,
  SQL_PUSH_DEVICE_REMOVE,
  SQL_PUSH_DEVICE_SAVE,
  SQL_PUSH_DEVICES_TABLE,
} from './push-device-pg';

const IOS = 'ab'.repeat(32);
const ANDROID = `fcm:${'y'.repeat(60)}`;
const record = (overrides: Record<string, unknown> = {}) => ({
  platform: 'ios' as const,
  token: IOS,
  actorId: 'ana',
  locale: 'es',
  timeZone: 'Europe/Madrid',
  createdAt: 1_000,
  ...overrides,
});

describe('unit · push device tokens', () => {
  test('each platform holds its own alphabet; a path character is never a token', () => {
    expect(isDeviceToken('ios', IOS)).toBe(true);
    expect(isDeviceToken('ios', ANDROID)).toBe(false);
    expect(isDeviceToken('ios', `${IOS}/x`)).toBe(false);
    expect(isDeviceToken('android', ANDROID)).toBe(true);
    expect(isDeviceToken('android', `${ANDROID}?x`)).toBe(false);
  });
});

describe('unit · memoryPushDeviceStore', () => {
  test('a re-register moves the device and keeps the first createdAt', async () => {
    const store = memoryPushDeviceStore();
    await store.save(record());
    await store.save(record({ actorId: 'ben', createdAt: 9_000, locale: 'de' }));
    expect(await store.listFor('ana')).toEqual([]);
    expect(await store.listFor('ben')).toEqual([
      record({ actorId: 'ben', createdAt: 1_000, locale: 'de' }),
    ]);
  });

  test('listed (platform, token) by code point, and a remove naming another owner is absent', async () => {
    const store = memoryPushDeviceStore();
    await store.save(record({ token: 'cd'.repeat(32) }));
    await store.save(record({ platform: 'android', token: ANDROID }));
    await store.save(record());
    expect((await store.listFor('ana')).map((d) => `${d.platform}:${d.token.slice(0, 4)}`)).toEqual(
      ['android:fcm:', 'ios:abab', 'ios:cdcd'],
    );
    expect(await store.remove('ios', IOS, 'ben')).toBe(false);
    expect(await store.remove('ios', IOS, 'ana')).toBe(true);
    expect(await store.remove('android', ANDROID)).toBe(true);
    expect(await store.listFor('ana')).toHaveLength(1);
  });
});

describe('unit · postgresPushDeviceStore', () => {
  const recording = (answer: readonly unknown[] = []) => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query: <R>(sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve(answer as readonly R[]);
      },
    };
    return { calls, store: postgresPushDeviceStore({ executor }) };
  };

  test('the table is keyed (platform, token) and indexed by actor', () => {
    expect(SQL_PUSH_DEVICES_TABLE).toContain('primary key (platform, token)');
    expect(SQL_PUSH_DEVICES_TABLE).toContain('on x_push_devices (actor_id)');
    // The memory store's code-point order, spelled where Postgres could otherwise use a locale's.
    expect(SQL_PUSH_DEVICE_LIST).toContain('order by platform collate "C", token collate "C"');
  });

  test('save binds every column, and a conflict leaves created_at alone', async () => {
    const { calls, store } = recording();
    await store.save(record());
    expect(calls[0]?.sql).toBe(SQL_PUSH_DEVICE_SAVE);
    expect(calls[0]?.params).toEqual(['ios', IOS, 'ana', 'es', 'Europe/Madrid', new Date(1_000)]);
    expect(SQL_PUSH_DEVICE_SAVE.split('do update set')[1]).not.toContain('created_at');
    expect(SQL_PUSH_DEVICE_SAVE.split('do update set')[1]).not.toContain('bad_tokens');
  });

  test('a table made before the count gains it, and a clear writes only a row that has one', () => {
    expect(SQL_PUSH_DEVICES_TABLE).toContain(
      'alter table x_push_devices add column if not exists bad_tokens integer not null default 0',
    );
    expect(SQL_PUSH_DEVICE_BAD_TOKEN_CLEAR).toContain('and bad_tokens > 0');
  });

  test('a bad-token answer binds the device and reads the count back; no row is 0', async () => {
    const counted = recording([{ bad_tokens: '2' }]);
    expect(await counted.store.noteBadToken('ios', IOS)).toBe(2);
    expect(counted.calls[0]).toEqual({ sql: SQL_PUSH_DEVICE_BAD_TOKEN, params: ['ios', IOS] });
    expect(await recording([]).store.noteBadToken('ios', IOS)).toBe(0);
  });

  test('a row reads back as the record, and a sender remove binds no owner', async () => {
    const row = {
      platform: 'ios',
      token: IOS,
      actor_id: 'ana',
      locale: 'es',
      time_zone: 'Europe/Madrid',
      created_at: '1970-01-01T00:00:01.000Z',
      bad_tokens: 0,
    };
    const { calls, store } = recording([row]);
    expect(await store.listFor('ana')).toEqual([record()]);
    expect(await store.remove('ios', IOS)).toBe(true);
    expect(calls[1]).toEqual({ sql: SQL_PUSH_DEVICE_REMOVE, params: ['ios', IOS, null] });
  });
});
