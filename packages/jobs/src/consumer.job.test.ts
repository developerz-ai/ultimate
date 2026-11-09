// `consumer()` against Postgres: the queue on embedded Postgres, the app's batch and cursor tables
// on PGlite. Pins what the factory promises over `recipes.job.test.ts`' hand-assembled pins — a
// batch and its cursor commit together, a restart resumes past the last commit, a re-arm of a live
// key is deduped, a drain leaves the cursor on the last finished batch without counting the
// attempt, and the self-enqueue trap a plain job falls into is refused.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { configureLifecycle, ctxOf, drain, isUltimateError, resetLifecycle } from '@ultimat3/core';
import { db, type PgliteClient, pgliteClient, setDbClient } from '@ultimat3/db';
import { installJobDriver, resetJobDriver } from './adapter';
import { consumer } from './consumer';
import type { ConsumerHandle } from './consumer-types';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { job, resetJobs } from './job';
import {
  type AccountInput,
  type KeyedHarness,
  passthrough,
  rowOf,
  workerOn,
} from './keyed-concurrency-fixture';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';
import { jobWorker } from './worker';

/** A cold embedded Postgres plus a PGlite boot — the ceiling `recipes.job.test.ts` pins. */
setDefaultTimeout(120_000);

const harness: KeyedHarness = {
  async driver(): Promise<JobDriver> {
    const pg = await embeddedPg();
    await pg.reset();
    return postgresJobDriver({ executor: pg.executor });
  },
  async elapse(_driver, ms): Promise<void> {
    await (await embeddedPg()).age(ms);
  },
};

interface Gate {
  readonly passed: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

const ITEMS = [1, 2, 3, 4, 5, 6];
let driver: JobDriver;
let app: PgliteClient | undefined;
let minted = 0;

async function appTables(): Promise<PgliteClient> {
  app ??= pgliteClient();
  for (const text of [
    'create table if not exists consumer_items (key text, item int, primary key (key, item))',
    'create table if not exists consumer_cursors (key text primary key, cursor int not null)',
    'delete from consumer_items',
    'delete from consumer_cursors',
  ]) {
    await app.query({ text, values: [] });
  }
  setDbClient(app);
  return app;
}

const items = async (): Promise<number[]> =>
  (
    (await app?.query<{ item: number }>({
      text: 'select item from consumer_items order by item',
      values: [],
    })) ?? []
  ).map((row) => row.item);

const cursorOf = async (key: string): Promise<number | null> =>
  (
    await app?.query<{ cursor: number }>({
      text: 'select cursor from consumer_cursors where key = $1',
      values: [key],
    })
  )?.[0]?.cursor ?? null;

interface Hooks {
  /** Runs before each item is yielded; a drain test parks here. */
  readonly beforeItem?: (item: number, signal: AbortSignal) => Promise<void>;
  readonly saveFails?: (next: number) => boolean;
  readonly fetched?: number[];
}

/** The declaration under test: writes items and the cursor through the ambient transaction. */
function declare(hooks: Hooks = {}): ConsumerHandle {
  minted += 1;
  return consumer<number, number>({
    name: `consumer-${minted}`,
    tenant: 'none',
    batch: 2,
    retry: { attempts: 1, jitter: false },
    keys: () => ['acct-1'],
    async *open({ cursor, signal }) {
      hooks.fetched?.push(cursor ?? 0);
      for (const item of ITEMS) {
        if (item <= (cursor ?? 0)) continue;
        await hooks.beforeItem?.(item, signal);
        yield item;
      }
    },
    async handle({ items: batch, key }) {
      for (const item of batch) {
        await db().execute({
          text: 'insert into consumer_items (key, item) values ($1, $2)',
          values: [key, item],
        });
      }
      return batch[batch.length - 1] ?? 0;
    },
    cursor: {
      load: (key) => cursorOf(key),
      async save(key, next) {
        await db().execute({
          text: `insert into consumer_cursors (key, cursor) values ($1, $2)
                 on conflict (key) do update set cursor = excluded.cursor`,
          values: [key, next],
        });
        // The store failing is the consumer's INPUT, not this test's verdict: rejected, not thrown.
        if (hooks.saveFails?.(next) === true) {
          return Promise.reject(new Error(`save refused cursor ${next}`));
        }
      },
    },
  });
}

beforeEach(async () => {
  driver = await harness.driver();
  installJobDriver(driver);
  await appTables();
});

afterEach(() => {
  resetLifecycle();
  resetJobsFacade();
  resetJobDriver();
  resetJobs();
  resetTasks();
});

afterAll(async () => {
  setDbClient(undefined);
  await app?.close();
  await (await embeddedPg()).close();
});

describe('a batch and its cursor', () => {
  test('commit together: a throw in save rolls back the batch it would have recorded', async () => {
    const handle = declare({ saveFails: (next) => next === 4 });
    await handle.enqueue({ key: 'acct-1' });
    const runs = await workerOn(harness, driver, 'w-save').tick();

    expect(runs.map((run) => run.outcome)).toEqual(['dead-lettered']);
    expect(await items()).toEqual([1, 2]);
    expect(await cursorOf('acct-1')).toBe(2);
  });

  test('a restart resumes after the last commit, and nothing before it is read again', async () => {
    const fetched: number[] = [];
    let failing = true;
    const handle = declare({ fetched, saveFails: (next) => failing && next === 4 });
    await handle.enqueue({ key: 'acct-1' });
    const worker = workerOn(harness, driver, 'w-restart');
    await worker.tick();

    failing = false;
    const restart = await handle.enqueue({ key: 'acct-1' });
    expect(restart.deduped).toBe(false);
    expect((await worker.tick()).map((run) => run.result)).toEqual([
      { key: 'acct-1', batches: 2, items: 4 },
    ]);
    expect(fetched).toEqual([0, 2]);
    expect(await items()).toEqual(ITEMS);
    expect(await cursorOf('acct-1')).toBe(6);
  });
});

describe('the supervisor', () => {
  test('a second arm while the key runs is deduped onto the live row', async () => {
    const started = gate();
    const held = gate();
    const handle = declare({
      async beforeItem(item) {
        if (item !== 1) return;
        started.open();
        await held.passed;
      },
    });
    const worker = workerOn(harness, driver, 'w-arm');
    await handle.supervisor.enqueue();
    expect((await worker.tick()).map((run) => run.result)).toEqual([{ keys: 1, started: 1 }]);

    const running = worker.tick();
    await started.passed;
    await handle.supervisor.enqueue();
    const second = workerOn(harness, driver, 'w-arm-2');
    expect((await second.tick()).map((run) => run.result)).toEqual([{ keys: 1, started: 0 }]);
    held.open();
    expect((await running).map((run) => run.outcome)).toEqual(['completed']);
  });
});

describe('the self-enqueue trap', () => {
  test('a plain job re-arming itself is deduped onto its own row; a consumer refuses it', async () => {
    let rearm: { readonly deduped: boolean } | undefined;
    const plain = job<AccountInput>({
      name: `plain-${minted}`,
      tenant: 'none',
      input: passthrough<AccountInput>(),
      idempotencyKey: ({ account }) => `plain:${account}`,
      retry: { attempts: 1, jitter: false },
      async run({ input }) {
        rearm = await plain.enqueue(input);
      },
    });
    await plain.enqueue({ account: 'acct-1' });
    await workerOn(harness, driver, 'w-plain').tick();
    expect(rearm?.deduped).toBe(true);

    let refusal: unknown;
    const handle: ConsumerHandle = consumer<number, number>({
      name: `self-${minted}`,
      tenant: 'none',
      keys: () => ['acct-1'],
      async *open() {
        yield 1;
      },
      async handle({ key }) {
        refusal = await handle.enqueue({ key }).catch((error: unknown) => error);
        return 1;
      },
      cursor: { load: () => null, save: () => undefined },
    });
    await handle.enqueue({ key: 'acct-1' });
    await workerOn(harness, driver, 'w-consumer-self').tick();
    expect(isUltimateError(refusal) ? refusal.code : refusal).toBe('X_CONSUMER_SELF_ENQUEUE');
  });
});

describe('a consumer under a drain', () => {
  test('leaves the cursor on the last finished batch and does not count the attempt', async () => {
    const parked = gate();
    let reason: unknown;
    const handle = declare({
      async beforeItem(item, signal) {
        if (item !== 3) return;
        parked.open();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        reason = signal.reason;
      },
    });
    const enqueued = await handle.enqueue({ key: 'acct-1' });
    configureLifecycle({ deadlineMs: 300 });
    const worker = jobWorker({
      driver,
      workerId: 'w-drain',
      pollIntervalMs: 1,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    });
    worker.start();
    await parked.passed;
    await drain('SIGTERM');
    resetLifecycle();

    expect(isUltimateError(reason) ? reason.code : reason).toBe('X_DRAINING');
    expect(await items()).toEqual([1, 2]);
    expect(await cursorOf('acct-1')).toBe(2);
    const row = await rowOf(driver, enqueued.id);
    expect(row.state).toBe('ready');
    expect(row.attempt).toBe(0);
    expect(await driver.introspect?.deadLetters()).toEqual([]);
  });
});
