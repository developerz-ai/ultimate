// Scheduler single-leader failover on a real Postgres: the leader dies MID-TICK — frozen inside the
// fire of an occurrence it already owns, its lease never renewed — and a standby takes over on
// expiry. Every occurrence must be queued exactly once (no double fire) and none may be missing (no
// skip), including the one the dead leader was holding when it froze — and when that leader thaws
// and its stale fire lands late, the watermark fence must refuse it. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, resetLifecycle, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { postgresJobDriver } from './driver-pg';
import { SQL_SCHEDULER_FIRE } from './driver-pg-operator-sql';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { job, resetJobs } from './job';
import type { CronResolver, Scheduler } from './scheduler';
import { jobScheduler } from './scheduler';
import { postgresLeaseLeader, postgresSchedulerState } from './scheduler-pg';
import type { TaskHandle } from './task';
import { resetTasks, task } from './task';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_failover_live');
const TASK = 'heartbeatTask';
/** Short enough that the standby's wait is a fraction of a second; the logic is the shipped one. */
const TTL_MS = 400;
const SECOND = 1_000;
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const executorFor = (client: PostgresClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values }),
});

/** One occurrence on every whole second — aligned, so both nodes agree on every instant. */
const everySecond: CronResolver = (_cron, options) =>
  new Date(Math.floor(options.from.getTime() / SECOND) * SECOND + SECOND);

/** The scheduling clock both nodes share, moved by hand; the LEASE expires on the server's clock. */
function manualClock(start: number): Clock & { advance(ms: number): void; at(): number } {
  let current = start;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
    at: () => current,
  };
}

interface Freezable {
  readonly executor: PgExecutor;
  /** The next fire statement blocks before it reaches the server: the process is frozen. */
  freezeNextFire(): void;
  /** Settles once a fire is held — the leader is provably mid-tick, holding an occurrence. */
  frozen(): Promise<void>;
  /** Let the held fire through, late: the zombie the fence has to refuse. */
  thaw(): void;
}

function freezable(base: PgExecutor): Freezable {
  let armed = false;
  let arrived = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    executor: {
      async query<R>(text: string, values: readonly unknown[]): Promise<readonly R[]> {
        if (armed && text === SQL_SCHEDULER_FIRE) {
          armed = false;
          arrived();
          await gate;
        }
        return base.query<R>(text, values);
      },
    },
    freezeNextFire: () => {
      armed = true;
    },
    frozen: () => reached,
    thaw: () => open(),
  };
}

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

afterEach(() => {
  resetJobs();
  resetTasks();
  resetLifecycle();
});

describe.skipIf(!hasPostgres)('live · postgres · scheduler leader failover', () => {
  let admin: PostgresClient;
  let podA: PostgresClient;
  let podB: PostgresClient;
  let heartbeat: TaskHandle;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    podA = postgresClient({ url: probeUrl(), role: 'scheduler', profile: { max: 2 } });
    podB = postgresClient({ url: probeUrl(), role: 'scheduler', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await podA.execute(raw(statement));
    }
  });

  beforeEach(() => {
    const beat = job<{ occurrenceMs: number }>({
      tenant: 'none',
      name: 'beat',
      input: passthrough<{ occurrenceMs: number }>(),
      idempotencyKey: (input) => String(input.occurrenceMs),
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    heartbeat = task({
      name: TASK,
      cron: '* * * * * *',
      tz: 'UTC',
      catchUp: 'run-all',
      maxCatchUp: 100,
      enqueue: (occurrenceMs) => [[beat, { occurrenceMs }]],
    });
  });

  afterAll(async () => {
    await podA.close();
    await podB.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const node = (executor: PgExecutor, holder: string, clock: Clock): Scheduler =>
    jobScheduler({
      driver: postgresJobDriver({ executor }),
      state: postgresSchedulerState(executor),
      leader: postgresLeaseLeader({ executor, holder, ttlMs: TTL_MS }),
      clock,
      cron: everySecond,
      tasks: [heartbeat],
      tickIntervalMs: 3_600_000,
      drainOnShutdown: false,
    });

  /** Every occurrence the queue holds a job for, in order, duplicates kept. */
  const queuedOccurrences = async (): Promise<number[]> => {
    const rows = await podA.query<{ occurrence: string }>({
      text: `select (input->>'occurrenceMs') as occurrence from x_jobs where name = 'beat'
              order by (input->>'occurrenceMs')::bigint`,
      values: [],
    });
    return rows.map((row) => Number(row.occurrence));
  };

  test('the leader freezes mid-fire: the standby fires that occurrence once, and the late fire is refused', async () => {
    const clock = manualClock(T0);
    const frozenA = freezable(executorFor(podA));
    const a = node(frozenA.executor, 'pod-a', clock);
    const b = node(executorFor(podB), 'pod-b', clock);

    // A wins the lease and arms the task; B is a standby.
    expect(await a.tick()).toEqual([]);
    expect(await b.tick()).toEqual([]);
    clock.advance(SECOND);
    expect((await a.tick()).map((fire) => fire.occurrenceMs)).toEqual([T0 + SECOND]);

    // A is mid-tick on T0+2s when it dies: the fire never reaches the server, the lease is never
    // renewed and never released.
    clock.advance(SECOND);
    frozenA.freezeNextFire();
    const zombieRound = a.tick();
    await frozenA.frozen();

    // B keeps asking on the cadence a standby does; it takes over only once the lease EXPIRES.
    const takeoverStarted = performance.now();
    let takenOver: readonly number[] = [];
    while (takenOver.length === 0) {
      if (performance.now() - takeoverStarted > 10_000) {
        expect.unreachable('the standby never took the lease over');
      }
      // real-clock: the lease expires on the Postgres server's clock, which no test clock moves
      await Bun.sleep(50);
      clock.advance(SECOND / 4);
      takenOver = (await b.tick()).map((fire) => fire.occurrenceMs);
    }
    // Not before the lease ran out: a standby that fires sooner is a second leader.
    expect(performance.now() - takeoverStarted).toBeGreaterThanOrEqual(TTL_MS - 100);
    // The first thing the new leader fires is the occurrence the dead one was holding.
    expect(takenOver[0]).toBe(T0 + 2 * SECOND);

    // The frozen leader comes back and its stale fire lands: the watermark refuses it.
    frozenA.thaw();
    expect(await zombieRound).toEqual([]);
    // And it learns it is no longer the leader.
    clock.advance(SECOND);
    expect(await a.tick()).toEqual([]);
    const lastFromB = await b.tick();
    expect(lastFromB.length).toBeGreaterThan(0);

    const queued = await queuedOccurrences();
    // No double fire: every occurrence once.
    expect(new Set(queued).size).toBe(queued.length);
    // No skip: every whole second from the first fire to the last, contiguous.
    const first = queued[0] ?? expect.unreachable('nothing was queued');
    const last = queued[queued.length - 1] ?? first;
    const expected = Array.from(
      { length: (last - first) / SECOND + 1 },
      (_, index) => first + index * SECOND,
    );
    expect(queued).toEqual(expected);
    expect(last).toBe(Math.floor(clock.at() / SECOND) * SECOND);
  });
});
