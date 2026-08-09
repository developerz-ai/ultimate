import { describe, expect, test } from 'bun:test';
import type { DbClient, ReservableClient } from './client';
import { createRecordingClient } from './fake';
import { READONLY_TIMEOUT_MS, readOnlyQuery } from './readonly-query';

describe('readOnlyQuery', () => {
  test('the default order is BEGIN READ ONLY, timeout, statement, ROLLBACK', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'select 1',
      'ROLLBACK',
    ]);
    expect(result.guards).toEqual(['txn:read-only', `timeout:${READONLY_TIMEOUT_MS}ms`]);
  });

  test('a role is set after the timeout and before the statement', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client, role: 'ultimate_readonly' });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'SET LOCAL ROLE "ultimate_readonly"',
      'select 1',
      'ROLLBACK',
    ]);
    expect(result.guards).toEqual([
      'txn:read-only',
      `timeout:${READONLY_TIMEOUT_MS}ms`,
      'role:ultimate_readonly',
    ]);
  });

  test('timeoutMs: 0 disables the timeout statement and its guard', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client, timeoutMs: 0 });

    expect(client.texts).toEqual(['BEGIN READ ONLY', 'select 1', 'ROLLBACK']);
    expect(result.guards).toEqual(['txn:read-only']);
  });

  test('a rejecting statement still rolls back and rethrows the original error', async () => {
    const calls: string[] = [];
    const boom = new Error('boom');
    const failing: DbClient = {
      query: async () => {
        throw boom;
      },
      one: async () => null,
      execute: async (fragment) => {
        calls.push(fragment.text);
        return 0;
      },
    };

    await expect(readOnlyQuery('select 1', { client: failing })).rejects.toBe(boom);
    expect(calls).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'ROLLBACK',
    ]);
  });

  test("the caller's SQL reaches the driver byte-for-byte", async () => {
    const client = createRecordingClient();
    const statement = "select 'delete from posts' as note";
    await readOnlyQuery(statement, { client });

    const executed = client.statements[2];
    expect(executed?.text).toBe(statement);
    expect(executed?.values).toEqual([]);
  });

  test('a reservable client is reserved and released exactly once', async () => {
    const recorder = createRecordingClient();
    let reserveCalls = 0;
    let releaseCalls = 0;
    const reservable: ReservableClient = {
      query: (fragment) => recorder.query(fragment),
      one: (fragment) => recorder.one(fragment),
      execute: (fragment) => recorder.execute(fragment),
      reserve: async () => {
        reserveCalls += 1;
        return {
          query: (fragment) => recorder.query(fragment),
          one: (fragment) => recorder.one(fragment),
          execute: (fragment) => recorder.execute(fragment),
          release: () => {
            releaseCalls += 1;
          },
        };
      },
    };

    await readOnlyQuery('select 1', { client: reservable });

    expect(reserveCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(recorder.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'select 1',
      'ROLLBACK',
    ]);
  });
});
