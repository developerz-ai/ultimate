// A named `limiter()` holds across replicas: two gates — two processes' fast paths, each over its
// own Postgres connection — never start more than the declared rate in any window nor hold more
// than the declared concurrency, and two job workers over two drivers defer, uncounted, to the rate. Each fast path alone would grant
// the whole budget, so only the shared `x_job_leases` rows keep the sum under it. Skips unless
// `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, isUltimateError, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { installJobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { job, resetJobs } from './job';
import { limiter, resetLimiters } from './limiter';
import { limiterGate } from './limiter-gate';
import { jobWorker } from './worker';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_limiter_live');
const RATE = { limit: 4, windowMs: 600 };
const CONCURRENCY = 2;
/** Two clocks on one host — the database's and `performance.now()` — read a few ms apart at most. */
const CLOCK_SLACK_MS = 10;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/**
 * One run's grant, bracketed: the database granted it at some instant in `[asked, started]` — after
 * its last `gate.run` began and before its body did. Exact stamps would need the database's clock.
 */
interface Start {
  readonly asked: number;
  readonly started: number;
}

/** What the bodies saw: every start, bracketed, and the most ever running at once. */
const ledger = () => {
  const starts: Start[] = [];
  let running = 0;
  let peak = 0;
  return {
    starts,
    peak: () => peak,
    async body(asked: number): Promise<void> {
      starts.push({ asked, started: performance.now() });
      running += 1;
      peak = Math.max(peak, running);
      // real-clock: the run must overlap the other replica's to test concurrency at all
      await Bun.sleep(60);
      running -= 1;
    },
  };
};

/**
 * The shortest span any `limit + 1` grants can have taken, from below: a set's latest body start is
 * no earlier than its latest grant, and its earliest ask no later than its earliest grant. A
 * sliding window of `limit` per `windowMs` holds iff every such span is at least `windowMs`.
 */
const tightestSpan = (starts: readonly Start[], limit: number): number => {
  const sorted = [...starts].sort((a, b) => a.started - b.started);
  let tightest = Number.POSITIVE_INFINITY;
  for (let i = 0; i + limit < sorted.length; i += 1) {
    const set = sorted.slice(i, i + limit + 1);
    const last = Math.max(...set.map((one) => one.started));
    const first = Math.min(...set.map((one) => one.asked));
    tightest = Math.min(tightest, last - first);
  }
  return tightest;
};

// File scope, not inside the skipped block: Bun evaluates a skipped file's module body, and the
// jobs and limiters it declares would otherwise leak into every later file in the process.
afterAll(() => {
  resetJobs();
  resetLimiters();
});

describe.skipIf(!hasPostgres)('live · postgres · a named limiter across replicas', () => {
  let admin: PostgresClient;
  const clients: PostgresClient[] = [];
  const drivers: JobDriver[] = [];
  let executor: PgExecutor;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    for (let replica = 0; replica < 2; replica += 1) {
      const client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 8 } });
      clients.push(client);
      const exec: PgExecutor = {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          client.query<R>({ text, values }),
      };
      drivers.push(postgresJobDriver({ executor: exec }));
      if (replica === 0) executor = exec;
    }
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await clients[0]?.execute(raw(statement));
    }
  });

  beforeEach(async () => {
    resetJobs();
    resetLimiters();
    await executor.query('delete from x_jobs', []);
    await executor.query('delete from x_job_leases', []);
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('two replicas spend one budget: never past the rate in a window, nor the concurrency', async () => {
    const vendor = limiter('vendor-api', { rate: RATE, concurrency: CONCURRENCY });
    const gates = drivers.map((driver) =>
      limiterGate(vendor, { leases: () => ({ store: driver.leases, driver: driver.name }) }),
    );
    const seen = ledger();
    let refusals = 0;
    const RUNS = 12;
    let next = 0;
    // Each replica runs four loops at once, so a gate that granted per process would run eight.
    const loop = async (gate: (typeof gates)[number]): Promise<void> => {
      while (next < RUNS) {
        const runId = `run-${next}`;
        next += 1;
        for (;;) {
          try {
            const asked = performance.now();
            await gate.run('send', runId, () => seen.body(asked));
            break;
          } catch (error) {
            if (!isUltimateError(error) || error.code !== 'X_RATE_LIMITED') throw error;
            refusals += 1;
            // real-clock: the window is the database's, so the wait is too
            await Bun.sleep(15);
          }
        }
      }
    };
    await Promise.all(gates.flatMap((gate) => [loop(gate), loop(gate), loop(gate), loop(gate)]));

    expect(seen.starts).toHaveLength(RUNS);
    expect(seen.peak()).toBeLessThanOrEqual(CONCURRENCY);
    expect(tightestSpan(seen.starts, RATE.limit)).toBeGreaterThanOrEqual(
      RATE.windowMs - CLOCK_SLACK_MS,
    );
    expect(refusals).toBeGreaterThan(0);
  }, 30_000);

  // Rate only: both workers share this process's one gate, so its in-heap concurrency count would
  // hold the cap without Postgres — the replica test above is the one that proves concurrency.
  test('two job workers over two drivers: deferred uncounted, every run completes inside the rate', async () => {
    const vendor = limiter('vendor-rate', { rate: RATE });
    const seen = ledger();
    const send = job({
      name: 'limited-send',
      tenant: 'none',
      input: t.object({ n: t.number }),
      idempotencyKey: ({ n }) => `limited-send:${n}`,
      retry: { attempts: 1 },
      limiter: vendor,
      run: () => seen.body(performance.now()),
    });
    // The bodies resolve the ambient driver's store: one process, Postgres-backed either way.
    const uninstall = installJobDriver(drivers[0] as JobDriver);
    const workers = drivers.map((driver) =>
      jobWorker({
        driver,
        concurrency: 4,
        context: () => ctxOf({ role: 'worker', buildId: 'test' }),
        pollIntervalMs: 0,
        drainOnShutdown: false,
      }),
    );
    try {
      const RUNS = 10;
      for (let n = 0; n < RUNS; n += 1) await send.enqueue({ n });
      const deadline = performance.now() + 20_000;
      const done = async (): Promise<number> => {
        const rows = await executor.query<{ n: number }>(
          `select count(*)::int as n from x_jobs where state = 'done'`,
          [],
        );
        return rows[0]?.n ?? 0;
      };
      while ((await done()) < RUNS && performance.now() < deadline) {
        await Promise.all(workers.map((worker) => worker.tick()));
        // real-clock: a deferred row is due on the server's time
        await Bun.sleep(10);
      }
      expect(await done()).toBe(RUNS);
      const attempts = await executor.query<{ attempt: number }>('select attempt from x_jobs', []);
      // Every refusal was a deferral, never a spent attempt: `attempts: 1` and nothing dead.
      expect(attempts.every((row) => row.attempt === 1)).toBe(true);
      // The ask is the body's own start here (the worker hides the gate), so the bound is the
      // coarse one: ten starts at four a window span at least two whole windows.
      const started = seen.starts.map((one) => one.started).sort((a, b) => a - b);
      expect((started.at(-1) ?? 0) - (started[0] ?? 0)).toBeGreaterThanOrEqual(
        2 * RATE.windowMs - CLOCK_SLACK_MS,
      );
    } finally {
      for (const worker of workers) await worker.stop('test-end');
      uninstall();
    }
  }, 30_000);
});
