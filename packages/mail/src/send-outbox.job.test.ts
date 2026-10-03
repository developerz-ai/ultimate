// `send()` inside a transaction, followed to a real worker (`s1-con #3`). The mail is staged on the
// caller's transaction through the jobs facade, so a rollback delivers nothing and a commit
// delivers once. The memory pair always runs; the Postgres pair needs `TEST_DATABASE_URL`, makes
// its own database and drops it afterwards.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, createLogger } from '@ultimat3/core';
import type { JobDriver, OutboxStore, PgExecutor } from '@ultimat3/jobs';
import {
  createJobsFacade,
  createMemoryDriver as createMemoryJobDriver,
  createMemoryOutboxStore,
  createOutboxRelay,
  createPgDriver,
  createPgOutboxStore,
  createWorker,
  resetJobDriver,
  resetJobsFacade,
  SQL_JOBS_TABLE,
  setJobDriver,
  setJobsFacade,
} from '@ultimat3/jobs';
import {
  createMemoryDriver,
  type MemoryMailDriver,
  resetMailDriver,
  setMailDriver,
} from './driver';
import { type SendOptions, send } from './mail';
import { welcomeMail } from './templates';

/** The facade's transaction token, named without importing `@ultimat3/entity` into this package. */
type Tx = NonNullable<ReturnType<Parameters<typeof createJobsFacade>[1]>>;

const PAYLOAD = { name: 'Ada', appName: 'Acme', url: 'https://acme.test/app' };
const TO: SendOptions = { to: 'ada@example.test', locale: 'en', tz: 'UTC' };

let mail: MemoryMailDriver;

const freshMailDriver = (): void => {
  resetMailDriver();
  mail = createMemoryDriver();
  setMailDriver(mail);
};

afterEach(() => {
  resetJobsFacade();
  resetJobDriver();
  resetMailDriver();
});

/** Holds a real worker open for a bounded number of polls: the point is what it never delivers. */
async function drainWith(driver: JobDriver, until?: () => boolean): Promise<void> {
  const worker = createWorker({
    driver,
    drainOnShutdown: false,
    pollIntervalMs: 5,
    context: () =>
      createContext({
        role: 'worker',
        buildId: 'test',
        logger: createLogger({ writer: () => undefined }),
      }),
  });
  worker.start();
  try {
    for (let i = 0; i < 200 && until?.() !== true; i += 1) await Bun.sleep(5);
  } finally {
    await worker.stop('test-end');
  }
}

describe('memory outbox: send() rides the caller’s transaction', () => {
  const wire = (): { queue: JobDriver; store: OutboxStore; tx: Tx } => {
    freshMailDriver();
    const queue = createMemoryJobDriver();
    setJobDriver(queue);
    const store = createMemoryOutboxStore();
    const tx = { id: 'request' } as unknown as Tx;
    setJobsFacade(createJobsFacade({ store, driver: queue }, () => tx));
    return { queue, store, tx };
  };

  test('rolled back: the relay publishes nothing and a worker delivers nothing', async () => {
    const { queue, store, tx } = wire();
    const result = await send(welcomeMail, PAYLOAD, TO);
    expect(result.queued).toBe(true);
    await store.rollback(tx);

    expect(await createOutboxRelay({ store, driver: queue }).tick()).toBe(0);
    await drainWith(queue);
    expect(mail.sent).toEqual([]);
  });

  test('committed: published once, delivered once', async () => {
    const { queue, store, tx } = wire();
    await send(welcomeMail, PAYLOAD, TO);
    await store.commit(tx);

    expect(await createOutboxRelay({ store, driver: queue }).tick()).toBe(1);
    await drainWith(queue, () => mail.sent.length > 0);
    expect(mail.sent.map((entry) => entry.message.to)).toEqual([['ada@example.test']]);
  });
});

const url = Bun.env['TEST_DATABASE_URL'];
/** Its own database: this file applies the queue's tables and drops them with it. */
const PROBE_DB = 'x_mail_outbox_probe';

const admin = async (statement: string): Promise<void> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

/** `Bun.SQL` binds a JS array as a joined string; the queue binds queue NAMES as one. */
const bound = (value: unknown): unknown =>
  Array.isArray(value)
    ? `{${value.map((entry) => JSON.stringify(String(entry))).join(',')}}`
    : value;

type Sql = InstanceType<typeof Bun.SQL>;
const executorOf = (client: Pick<Sql, 'unsafe'>): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    [...(await client.unsafe(text, values.map(bound)))] as R[],
});

let sql: Sql | undefined;

beforeAll(async () => {
  if (url === undefined) return;
  await admin(`drop database if exists ${PROBE_DB} with (force)`);
  await admin(`create database ${PROBE_DB}`);
  const target = new URL(url);
  target.pathname = `/${PROBE_DB}`;
  sql = new Bun.SQL(target.href, { max: 4, prepare: false });
  for (const statement of SQL_JOBS_TABLE.split(';')) {
    if (statement.trim().length > 0) await sql.unsafe(statement, []);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

class Rollback {}

describe.skipIf(url === undefined)('pg outbox: send() stages on the caller’s connection', () => {
  /** One `send()` inside a real transaction, ended by `end`; answers what the queue then holds. */
  const sendIn = async (end: 'commit' | 'rollback'): Promise<JobDriver> => {
    if (sql === undefined) return expect.unreachable('beforeAll opened no database');
    const client = sql;
    await client.unsafe('truncate x_outbox, x_jobs', []);
    freshMailDriver();
    const executor = executorOf(client);
    const queue = createPgDriver({ executor });
    setJobDriver(queue);
    let bound: PgExecutor | undefined;
    const tx = { id: 'request' } as unknown as Tx;
    const store = createPgOutboxStore({
      executor,
      txExecutor: () => bound ?? expect.unreachable('staged outside the transaction'),
    });
    setJobsFacade(createJobsFacade({ store, driver: queue }, () => tx));
    await client
      .begin(async (open) => {
        bound = executorOf(open);
        await send(welcomeMail, PAYLOAD, TO);
        if (end === 'rollback') throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    await createOutboxRelay({ store, driver: queue }).tick();
    return queue;
  };

  test('rolled back: no outbox row, no job row, nothing delivered', async () => {
    const queue = await sendIn('rollback');
    expect((await queue.introspect?.list()) ?? []).toEqual([]);
    await drainWith(queue);
    expect(mail.sent).toEqual([]);
  });

  test('committed: one job row, delivered once', async () => {
    const queue = await sendIn('commit');
    expect(((await queue.introspect?.list()) ?? []).map((row) => row.name)).toEqual(['mail.send']);
    await drainWith(queue, () => mail.sent.length > 0);
    expect(mail.sent).toHaveLength(1);
  });
});
