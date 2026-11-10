// `withLock()` over `postgresJobDriver`'s lease store on a real server: two drivers (two pods) race
// one key and exactly one runs at a time; a holder whose TTL lapses hands the key
// over (the stale holder learning of it is `lock.test.ts`). Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { isUltimateError, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import type { LeaseStore } from './leases';
import { lockLeaseKey, withLock } from './lock';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_lock_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** Event-loop turns until `condition` holds — bounded, so a lease that never lapses fails. */
async function until(condition: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await new Promise<void>((done) => setImmediate(done));
  }
}

describe.skipIf(!hasPostgres)('live · postgres · withLock()', () => {
  let admin: PostgresClient;
  const clients: PostgresClient[] = [];
  const stores: LeaseStore[] = [];

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    // Two pools, two drivers: what two pods are.
    for (let pod = 0; pod < 2; pod += 1) {
      const client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
      clients.push(client);
      const executor: PgExecutor = {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          client.query<R>({ text, values }),
      };
      const leases = postgresJobDriver({ executor }).leases;
      expect(leases).toBeDefined();
      stores.push(leases as LeaseStore);
    }
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await clients[0]?.execute(raw(statement));
    }
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const store = (pod: number): LeaseStore => stores[pod] as LeaseStore;

  test('two pods race one key: never two inside at once, both finish', async () => {
    let inside = 0;
    let most = 0;
    let entered = 0;
    let refused = 0;
    // Counts a refused acquire: the evidence a holder waits for, instead of a fixed delay.
    const counting = (pod: number): LeaseStore => {
      const inner = store(pod);
      return {
        ...inner,
        async acquire(...args: Parameters<LeaseStore['acquire']>) {
          const lease = await inner.acquire(...args);
          if (lease === undefined) refused += 1;
          return lease;
        },
      };
    };
    const ATTEMPTS = 4;
    const tokens: number[] = [];
    const work = async ({ token }: { readonly token: number }): Promise<void> => {
      tokens.push(token);
      inside += 1;
      entered += 1;
      most = Math.max(most, inside);
      // Hold the key until another pod has been REFUSED it — the last holder has nobody to wait for.
      const seen = refused;
      if (entered < ATTEMPTS) await until(() => refused > seen);
      inside -= 1;
    };
    await Promise.all(
      [0, 1, 0, 1].map((pod) =>
        withLock('live:race', work, { ttl: '5s', wait: '5s', poll: 5, store: counting(pod) }),
      ),
    );
    expect(most).toBe(1);
    expect(entered).toBe(ATTEMPTS);
    // The server's fence: each holder's token beats the one before, whichever pod it ran on.
    expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
    expect(new Set(tokens).size).toBe(ATTEMPTS);
  });

  test('a lapsed TTL hands the key to the other pod, refused before it lapses', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    // No renewal ever fires: the holder is a paused process.
    const stale = withLock('live:ttl', () => gate, {
      ttl: 300,
      store: store(0),
      schedule: () => () => {},
    }).catch((error: unknown) => error);
    // The stale holder HOLDS it (asked of the server), not "has probably acquired by now".
    await until(async () => (await store(1).holders(lockLeaseKey('live:ttl'))).length === 1);
    const refused = await withLock('live:ttl', () => 'early', {
      ttl: 300,
      wait: 0,
      store: store(1),
    }).catch((error: unknown) => error);
    expect(isUltimateError(refused) && refused.code).toBe('X_LOCK_NOT_ACQUIRED');
    // The lapse is on the SERVER's clock: poll the other pod's one-shot acquire until it lands.
    let next: unknown;
    await until(async () => {
      next = await withLock('live:ttl', () => 'next', { ttl: 300, wait: 0, store: store(1) }).catch(
        (error: unknown) => error,
      );
      return next === 'next';
    });
    expect(next).toBe('next');
    release();
    await stale;
  });
});
