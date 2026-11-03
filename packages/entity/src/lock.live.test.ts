// `lock` and `lockKey` over real connections, where the race is real: separate backends, a real row
// lock and a real advisory lock. The reference for "two orgs' same key do not block" too, which a
// one-connection engine cannot show. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

// A foreign failure handed to the subject: test input, never its verdict.
const CALLBACK_FAILED = new Error('the callback failed');

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const counters = entity('lock_live_counters', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    hits: integer(),
    label: text({ max: 10 }),
  },
});

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG_A = idAt('a');
const ORG_B = idAt('b');

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId }) }), work);

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · lock', () => {
  let client: PostgresClient;
  const db = () => database({ counters }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string });
    setDbClient(client);
    await client.execute(raw('drop table if exists lock_live_counters cascade'));
    const { up } = generateMigration({ entities: [counters.$describe()], name: 'lock live' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists lock_live_counters cascade'));
    setDbClient(undefined);
    await client.close();
  });

  const seedCounter = async (suffix: string, orgId = ORG_A): Promise<string> => {
    const id = idAt(suffix);
    await db().counters.insert({ id, orgId, hits: 0, label: 'x' });
    return id;
  };

  test('20 racers end at 20, where the plain handle loses updates', async () => {
    const id = await seedCounter('1');
    await inOrg(ORG_A, () =>
      Promise.all(
        Array.from({ length: 20 }, () =>
          db().counters.lock(id, async (row, tx) => {
            await Bun.sleep(0);
            await db().counters.update(id, { hits: row.hits + 1 }, { tx });
          }),
        ),
      ),
    );
    expect((await db().counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(20);
  });

  test('another org’s id is absent and takes no lock', async () => {
    const id = await seedCounter('2');
    const holder = Promise.withResolvers<void>();
    const held = inOrg(ORG_A, () => db().counters.lock(id, () => holder.promise));
    const error = await inOrg(ORG_B, () => db().counters.lock(id, () => 1)).catch(
      (thrown: unknown) => thrown,
    );
    holder.resolve();
    await held;
    expect(isUltimateError(error) ? error.code : error).toBe('X_NOT_FOUND');
  });

  test('a throw rolls back, and the row is free again', async () => {
    const id = await seedCounter('3');
    await inOrg(ORG_A, () =>
      db().counters.lock(id, async (_row, tx) => {
        await db().counters.update(id, { hits: 9 }, { tx });
        throw CALLBACK_FAILED;
      }),
    ).catch(() => undefined);
    expect((await db().counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(0);
    expect(await inOrg(ORG_A, () => db().counters.lock(id, () => 'free'))).toBe('free');
  });

  test('nested in withTransaction the row lock lives to the root COMMIT', async () => {
    const id = await seedCounter('4');
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const inside = Promise.withResolvers<void>();
    const root = inOrg(ORG_A, () =>
      withTransaction(async () => {
        await db().counters.lock(id, async () => {
          order.push('nested ran');
        });
        inside.resolve();
        await release.promise;
        order.push('root ending');
      }),
    );
    await inside.promise;
    const second = inOrg(ORG_A, () =>
      db().counters.lock(id, async () => {
        order.push('second ran');
      }),
    );
    // real-clock: "still parked" has no event; only Postgres's lock queue, given time, can show it.
    await Bun.sleep(50);
    expect(order).toEqual(['nested ran']);
    release.resolve();
    await Promise.all([root, second]);
    expect(order).toEqual(['nested ran', 'root ending', 'second ran']);
  });

  test('one key serialises one org and never another', async () => {
    const release = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const held = inOrg(ORG_A, () =>
      db().counters.lockKey('recount', () => {
        holding.resolve();
        return release.promise;
      }),
    );
    await holding.promise;
    // A different org: its key hashes apart, so this finishes while org A still holds its own.
    expect(await inOrg(ORG_B, () => db().counters.lockKey('recount', () => 'other org'))).toBe(
      'other org',
    );
    const order: string[] = [];
    const same = inOrg(ORG_A, () =>
      db().counters.lockKey('recount', async () => {
        order.push('same org ran');
      }),
    );
    // real-clock: "still parked" has no event; only Postgres's lock queue, given time, can show it.
    await Bun.sleep(50);
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([held, same]);
    expect(order).toEqual(['same org ran']);
  });

  test('a waiter past its statement_timeout is X_DB_STATEMENT_TIMEOUT, memory’s code', async () => {
    const id = await seedCounter('7');
    const holder = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const held = inOrg(ORG_A, () =>
      db().counters.lock(id, async () => {
        entered.resolve();
        await holder.promise;
      }),
    );
    await entered.promise;
    const waited = await inOrg(ORG_A, () =>
      withTransaction(async (tx) => {
        await tx.execute(raw('set local statement_timeout = 50'));
        await db().counters.lock(id, () => undefined);
      }),
    ).catch((error: unknown) => error);
    holder.resolve();
    await held;
    expect(isUltimateError(waited) ? waited.code : waited).toBe('X_DB_STATEMENT_TIMEOUT');
  });

  test('a deadlock is X_DB_SERIALIZATION_FAILURE', async () => {
    const a = await seedCounter('5');
    const b = await seedCounter('6');
    const both = Promise.withResolvers<void>();
    let ready = 0;
    const meet = async (): Promise<void> => {
      ready += 1;
      if (ready === 2) both.resolve();
      await both.promise;
    };
    const take = (first: string, second: string) =>
      inOrg(ORG_A, () =>
        db().counters.lock(first, async () => {
          await meet();
          await db().counters.lock(second, () => undefined);
        }),
      ).then(
        () => 'ok',
        (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
      );
    const results = await Promise.all([take(a, b), take(b, a)]);
    expect(results).toContain('X_DB_SERIALIZATION_FAILURE');
  });
});
