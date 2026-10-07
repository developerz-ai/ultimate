// The pool series are derived from demand, so the arithmetic is the whole claim: in use never
// exceeds the ceiling, the overflow is what waits, and a pin counts from the ask to the release.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { trackPool } from './pool-gauge';
import { sql } from './sql';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;
const opened: PostgresClient[] = [];

afterEach(async () => {
  for (const client of opened.splice(0)) await client.close();
  host.Bun.SQL = realBunSql;
});

type Series = Readonly<Record<'db_pool_max' | 'db_pool_in_use' | 'db_pool_waiting', number>>;

const read = (): Series => {
  const value = (name: string): number =>
    collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points[0]?.value ??
    0;
  return {
    db_pool_max: value('db_pool_max'),
    db_pool_in_use: value('db_pool_in_use'),
    db_pool_waiting: value('db_pool_waiting'),
  };
};

// Against a baseline: the totals are the PROCESS's, and another test file's client that was never
// closed is still one of its pools.
let base: Series = { db_pool_max: 0, db_pool_in_use: 0, db_pool_waiting: 0 };

beforeEach(() => {
  base = read();
});

const series = (): Series => {
  const now = read();
  return {
    db_pool_max: now.db_pool_max - base.db_pool_max,
    db_pool_in_use: now.db_pool_in_use - base.db_pool_in_use,
    db_pool_waiting: now.db_pool_waiting - base.db_pool_waiting,
  };
};

/** A pool whose statements settle only when the test says so, and whose pins count releases. */
function installGatedSql(): { settle(): void; failNext(): void } {
  const waiting: (() => void)[] = [];
  let fail = false;
  host.Bun.SQL = class {
    unsafe(): Promise<unknown> {
      if (fail) {
        fail = false;
        return Promise.reject(Object.assign(new Error('connection refused'), { errno: '08006' }));
      }
      return new Promise((resolve) => waiting.push(() => resolve([])));
    }
    async reserve(): Promise<unknown> {
      return { unsafe: async (): Promise<unknown> => [], release: (): void => {} };
    }
    async close(): Promise<void> {}
  };
  return {
    settle: () => {
      for (const done of waiting.splice(0)) done();
    },
    failNext: () => {
      fail = true;
    },
  };
}

const client = (max: number): PostgresClient => {
  const created = postgresClient({ url: TEST_URL, role: 'web', profile: { max } });
  opened.push(created);
  return created;
};

describe('unit · the pool gauges', () => {
  test('demand under the ceiling is in use; demand past it is waiting', () => {
    const pool = trackPool(2);
    pool.enter();
    expect(series()).toEqual({ db_pool_max: 2, db_pool_in_use: 1, db_pool_waiting: 0 });
    pool.enter();
    pool.enter();
    pool.enter();
    expect(series()).toEqual({ db_pool_max: 2, db_pool_in_use: 2, db_pool_waiting: 2 });
    pool.leave();
    pool.leave();
    pool.leave();
    pool.leave();
    // One leave too many is absorbed: the next statement is still counted.
    pool.leave();
    pool.enter();
    expect(series().db_pool_in_use).toBe(1);
    pool.close();
    expect(series()).toEqual({ db_pool_max: 0, db_pool_in_use: 0, db_pool_waiting: 0 });
  });

  test('a client counts a statement from send to settle, whether it answers or fails', async () => {
    const gate = installGatedSql();
    const db = client(1);
    const first = db.query(sql`select 1`);
    const second = db.query(sql`select 2`);
    expect(series()).toEqual({ db_pool_max: 1, db_pool_in_use: 1, db_pool_waiting: 1 });
    gate.settle();
    await Promise.all([first, second]);
    expect(series()).toEqual({ db_pool_max: 1, db_pool_in_use: 0, db_pool_waiting: 0 });
    gate.failNext();
    await db.query(sql`select 3`).then(
      () => expect.unreachable('the driver refused the statement'),
      () => undefined,
    );
    expect(series().db_pool_in_use).toBe(0);
  });

  test('a pin holds a connection until it is released, once', async () => {
    installGatedSql();
    const db = client(4);
    const pin = await db.reserve();
    // Statements ON the pin ride its connection: they are not a second unit of demand.
    await pin.query(sql`select 1`);
    expect(series()).toEqual({ db_pool_max: 4, db_pool_in_use: 1, db_pool_waiting: 0 });
    pin.release();
    pin.release();
    expect(series().db_pool_in_use).toBe(0);
  });

  test('a pin the pool refused is not left counted', async () => {
    host.Bun.SQL = class {
      reserve(): Promise<unknown> {
        return Promise.reject(Object.assign(new Error('too many clients'), { errno: '53300' }));
      }
      async close(): Promise<void> {}
    };
    const db = client(2);
    await db.reserve().then(
      () => expect.unreachable('the pool refused the pin'),
      () => undefined,
    );
    expect(series().db_pool_in_use).toBe(0);
  });

  test('a pool that could not be opened registers nothing', async () => {
    host.Bun.SQL = class {
      constructor() {
        throw new TypeError('invalid connection string');
      }
    };
    const db = client(3);
    await db.query(sql`select 1`).then(
      () => expect.unreachable('the driver could not be built'),
      () => undefined,
    );
    expect(series()).toEqual({ db_pool_max: 0, db_pool_in_use: 0, db_pool_waiting: 0 });
  });

  test('a closed pool still draining is not counted against the pool that replaced it', async () => {
    const gate = installGatedSql();
    const db = client(1);
    const draining = db.query(sql`select 1`);
    await db.close();
    const fresh = db.query(sql`select 2`);
    // One statement on a one-connection pool: in use, nothing waiting behind the old pool's work.
    expect(series()).toEqual({ db_pool_max: 1, db_pool_in_use: 1, db_pool_waiting: 0 });
    gate.settle();
    await Promise.all([draining, fresh]);
    expect(series()).toEqual({ db_pool_max: 1, db_pool_in_use: 0, db_pool_waiting: 0 });
  });

  test('two pools sum, and a closed one leaves the totals', async () => {
    installGatedSql();
    const primary = client(3);
    const replica = client(5);
    const held = [await primary.reserve(), await replica.reserve()];
    expect(series()).toEqual({ db_pool_max: 8, db_pool_in_use: 2, db_pool_waiting: 0 });
    for (const pin of held) pin.release();
    await replica.close();
    // Still registered from its last use; `max` is what a scrape divides by.
    expect(series().db_pool_max).toBe(3);
  });
});
