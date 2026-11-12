// `x_rate_limit` is UNLOGGED, and a hot standby refuses to read an unlogged table (`0A000`). So no
// statement of the store may be offered to a replica — not even the plain-read peek, inside a
// `withReplicaReads` scope, over the routed client an app's executor reaches through `db()`. And
// should one land there anyway, the refusal degrades like an outage instead of answering 500.
import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { isPlainRead, recordingClient, replicatedClient, withReplicaReads } from '@ultimat3/db';
import { isRateLimitStoreUnreachable } from './rate-limit-degrade';
import {
  postgresRateLimitStore,
  SQL_RATE_LIMIT_PEEK,
  SQL_RATE_LIMIT_PURGE,
  SQL_RATE_LIMIT_RESET,
  SQL_RATE_LIMIT_TAKE,
} from './rate-limit-postgres';

describe('the rate-limit store never reaches a replica', () => {
  test('no statement of the store is a plain read', () => {
    for (const text of [
      SQL_RATE_LIMIT_PEEK,
      SQL_RATE_LIMIT_TAKE,
      SQL_RATE_LIMIT_RESET,
      SQL_RATE_LIMIT_PURGE,
    ]) {
      expect(isPlainRead(text)).toBe(false);
    }
  });

  test('a peek under withReplicaReads with a replica configured is the primary`s', async () => {
    const primary = recordingClient();
    const replica = recordingClient();
    const client = replicatedClient(primary, replica);
    const store = postgresRateLimitStore({
      executor: {
        query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          (await client.query({ text, values: [...values] } as never)) as readonly R[],
      },
    });
    await withReplicaReads(() =>
      store.peek('ip:203.0.113.9', { capacity: 4, refillPerSecond: 1 }, 1_000),
    );
    expect(replica.texts).toEqual([]);
    expect(primary.texts.some((text) => text.includes('from x_rate_limit'))).toBe(true);
  });

  test('a standby`s refusal to read an unlogged table degrades like an outage', () => {
    const refused = new UltimateError({
      code: 'X_DB_STATEMENT_FAILED',
      cause: 'cannot access temporary or unlogged relations during recovery',
      fix: 'x db status',
      meta: { sqlState: '0A000' },
    });
    expect(isRateLimitStoreUnreachable(refused)).toBe(true);
  });
});
