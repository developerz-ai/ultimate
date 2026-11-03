// The behaviour a long-lived job rests on, pinned against Postgres: a re-arm deduped while the run
// is live (the supervisor), a self-enqueue deduped onto the running row (the trap), a `step.run`
// cursor walk resuming on the page it was killed on, and a consumer whose drained turn commits
// nothing. `consumer()` assembles these; a change to any of them is a visible decision here first.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  configureLifecycle,
  ctxOf,
  drain,
  isUltimateError,
  resetLifecycle,
  throwIfAborted,
} from '@ultimat3/core';
import { type PgliteClient, pgliteClient, withTransaction } from '@ultimat3/db';
import { type JobDriver, resetJobDriver, setJobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { type JobHandle, type JobRunArgs, job, resetJobs } from './job';
import {
  type AccountInput,
  type KeyedHarness,
  passthrough,
  rowOf,
  TTL_MS,
  workerOn,
} from './keyed-concurrency-fixture';
import { resetJobsFacade } from './outbox';
import { jobWorker } from './worker';

/**
 * The first scenario of each describe pays a cold embedded Postgres or PGlite boot (`embeddedPg()`,
 * then the consumer's own `pgliteClient()`): alone it fits Bun's 5000ms default, but beside every
 * other package's suite (`coverage-gate.ts --all`, all cores) the drain's first scenario timed out
 * at 5009ms. The ceiling `driver-pg-lifecycle.job.test.ts` and `queue-wake.job.test.ts` pin.
 */
const PGLITE_BOOT_MS = 120_000;
setDefaultTimeout(PGLITE_BOOT_MS);

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

/** Resolves once `signal` aborts: the event a drained body waits on, never a timer. */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

let minted = 0;
const named = (what: string): string => {
  minted += 1;
  return `recipe-${what}-${minted}`;
};

/** The supervised-consumer declaration: one live run per key, a re-arm waits, never a timeout. */
function consumerJob(
  run: (args: JobRunArgs<AccountInput>) => Promise<void>,
): JobHandle<AccountInput> {
  return job<AccountInput>({
    name: named('consumer'),
    tenant: 'none',
    input: passthrough<AccountInput>(),
    idempotencyKey: ({ account }) => `consumer:${account}`,
    concurrency: { key: ({ account }) => account, limit: 1, whenBusy: 'wait' },
    retry: { attempts: 1, jitter: false },
    run,
  });
}

let driver: JobDriver;
let app: PgliteClient | undefined;

beforeEach(async () => {
  driver = await harness.driver();
  setJobDriver(driver);
});

afterEach(() => {
  resetLifecycle();
  resetJobsFacade();
  resetJobDriver();
  resetJobs();
});

afterAll(async () => {
  await app?.close();
  await (await embeddedPg()).close();
});

describe('re-arming a consumer', () => {
  test('from outside while it runs answers deduped, same id; once settled it starts a new run', async () => {
    const started = gate();
    const held = gate();
    let runs = 0;
    const consumer = consumerJob(async () => {
      runs += 1;
      started.open();
      await held.passed;
    });
    const first = await consumer.enqueue({ account: 'acct-1' });
    const worker = workerOn(harness, driver, 'w-supervised');

    const ticking = worker.tick();
    await started.passed;
    expect((await rowOf(driver, first.id)).state).toBe('running');
    expect(await consumer.enqueue({ account: 'acct-1' })).toMatchObject({
      deduped: true,
      id: first.id,
    });

    held.open();
    expect((await ticking).map((execution) => execution.outcome)).toEqual(['completed']);
    const restart = await consumer.enqueue({ account: 'acct-1' });
    expect(restart.deduped).toBe(false);
    expect(restart.id).not.toBe(first.id);
    expect((await worker.tick()).map((execution) => execution.outcome)).toEqual(['completed']);
    expect(runs).toBe(2);
  });

  test('from its own body answers deduped onto the running row, and no later run exists', async () => {
    // The trap, pinned so a change to the dedupe window is a decision someone sees: a key is live
    // while its row is `running`, so a job re-arming itself on the way out arms nothing.
    let rearm: { readonly id: string; readonly deduped: boolean } | undefined;
    let ownId: string | undefined;
    let runs = 0;
    const consumer: JobHandle<AccountInput> = consumerJob(async ({ input, jobId }) => {
      runs += 1;
      ownId = jobId;
      rearm = await consumer.enqueue(input);
    });
    await consumer.enqueue({ account: 'acct-1' });
    const worker = workerOn(harness, driver, 'w-self');

    expect((await worker.tick()).map((execution) => execution.outcome)).toEqual(['completed']);
    expect(rearm).toMatchObject({ deduped: true, id: ownId });
    await harness.elapse(driver, TTL_MS);
    expect(await worker.tick()).toEqual([]);
    const rows = (await driver.introspect?.list({ name: consumer.name })) ?? [];
    expect(rows.map((row) => row.state)).toEqual(['done']);
    expect(runs).toBe(1);
  });

  test('with a different payload under a live key answers deduped, and the first payload wins', async () => {
    // The wiki once promised `X_IDEMPOTENCY_CONFLICT` here; that code is the action layer's, and
    // the queue throws nothing. Pinned so the row in `Jobs-And-Workflows.md` stays true.
    const tagged = job<AccountInput & { readonly note: string }>({
      name: named('tagged'),
      tenant: 'none',
      input: passthrough<AccountInput & { readonly note: string }>(),
      idempotencyKey: ({ account }) => `tagged:${account}`,
      retry: { attempts: 1, jitter: false },
      async run() {},
    });
    const first = await tagged.enqueue({ account: 'acct-1', note: 'first' });
    const second = await tagged.enqueue({ account: 'acct-1', note: 'second' });

    expect(second).toMatchObject({ deduped: true, id: first.id });
    expect((await rowOf(driver, first.id)).input).toEqual({ account: 'acct-1', note: 'first' });
  });
});

describe('a remote cursor walk as step.run pages', () => {
  test('killed mid-page, it resumes on that page and no earlier page is fetched again', async () => {
    const PAGES: Record<number, { readonly cursor: number | null; readonly rows: number[] }> = {
      0: { cursor: 2, rows: [1, 2] },
      2: { cursor: 4, rows: [3, 4] },
      4: { cursor: null, rows: [5, 6] },
    };
    const fetched: number[] = [];
    const walked: number[][] = [];
    const killedAt = gate();
    const zombie = gate();
    const walk = job<AccountInput>({
      name: named('walk'),
      tenant: 'none',
      input: passthrough<AccountInput>(),
      idempotencyKey: ({ account }) => `walk:${account}`,
      // Two: the kill costs the attempt a lapsed lease always costs.
      retry: { attempts: 2, jitter: false },
      async run({ step }) {
        const rows: number[] = [];
        let cursor: number | null = 0;
        for (let page = 0; cursor !== null; page += 1) {
          const from: number = cursor;
          // Only `{ cursor, rows }`: `steps.ts` retains every step's output for the run.
          const got: { readonly cursor: number | null; readonly rows: number[] } = await step.run(
            `page:${page}`,
            async () => {
              fetched.push(from);
              if (from === 4 && fetched.filter((at) => at === 4).length === 1) {
                killedAt.open();
                await zombie.passed;
              }
              const answer = PAGES[from];
              if (answer === undefined) return expect.unreachable(`no page at cursor ${from}`);
              return answer;
            },
          );
          rows.push(...got.rows);
          cursor = got.cursor;
        }
        walked.push(rows);
      },
    });
    await walk.enqueue({ account: 'acct-1' });

    // A SIGKILL: the dead worker never renews, settles or releases; its lease lapses.
    const dead = workerOn(harness, driver, 'w-dead');
    const orphaned = dead.tick();
    await killedAt.passed;
    await harness.elapse(driver, TTL_MS + 1_000);
    const next = workerOn(harness, driver, 'w-next');
    expect((await next.tick()).map((execution) => execution.outcome)).toEqual(['completed']);

    expect(fetched).toEqual([0, 2, 4, 4]);
    expect(walked).toEqual([[1, 2, 3, 4, 5, 6]]);
    zombie.open();
    await orphaned;
    expect(walked).toHaveLength(1);
  });
});

/** The consumer's own tables: the batch and its cursor, written in one transaction per turn. */
async function appTables(): Promise<PgliteClient> {
  app ??= pgliteClient();
  await app.query({
    text: 'create table if not exists recipe_items (account text, item int, primary key (account, item))',
    values: [],
  });
  await app.query({
    text: 'create table if not exists recipe_cursors (account text primary key, cursor int not null)',
    values: [],
  });
  await app.query({ text: 'delete from recipe_items', values: [] });
  await app.query({ text: 'delete from recipe_cursors', values: [] });
  return app;
}

interface DrainedConsumer {
  readonly consumer: JobHandle<AccountInput>;
  readonly jobId: string;
  readonly client: PgliteClient;
  /** Each turn's fetch cursor, in order, across every run. */
  readonly fetched: number[];
  /** What `withTransaction` threw at the turn the drain cut. */
  readonly refusals: unknown[];
  /** What the body's signal said when it aborted. */
  readonly reason: () => unknown;
}

const ITEMS = [1, 2, 3, 4, 5, 6];
const BATCH = 2;
const DEADLINE_MS = 300;

/**
 * A consumer started on a real worker, drained while its SECOND turn's fetch is in flight. That
 * fetch answers as the signal aborts, the worst moment: a batch in hand and no right to write it.
 */
async function drainedMidTurn(): Promise<DrainedConsumer> {
  const client = await appTables();
  const fetched: number[] = [];
  const refusals: unknown[] = [];
  let reason: unknown;
  const inFlight = gate();
  const consumer = consumerJob(async ({ input, ctx }) => {
    for (;;) {
      const [stored] = await client.query<{ cursor: number }>({
        text: 'select cursor from recipe_cursors where account = $1',
        values: [input.account],
      });
      const cursor = stored?.cursor ?? 0;
      fetched.push(cursor);
      if (fetched.length === 2) {
        inFlight.open();
        await abortOf(ctx.signal);
        reason = ctx.signal.reason;
      }
      const batch = ITEMS.filter((item) => item > cursor).slice(0, BATCH);
      if (batch.length === 0) return;
      try {
        await withTransaction(
          async (tx) => {
            for (const item of batch) {
              await tx.query({
                text: 'insert into recipe_items (account, item) values ($1, $2)',
                values: [input.account, item],
              });
            }
            await tx.query({
              text: `insert into recipe_cursors (account, cursor) values ($1, $2)
                     on conflict (account) do update set cursor = excluded.cursor`,
              values: [input.account, batch[batch.length - 1]],
            });
          },
          { client },
        );
      } catch (error) {
        refusals.push(error);
        throw error;
      }
      // After the commit, never before it: a turn is whole or absent.
      throwIfAborted(ctx);
    }
  });
  const enqueued = await consumer.enqueue({ account: 'acct-1' });
  configureLifecycle({ deadlineMs: DEADLINE_MS });
  const worker = jobWorker({
    driver,
    workerId: 'w-consumer',
    pollIntervalMs: 1,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
  });
  worker.start();
  await inFlight.passed;
  await drain('SIGTERM');
  resetLifecycle();
  return { consumer, jobId: enqueued.id, client, fetched, refusals, reason: () => reason };
}

describe('a consumer under a drain', () => {
  test('the drain aborts the body with X_DRAINING and the attempt is not counted', async () => {
    const drained = await drainedMidTurn();

    const reason = drained.reason();
    if (!isUltimateError(reason)) return expect.unreachable(`signal reason ${String(reason)}`);
    expect(reason.code).toBe('X_DRAINING');
    // One attempt allowed: a counted one would have dead-lettered the consumer here.
    const row = await rowOf(driver, drained.jobId);
    expect(row.state).toBe('ready');
    expect(row.attempt).toBe(0);
    expect(await driver.introspect?.deadLetters()).toEqual([]);
  });

  test('the drained turn commits nothing, and the next run resumes from the last finished batch', async () => {
    const drained = await drainedMidTurn();

    const [refusal] = drained.refusals;
    if (!isUltimateError(refusal)) return expect.unreachable(`refusal ${String(refusal)}`);
    expect(refusal.code).toBe('X_DRAINING');
    const items = async (): Promise<number[]> =>
      (
        await drained.client.query<{ item: number }>({
          text: 'select item from recipe_items order by item',
          values: [],
        })
      ).map((row) => row.item);
    const cursor = async (): Promise<number | undefined> =>
      (
        await drained.client.query<{ cursor: number }>({
          text: 'select cursor from recipe_cursors',
          values: [],
        })
      )[0]?.cursor;
    expect(await items()).toEqual([1, 2]);
    expect(await cursor()).toBe(2);

    const next = workerOn(harness, driver, 'w-replacement');
    expect((await next.tick()).map((execution) => execution.outcome)).toEqual(['completed']);
    // Resumed at 2, not 0 and not 4: nothing re-fetched before the cursor, no batch skipped.
    expect(drained.fetched).toEqual([0, 2, 2, 4, 6]);
    expect(await items()).toEqual(ITEMS);
    expect(await cursor()).toBe(6);
  });
});
