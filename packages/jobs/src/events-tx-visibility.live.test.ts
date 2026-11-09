// An event published inside a transaction, on two sessions of a real server: stamped at INSERT,
// visible at COMMIT. A wait whose first pass runs between the two must still be answered once the
// publisher commits — not after its 24 h timeout. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, isUltimateError, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import {
  currentTx,
  dbExecutor,
  outsideTransaction,
  postgresClient,
  raw,
  setDbClient,
  withTransaction,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { postgresEventBus } from './events-pg';
import { job, resetJobs } from './job';
import { isStepSuspension, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';
import { jobWorker } from './worker';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_events_tx_visibility');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

afterEach(() => {
  resetJobs();
});

describe.skipIf(!hasPostgres)('live · postgres · a publish committed after the wait began', () => {
  let admin: PostgresClient;
  let workerPod: PostgresClient;
  let webPod: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    workerPod = postgresClient({ url: probeUrl(), role: 'worker', profile: { max: 4 } });
    webPod = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await workerPod.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await workerPod.close();
    await webPod.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** A: BEGIN + publish. B: the wait's first pass. A: COMMIT (or rollback). B: polls on. */
  async function interleave(
    end: 'commit' | 'rollback',
    wakes: boolean,
  ): Promise<{ answered: string[]; firstPassMissed: boolean }> {
    await workerPod.execute(raw('truncate x_jobs, x_job_steps, x_job_events'));
    const executor = dbExecutor(() => workerPod);
    const driver = postgresJobDriver({ executor });
    const answered: string[] = [];
    const approve = job<{ id: string }>({
      name: `txApprove${end}${String(wakes)}`,
      tenant: 'none',
      input: t.object({ id: t.string }),
      idempotencyKey: ({ id }) => `tx:${id}`,
      retry: { attempts: 1 },
      // The backstop, lowered: the default is 30 s (15 min with wakes) of a 24 h wait.
      eventPoll: '200ms',
      run: async ({ input, step }) => {
        const paid = await step.waitForEvent('paid', 'tx.paid', {
          schema: t.object({ id: t.string }),
          match: input.id,
          timeout: '1h',
        });
        answered.push(paid?.id ?? 'none');
      },
    });
    const worker = jobWorker({
      driver,
      events: postgresEventBus({ executor, wakes }),
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    using session = await webPod.reserve();
    const publisherTx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    try {
      await driver.enqueue({
        name: approve.name,
        queue: 'default',
        input: { id: 'inv-1' },
        idempotencyKey: 'tx:inv-1',
        maxAttempts: 1,
      });
      await publisherTx.query('begin', []);
      await postgresEventBus({ executor: publisherTx, wakes }).publish(
        'tx.paid',
        { id: 'inv-1' },
        { correlationKey: 'inv-1' },
      );
      // B's first pass, while A's row is stamped but invisible: it parks.
      expect(await worker.tick()).toHaveLength(1);
      const firstPassMissed = answered.length === 0;
      await publisherTx.query(end, []);
      const deadline = performance.now() + 2_000;
      while (answered.length === 0 && performance.now() < deadline) {
        await worker.tick();
        // real-clock: the backstop poll is due on the server's time
        await Bun.sleep(20);
      }
      return { answered, firstPassMissed };
    } finally {
      await worker.stop('test-end');
    }
  }

  test('a wait that began between INSERT and COMMIT is answered once the publisher commits', async () => {
    expect(await interleave('commit', false)).toEqual({
      answered: ['inv-1'],
      firstPassMissed: true,
    });
  }, 30_000);

  test('the same over a waking bus, whose wake met no waiter inside the transaction', async () => {
    expect(await interleave('commit', true)).toEqual({
      answered: ['inv-1'],
      firstPassMissed: true,
    });
  }, 30_000);

  test('a refusal carries the horizon of the search that found it: two refusals never loop', async () => {
    await workerPod.execute(raw('truncate x_job_events'));
    const bus = postgresEventBus({ executor: dbExecutor(() => workerPod) });
    using session = await webPod.reserve();
    const publisherTx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    const mark = await bus.mark?.();
    expect(mark?.horizon).toBeString();
    await publisherTx.query('begin', []);
    const publisher = postgresEventBus({ executor: publisherTx });
    const first = await publisher.publish('tx.bad', { n: 1 });
    const second = await publisher.publish('tx.bad', { n: 2 });
    const asked = mark?.at ?? 0;
    expect(await bus.find('tx.bad', undefined, asked, undefined, mark?.horizon)).toBeUndefined();
    await publisherTx.query('commit', []);

    // Both were invisible to the wait's horizon, so both are owed — earliest first.
    const one = await bus.find('tx.bad', undefined, asked, undefined, mark?.horizon);
    expect(one?.id).toBe(first.id);
    // Refused: the cursor moves past it, under the horizon of the search that SAW it.
    const two = await bus.find('tx.bad', undefined, one?.publishedAt ?? 0, one?.id, one?.horizon);
    expect(two?.id).toBe(second.id);
    // Refused too. Under the wait's first horizon `first` was unseen, so it came back.
    expect(
      await bus.find('tx.bad', undefined, two?.publishedAt ?? 0, two?.id, two?.horizon),
    ).toBeUndefined();
  });

  // E1 is stamped first, in a transaction still open when the wait marks; E0 is stamped after it
  // and committed BEFORE the mark — so E0 came before the wait and is never its answer. Refusing
  // the owed E1 moved the floor to E1's stamp and dropped the wait's own line: E0 sorts past E1
  // and was handed out next.
  test('refusing an owed event never opens the wait to one committed before it began', async () => {
    await workerPod.execute(raw('truncate x_job_events'));
    const bus = postgresEventBus({ executor: dbExecutor(() => workerPod) });
    using a = await webPod.reserve();
    using b = await webPod.reserve();
    const session = (reserved: typeof a): PgExecutor => ({
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        reserved.query<R>({ text, values }),
    });
    await session(a).query('begin', []);
    const e1 = await postgresEventBus({ executor: session(a) }).publish('tx.e', { n: 1 });
    await session(b).query('begin', []);
    const e0 = await postgresEventBus({ executor: session(b) }).publish('tx.e', { n: 0 });
    await session(b).query('commit', []);
    expect(e0.publishedAt).toBeGreaterThanOrEqual(e1.publishedAt);
    // real-clock: the mark must be stamped after E0, on the server's time
    await Bun.sleep(5);
    const mark = await bus.mark?.();
    if (mark === undefined) return expect.unreachable('the pg bus marks');
    await session(a).query('commit', []);

    const since = { at: mark.at, horizon: mark.horizon };
    const owed = await bus.find('tx.e', undefined, mark.at, undefined, mark.horizon, since);
    expect(owed?.id).toBe(e1.id);
    // E1 refused: the cursor moves past it, and the wait's own line stays where it began.
    const next = await bus.find(
      'tx.e',
      undefined,
      owed?.publishedAt ?? 0,
      owed?.id,
      owed?.horizon,
      since,
    );
    expect(next).toBeUndefined();
  });

  // R1 is stamped inside a transaction open across the wait's mark; R0 lands after the mark and is
  // refused first. R1 commits, is owed through the horizon, sorts BEFORE R0 and is refused too.
  // Moving the cursor back to R1 re-opened R0 behind it: refused a second time, an attempt spent.
  test('an event refused behind the cursor never re-opens one refused before it', async () => {
    await workerPod.execute(raw('truncate x_job_events'));
    const bus = postgresEventBus({ executor: dbExecutor(() => workerPod) });
    const store = memoryStepStore();
    const attempt = () =>
      stepRunner({ runId: 'run-r', jobName: 'pay', store, events: bus })
        .step.waitForEvent('approval', 'tx.r', {
          schema: t.object({ ok: t.boolean }),
          timeout: '1h',
        })
        .catch((error: unknown) => error);
    const refused = (outcome: unknown): string =>
      isUltimateError(outcome) ? outcome.code : isStepSuspension(outcome) ? 'parked' : 'answered';
    using a = await webPod.reserve();
    const tx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        a.query<R>({ text, values }),
    };
    await tx.query('begin', []);
    await postgresEventBus({ executor: tx }).publish('tx.r', { bad: 'R1' });
    expect(refused(await attempt())).toBe('parked');
    await bus.publish('tx.r', { bad: 'R0' });
    expect(refused(await attempt())).toBe('X_JOB_EVENT_INVALID'); // R0
    await tx.query('commit', []);
    expect(refused(await attempt())).toBe('X_JOB_EVENT_INVALID'); // R1, owed
    // Was X_JOB_EVENT_INVALID: R0, again.
    expect(refused(await attempt())).toBe('parked');
    await bus.publish('tx.r', { ok: true });
    expect(await attempt()).toEqual({ ok: true });
  });

  test('a rolled-back publish answers nothing', async () => {
    expect(await interleave('rollback', false)).toEqual({ answered: [], firstPassMissed: true });
  }, 30_000);

  // The boot's shape: the bus runs on the open transaction (`currentTx() ?? client`) and wakes.
  // The publish's own wake ran before the waiter parked, so it woke nobody; the commit must wake
  // it — not the 15 min backstop. The backstop is left at its default here, so only a wake answers.
  test('a waiter parked during the publishing transaction is woken by its COMMIT', async () => {
    await workerPod.execute(raw('truncate x_jobs, x_job_steps, x_job_events'));
    const executor = dbExecutor(() => workerPod);
    const driver = postgresJobDriver({ executor });
    const answered: string[] = [];
    const approve = job<{ id: string }>({
      name: 'txApproveCommitWake',
      tenant: 'none',
      input: t.object({ id: t.string }),
      idempotencyKey: ({ id }) => `txw:${id}`,
      retry: { attempts: 1 },
      run: async ({ input, step }) => {
        const paid = await step.waitForEvent('paid', 'tx.paid', {
          schema: t.object({ id: t.string }),
          match: input.id,
          timeout: '1h',
        });
        answered.push(paid?.id ?? 'none');
      },
    });
    const worker = jobWorker({
      driver,
      events: postgresEventBus({ executor, wakes: true }),
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    setDbClient(webPod);
    try {
      await driver.enqueue({
        name: approve.name,
        queue: 'default',
        input: { id: 'inv-1' },
        idempotencyKey: 'txw:inv-1',
        maxAttempts: 1,
      });
      const web = postgresEventBus({
        executor: dbExecutor(() => currentTx() ?? webPod),
        wakes: true,
      });
      await withTransaction(async () => {
        await web.publish('tx.paid', { id: 'inv-1' }, { correlationKey: 'inv-1' });
        expect(await outsideTransaction(() => worker.tick())).toHaveLength(1);
        expect(answered).toEqual([]);
      });
      const deadline = performance.now() + 3_000;
      while (answered.length === 0 && performance.now() < deadline) {
        await worker.tick();
        // real-clock: the commit's wake lands on the server's time
        await Bun.sleep(20);
      }
      expect(answered).toEqual(['inv-1']);
    } finally {
      setDbClient(undefined);
      await worker.stop('test-end');
    }
  }, 30_000);
});
