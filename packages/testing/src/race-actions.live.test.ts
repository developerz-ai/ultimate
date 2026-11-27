// `raceActions` against a real Postgres: two transactions taking the same two rows in opposite
// order deadlock (40P01), and the report lists it. Skips without `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw, sql, withTransaction } from '@ultimat3/db';
import { raceActions } from './race-actions';
import { urlFor } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const database = probeDatabaseName('race_actions');
let admin: PostgresClient;
let client: PostgresClient;

beforeAll(async () => {
  if (adminUrl === undefined || adminUrl === '') return;
  admin = postgresClient({ url: adminUrl });
  await admin.execute(raw(`create database ${database}`));
  client = postgresClient({ url: urlFor(adminUrl, database) });
  await client.execute(raw('create table ra_rows (id int primary key, n int not null)'));
  await client.execute(raw('insert into ra_rows values (1, 0), (2, 0)'));
}, 30_000);
afterAll(async () => {
  if (adminUrl === undefined || adminUrl === '') return;
  await client.close();
  await admin.execute(raw(`drop database ${database} with (force)`));
  await admin.close();
});

/**
 * Releases each pair of arrivals together: both transactions hold their first row before either
 * asks for its second, so the deadlock is certain without waiting on the wall clock.
 */
function pairBarrier(): () => Promise<void> {
  let arrived = 0;
  let open = Promise.withResolvers<void>();
  return () => {
    const gate = open;
    arrived += 1;
    if (arrived % 2 === 0) {
      gate.resolve();
      open = Promise.withResolvers<void>();
    }
    return gate.promise;
  };
}

const touch = (barrier: () => Promise<void>, first: number, second: number) => () =>
  withTransaction(
    async (tx) => {
      await tx.execute(sql`update ra_rows set n = n + 1 where id = ${first}`);
      await barrier();
      await tx.execute(sql`update ra_rows set n = n + 1 where id = ${second}`);
    },
    { client },
  );

describe.skipIf(adminUrl === undefined || adminUrl === '')(
  testName('live', 'raceActions · postgres'),
  () => {
    test('opposite lock order deadlocks, and the report names it', async () => {
      const barrier = pairBarrier();
      const report = await raceActions([touch(barrier, 1, 2), touch(barrier, 2, 1)], { rounds: 3 });
      expect(report.serializationFailures.length).toBeGreaterThan(0);
      expect(report.serializationFailures[0]).toMatchObject({
        code: 'X_DB_SERIALIZATION_FAILURE',
        sqlState: '40P01',
      });
    }, 60_000);

    test('the same lock order never does', async () => {
      // Same order: the second waits on the first's row lock, so no pairing barrier is possible.
      const none = (): Promise<void> => Promise.resolve();
      const report = await raceActions([touch(none, 1, 2), touch(none, 1, 2)], { rounds: 3 });
      expect(report.serializationFailures).toEqual([]);
    }, 60_000);
  },
);
