// `lockKeys` over real backends: every key held by one transaction, the same advisory lock a
// `lockKey` takes, and two overlapping calls in opposite orders finishing where two nested
// `lockKey`s deadlock. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const ledgers = entity('lock_keys_live_ledgers', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), label: text({ max: 10 }) },
});
const ORG = '00000000-0000-7000-8000-00000000000a';
const inOrg = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId: ORG }) }), work);

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · lockKeys', () => {
  let client: PostgresClient;
  const db = () => database({ ledgers }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string });
    setDbClient(client);
    await client.execute(raw('drop table if exists lock_keys_live_ledgers cascade'));
    const { up } = generateMigration({ entities: [ledgers.$describe()], name: 'lock keys live' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists lock_keys_live_ledgers cascade'));
    setDbClient(undefined);
    await client.close();
  });

  test('every key is held for fn: a lockKey on the last of them waits for the whole', async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const order: string[] = [];
    const held = inOrg(() =>
      db().ledgers.lockKeys(['acct:1', 'acct:2', 'acct:3'], async () => {
        entered.resolve();
        await release.promise;
        order.push('transfer');
      }),
    );
    await entered.promise;
    const waiter = inOrg(() =>
      db().ledgers.lockKey('acct:3', () => {
        order.push('acct:3');
      }),
    );
    // real-clock: "still parked" has no event; only Postgres's lock queue, given time, can show it.
    await Bun.sleep(50);
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([held, waiter]);
    expect(order).toEqual(['transfer', 'acct:3']);
  });

  test('ten callers over overlapping keys in shuffled orders all finish, none deadlocks', async () => {
    const keys = ['a', 'b', 'c', 'd'];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, at) => {
        const mine = at % 2 === 0 ? [...keys].reverse() : keys.slice(at % 3);
        return inOrg(() =>
          db().ledgers.lockKeys(mine, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return at;
          }),
        );
      }),
    );
    expect(results).toEqual(Array.from({ length: 10 }, (_, at) => at));
  });

  test("fn's throw rolls back and releases every key", async () => {
    const refused = await inOrg(() =>
      // The failed transfer is the input lockKeys must roll back on, not a verdict.
      db().ledgers.lockKeys(['r1', 'r2'], () =>
        Promise.reject(new TypeError('the transfer failed')),
      ),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TypeError);
    expect(await inOrg(() => db().ledgers.lockKeys(['r2', 'r1'], () => 'free'))).toBe('free');
  });
});
