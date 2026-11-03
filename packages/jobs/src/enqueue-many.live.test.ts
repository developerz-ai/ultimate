// `enqueueMany` and the relay's batch publish against a real server, where a statement costs a
// round trip the embedded database does not charge: 1,000 inputs staged inside a transaction are
// ONE statement on the caller's connection, and a staged backlog leaves through the relay in two
// statements per batch. Prints what it measured. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { passthrough } from './operator-surface-fixture';
import { outboxJobsFacade } from './outbox';
import { postgresOutboxStore } from './outbox-pg';
import { outboxRelay } from './outbox-relay';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_enqueue_many_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

interface Item {
  readonly id: string;
}

const items = (count: number, prefix: string): Item[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));

afterAll(() => {
  resetJobs();
});

describe.skipIf(!hasPostgres)('live · postgres · enqueueMany and the batch relay', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;
  let handle: JobHandle<Item>;

  const on = (query: (text: string, values: readonly unknown[]) => Promise<readonly unknown[]>) =>
    ({
      query: <R>(text: string, values: readonly unknown[]) =>
        query(text, values) as Promise<readonly R[]>,
    }) satisfies PgExecutor;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 4 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = on((text, values) => client.query({ text, values }));
    handle = job<Item, void>({
      name: 'enqueue-many-live',
      tenant: 'none',
      input: passthrough<Item>(),
      idempotencyKey: ({ id }) => id,
      retry: { attempts: 1, jitter: false },
      run: () => Promise.resolve(),
    });
  });

  beforeEach(async () => {
    await executor.query('delete from x_jobs', []);
    await executor.query('delete from x_outbox', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** Stage `inputs` in one committed transaction, counting the statements its connection sent. */
  const stage = async (inputs: readonly Item[]) => {
    using connection = await client.reserve();
    const sent: string[] = [];
    const bound = on((text, values) => {
      sent.push(text);
      return connection.query({ text, values });
    });
    const store = postgresOutboxStore({ executor, txExecutor: () => bound });
    const jobs = outboxJobsFacade(
      { driver: postgresJobDriver({ executor }), store },
      () => ({ id: 'tx' }) as unknown as Tx,
    );
    await connection.execute(raw('begin'));
    const started = performance.now();
    await jobs.enqueueMany(handle, inputs);
    const ms = performance.now() - started;
    await connection.execute(raw('commit'));
    return { sent, ms, store };
  };

  test('1,000 inputs staged in a transaction are one statement on its connection', async () => {
    const { sent, ms, store } = await stage(items(1_000, 'a'));
    expect(sent).toHaveLength(1);
    expect(await store.pendingCount()).toBe(1_000);
    console.info(`enqueueMany: 1,000 staged in one statement, ${ms.toFixed(1)} ms`);
  });

  test('a staged backlog leaves through the relay, every row once, in two statements a batch', async () => {
    const { store } = await stage(items(10_000, 'b'));
    const driver = postgresJobDriver({ executor });
    // The default batch (`RELAY_BATCH_SIZE`): the figure a deployment gets without tuning anything.
    const relay = outboxRelay({ store, driver, drainOnShutdown: false });
    const started = performance.now();
    let published = 0;
    for (let pass = 0; pass < 200 && published < 10_000; pass += 1) published += await relay.tick();
    const seconds = (performance.now() - started) / 1_000;
    expect(published).toBe(10_000);
    expect(await store.pendingCount()).toBe(0);
    const [count] = await executor.query<{ n: number | string }>(
      'select count(*)::bigint as n from x_jobs',
      [],
    );
    expect(Number(count?.n)).toBe(10_000);
    console.info(`relay: 10,000 staged rows published at ${Math.round(10_000 / seconds)} rows/s`);
  });
});
