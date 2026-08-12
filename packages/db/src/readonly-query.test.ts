// Single responsibility: the statement SEQUENCE layer 2 emits, asserted in isolation. Order is
// the whole guarantee — a timeout set after the statement, a role assumed before the timeout, a
// cursor declared outside the transaction or a rollback that does not run are each a hole no
// live-database test would name, because every one of them still returns the right rows.

import { describe, expect, test } from 'bun:test';
import type { DbClient, ReservableClient } from './client';
import { dbUnavailable } from './errors';
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

  test('only 0 disables the timeout — NaN falls back to the default', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client, timeoutMs: Number.NaN });

    expect(client.texts).toContain(`SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`);
    expect(result.guards).toContain(`timeout:${READONLY_TIMEOUT_MS}ms`);
  });

  test('a rejecting statement still rolls back and rethrows the original error', async () => {
    const calls: string[] = [];
    const boom = dbUnavailable('statement failed: select 1');
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

  test('maxRows fetches through a cursor declared after the role, inside the transaction', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select * from events', {
      client,
      role: 'ultimate_readonly',
      maxRows: 101,
    });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'SET LOCAL ROLE "ultimate_readonly"',
      'DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select * from events',
      'FETCH FORWARD 101 FROM ultimate_read_cursor',
      'ROLLBACK',
    ]);
    expect(result.guards).toContain('fetch:101 rows');
  });

  test('a trailing semicolon does not split the DECLARE into two statements', async () => {
    const client = createRecordingClient();
    await readOnlyQuery('select 1;  ', { client, maxRows: 5 });

    expect(client.texts).toContain('DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select 1');
  });

  test.each([
    ['table events', true],
    ['values (1),(2)', true],
    ['  -- lead\n with x as (select 1) select * from x', true],
    ['explain select 1', false],
    ['show statement_timeout', false],
  ])('cursorability of %p is %p', async (statement, expected) => {
    const client = createRecordingClient();
    const result = await readOnlyQuery(statement, { client, maxRows: 7 });

    expect(result.guards.includes('fetch:7 rows')).toBe(expected);
    expect(client.texts.includes(statement)).toBe(!expected);
  });

  test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxRows %p is not a fetch count, so the statement runs whole',
    async (maxRows) => {
      const client = createRecordingClient();
      const result = await readOnlyQuery('select 1', { client, maxRows });

      expect(client.texts).toContain('select 1');
      expect(result.guards.some((guard) => guard.startsWith('fetch:'))).toBe(false);
    },
  );

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
        const release = (): void => {
          releaseCalls += 1;
        };
        return {
          query: (fragment) => recorder.query(fragment),
          one: (fragment) => recorder.one(fragment),
          execute: (fragment) => recorder.execute(fragment),
          release,
          [Symbol.dispose]: release,
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
