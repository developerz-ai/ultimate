// `maxInFlight`: one cap on the runs a worker PROCESS holds across every queue, under which the
// per-queue slots still bound each pool. What it must hold: never one claim over the cap however
// many queues have room, a claim back the moment a run ends, every free slot handed to a queue
// with work, no queue starved by a busier one, and the drain unchanged at the cap.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, collectMetrics, ctxOf, resetMetrics, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimOptions, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

const passthrough = <T>(): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as T }),
  },
});

interface Parked {
  /** Run ids (`<queue>:<n>`) whose body has started and not been released. */
  readonly running: string[];
  /** Every run that started, in start order. */
  readonly started: string[];
  /** End the body of one run. */
  release(id: string): void;
  /** Resolves once `count` bodies have started in all. */
  startedAtLeast(count: number): Promise<void>;
}

/** One job per queue whose body parks until the test releases it by id. */
function parkedJobs(queues: readonly string[]): Parked {
  const running: string[] = [];
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let waiters: { count: number; done: () => void }[] = [];
  for (const queue of queues) {
    job({
      tenant: 'none',
      name: `park_${queue.replace(/-/g, '_')}`,
      queue,
      input: passthrough<{ id: string }>(),
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1, jitter: false },
      run: async ({ input }) => {
        running.push(input.id);
        started.push(input.id);
        waiters = waiters.filter((waiter) => {
          if (started.length < waiter.count) return true;
          waiter.done();
          return false;
        });
        await new Promise<void>((resolve) => gates.set(input.id, resolve));
        running.splice(running.indexOf(input.id), 1);
      },
    });
  }
  return {
    running,
    started,
    release: (id) => gates.get(id)?.(),
    startedAtLeast: (count) =>
      started.length >= count
        ? Promise.resolve()
        : new Promise((done) => {
            waiters.push({ count, done });
          }),
  };
}

const enqueue = async (driver: JobDriver, queue: string, count: number): Promise<void> => {
  for (let n = 1; n <= count; n += 1) {
    await driver.enqueue({
      name: `park_${queue.replace(/-/g, '_')}`,
      queue,
      input: { id: `${queue}:${n}` },
      idempotencyKey: `${queue}:${n}`,
      maxAttempts: 1,
    });
  }
};

const byQueue = (ids: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const queue = id.split(':')[0] ?? '';
    counts[queue] = (counts[queue] ?? 0) + 1;
  }
  return counts;
};

/** Lets every pending settle and the next claim pass finish without a timer. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await Bun.sleep(0);
};

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetJobs();
  resetMetrics();
});

describe('maxInFlight caps the process across every queue', () => {
  test('three queues each with free slots never hold more than the cap', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const asked: number[] = [];
    const base = memoryJobDriver();
    const driver: JobDriver = {
      ...base,
      claim(options: ClaimOptions) {
        asked.push(options.limit);
        return base.claim(options);
      },
    };
    for (const queue of ['a', 'b', 'c']) await enqueue(driver, queue, 4);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: 4,
      maxInFlight: 5,
      context,
      drainOnShutdown: false,
    });

    void worker.tick();
    await parked.startedAtLeast(5);
    await settle();
    expect(parked.running).toHaveLength(5);
    // Split, not first-come: a queue listed first does not take the whole cap.
    expect(byQueue(parked.running)).toEqual({ a: 2, b: 2, c: 1 });
    // Claimed under the cap, never claimed and shed: no ask was ever for more than the room left.
    expect(asked.every((limit) => limit <= 5)).toBe(true);

    // At the cap a pass asks the queue for nothing at all.
    const before = asked.length;
    expect(await worker.tick()).toEqual([]);
    expect(asked.length).toBe(before);
    expect(parked.running).toHaveLength(5);

    const stats = await worker.stats();
    expect(stats.inFlight).toBe(5);
    expect(stats.maxInFlight).toBe(5);

    for (const id of [...parked.started]) parked.release(id);
    await worker.stop();
  });

  test('a run that ends frees exactly one claim, and its finish kicks the pass that takes it', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const driver = memoryJobDriver();
    for (const queue of ['a', 'b', 'c']) await enqueue(driver, queue, 4);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: 4,
      maxInFlight: 3,
      pollIntervalMs: 20,
      idlePollMaxMs: 60_000,
      context,
      drainOnShutdown: false,
    });

    worker.start();
    await parked.startedAtLeast(3);
    // At the cap every pass finds nothing, so the loop backs off. Caught the moment it arms an
    // 800 ms wait, the refill below cannot be the poll's: only the finish's own `kick` brings the
    // next pass inside 300 ms.
    while ((await worker.stats()).pollDelayMs < 800) await Bun.sleep(5);
    expect(parked.running).toHaveLength(3);

    const first = parked.running[0] ?? '';
    parked.release(first);
    const refilled = await Promise.race([
      parked.startedAtLeast(4).then(() => true),
      Bun.sleep(300).then(() => false),
    ]);
    expect(refilled).toBe(true);
    await settle();
    expect(parked.running).toHaveLength(3);
    expect(parked.running).not.toContain(first);

    const stopping = worker.stop('test');
    for (const id of [...parked.running]) parked.release(id);
    await stopping;
  });

  test('a busy worker at the cap hands each freed slot on by turn, its loop idling between', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'a', 20);
    await enqueue(driver, 'b', 2);
    await enqueue(driver, 'c', 2);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: 8,
      maxInFlight: 1,
      pollIntervalMs: 1,
      idlePollMaxMs: 20,
      context,
      drainOnShutdown: false,
    });

    worker.start();
    for (let round = 1; round <= 6; round += 1) {
      await parked.startedAtLeast(round);
      // Long enough for the loop to go idle at the cap: the next pass is an IDLE one, which once
      // asked every queue in one statement and took the oldest row — `a`'s, twenty deep.
      await Bun.sleep(30);
      expect(parked.running).toHaveLength(1);
      parked.release(parked.running[0] ?? '');
    }
    expect(parked.started.slice(0, 6).map((id) => id.split(':')[0])).toEqual([
      'a',
      'b',
      'c',
      'a',
      'b',
      'c',
    ]);
    const stopping = worker.stop('test');
    for (const id of [...parked.running]) parked.release(id);
    await stopping;
  });

  test('the per-queue slots still bound each queue under a looser cap', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const driver = memoryJobDriver();
    for (const queue of ['a', 'b', 'c']) await enqueue(driver, queue, 4);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: { a: 1, b: 2, c: 1 },
      maxInFlight: 10,
      context,
      drainOnShutdown: false,
    });

    void worker.tick();
    await parked.startedAtLeast(4);
    await settle();
    expect(byQueue(parked.running)).toEqual({ a: 1, b: 2, c: 1 });

    for (const id of [...parked.started]) parked.release(id);
    await worker.stop();
  });

  test('a free slot goes to a queue with work, never left idle behind an empty one', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'c', 5);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: 4,
      maxInFlight: 4,
      context,
      drainOnShutdown: false,
    });

    void worker.tick();
    await parked.startedAtLeast(4);
    await settle();
    // `a` and `b` are empty: their shares flow to `c`, up to its own four slots.
    expect(byQueue(parked.running)).toEqual({ c: 4 });

    for (const id of [...parked.started]) parked.release(id);
    await worker.stop();
  });

  test('a backlogged queue cannot starve the others: freed slots go round in turn', async () => {
    const parked = parkedJobs(['a', 'b', 'c']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'a', 20);
    await enqueue(driver, 'b', 2);
    await enqueue(driver, 'c', 2);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b', 'c'],
      concurrency: 8,
      maxInFlight: 1,
      context,
      drainOnShutdown: false,
    });

    // One slot, freed and refilled six times: with `a` first in the list and twenty deep, a
    // first-listed-wins pass would run `a` six times.
    for (let round = 1; round <= 6; round += 1) {
      void worker.tick();
      await parked.startedAtLeast(round);
      await settle();
      expect(parked.running).toHaveLength(1);
      parked.release(parked.running[0] ?? '');
      await settle();
    }
    expect(parked.started.map((id) => id.split(':')[0])).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);

    await worker.stop();
  });

  test('the drain at the cap waits for every held run and claims nothing more', async () => {
    const parked = parkedJobs(['a', 'b']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'a', 3);
    await enqueue(driver, 'b', 3);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b'],
      concurrency: 3,
      maxInFlight: 2,
      pollIntervalMs: 1,
      context,
      drainOnShutdown: false,
    });

    worker.start();
    await parked.startedAtLeast(2);
    let stopped = false;
    const stopping = worker.stop('deploy').then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    for (const id of [...parked.running]) parked.release(id);
    await stopping;
    // The two held runs finished; their freed claims went to none of the four rows left, though
    // a 1 ms poll had every chance to take them.
    await Bun.sleep(10);
    expect(parked.started).toHaveLength(2);
    expect((await worker.stats()).state).toBe('stopped');
  });

  test('no cap is the worker it always was: stats say null, the slots alone bound it', async () => {
    const parked = parkedJobs(['a', 'b']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'a', 3);
    await enqueue(driver, 'b', 3);
    const worker = jobWorker({
      driver,
      queues: ['a', 'b'],
      concurrency: 3,
      context,
      drainOnShutdown: false,
    });

    void worker.tick();
    await parked.startedAtLeast(6);
    expect((await worker.stats()).maxInFlight).toBeNull();

    for (const id of [...parked.started]) parked.release(id);
    await worker.stop();
  });
});

describe('what a scaler reads', () => {
  const gauge = (name: string): number =>
    collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points[0]?.value ??
    0;

  // Read as a delta over what the process already counts: a worker another test left live in this
  // process is part of the process, which is the point of an unlabelled gauge.
  test('two workers in one process SUM: in-flight and capacity (the tighter of cap and slots)', async () => {
    const parked = parkedJobs(['a', 'b']);
    const driver = memoryJobDriver();
    await enqueue(driver, 'a', 3);
    await enqueue(driver, 'b', 3);
    // `beforeEach` zeroed the series, not the workers: a worker stopped here republishes both
    // sums as the process holds them, which is the baseline.
    await jobWorker({ driver: memoryJobDriver(), context, drainOnShutdown: false }).stop();
    const capacity = gauge('job_worker_capacity');
    const inFlight = gauge('job_worker_in_flight');
    const capped = jobWorker({
      driver,
      queues: ['a'],
      concurrency: 4,
      maxInFlight: 2,
      context,
      drainOnShutdown: false,
    });
    const uncapped = jobWorker({
      driver,
      queues: ['b'],
      concurrency: 3,
      context,
      drainOnShutdown: false,
    });
    // Constructing the second worker must not reset the first's numbers: 2 + 3.
    expect(gauge('job_worker_capacity') - capacity).toBe(5);

    void capped.tick();
    void uncapped.tick();
    await parked.startedAtLeast(5);
    await settle();
    expect(gauge('job_worker_in_flight') - inFlight).toBe(5);

    for (const id of [...parked.started]) parked.release(id);
    await settle();
    expect(gauge('job_worker_in_flight') - inFlight).toBe(0);
    await capped.stop();
    // A stopped worker leaves the process's capacity; the other's stays.
    expect(gauge('job_worker_capacity') - capacity).toBe(3);
    await uncapped.stop();
    expect(gauge('job_worker_capacity') - capacity).toBe(0);
  });
});

describe('a cap that is not a count is refused where it is written', () => {
  test('0, negative, fractional, NaN and Infinity are each X_INVARIANT naming maxInFlight', () => {
    for (const maxInFlight of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let thrown: unknown;
      try {
        jobWorker({ driver: memoryJobDriver(), maxInFlight, context, drainOnShutdown: false });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, String(maxInFlight)).toBeInstanceOf(UltimateError);
      const refusal = thrown instanceof UltimateError ? thrown : undefined;
      expect(refusal?.code).toBe('X_INVARIANT');
      expect(`${refusal?.cause}`).toContain('maxInFlight');
    }
  });
});
