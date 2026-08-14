// The live soak: several real workers (`start()`/`stop()`, real poll loops — not `tick()` driven
// by hand) against one shared queue, with one or more workers "killed" mid-flight the way a
// deploy or an OOM actually kills a worker: its connection to the queue goes dead, never a clean
// `stop()`. What must hold no matter how many workers die mid-job: every job still reaches a
// terminal state (no orphan stuck `running` forever) and the unit of work behind each job runs
// exactly once (no double-execution) — a reclaimed job replays its finished steps rather than
// redoing them and the two never race each other for the same row.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, ClaimOptions, EnqueueResult, JobDriver, NackOptions } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

interface ChaosDriver {
  readonly driver: JobDriver;
  /** From now on, this worker's queue calls fail the way a dead connection fails: rejected or
   *  empty, never hung — a real crash does not leave the test process waiting either. */
  kill(workerId: string): void;
  claimedBy(jobId: string): string | undefined;
}

/** Wraps a real driver so a "killed" worker can no longer claim, ack, nack or heartbeat —
 *  everything a process that has actually died can no longer do — while every OTHER worker on
 *  the same driver is untouched. */
function chaosDriver(base: JobDriver): ChaosDriver {
  const dead = new Set<string>();
  const owner = new Map<string, string>();
  const severed = (): Error => new Error('simulated connection loss');

  const driver: JobDriver = {
    ...base,
    async claim(options: ClaimOptions): Promise<readonly ClaimedJob[]> {
      if (dead.has(options.workerId)) return [];
      const claimed = await base.claim(options);
      for (const claim of claimed) owner.set(claim.id, options.workerId);
      return claimed;
    },
    async heartbeat(jobId, heartbeatOptions): Promise<void> {
      if (dead.has(owner.get(jobId) ?? '')) throw severed();
      await base.heartbeat(jobId, heartbeatOptions);
    },
    async ack(jobId: string): Promise<void> {
      if (dead.has(owner.get(jobId) ?? '')) throw severed();
      await base.ack(jobId);
    },
    async nack(jobId: string, nackOptions: NackOptions): Promise<void> {
      if (dead.has(owner.get(jobId) ?? '')) throw severed();
      await base.nack(jobId, nackOptions);
    },
  };

  return {
    driver,
    kill: (workerId) => dead.add(workerId),
    claimedBy: (jobId) => owner.get(jobId),
  };
}

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

afterEach(() => {
  resetJobs();
});

describe('N real workers, one killed mid-flight, under load', () => {
  test('every job finishes exactly once, none left orphaned', async () => {
    const NUM_JOBS = 10;
    const VISIBILITY_MS = 10_000;
    const clock = frozenClock(0);
    const chaos = chaosDriver(createMemoryDriver({ clock }));
    const resumeGate = gate();

    const executing = new Set<string>();
    const violations: string[] = [];
    const started: string[] = [];
    // Populated below, once the two designated "chaos" jobs have real ids — declared first so
    // `run` closes over this same set rather than one rebound later.
    const chaosJobIds = new Set<string>();

    const handle = job<{ n: number }>({
      name: 'soakJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `soak:${n}`,
      retry: { attempts: 5, backoff: 'fixed', delay: 0, jitter: false },
      run: async ({ jobId, step, attempt }) => {
        if (executing.has(jobId)) violations.push(`concurrent execution of ${jobId}`);
        executing.add(jobId);
        try {
          await step.run('work', async () => {
            started.push(jobId);
            await Bun.sleep(5);
            return 'ok';
          });
          // Only the FIRST attempt at the two designated "chaos" jobs parks here — long enough
          // for the test to sever its claimant's connection and roll the clock forward, exactly
          // the window a real crash would open between "did the work" and "told the queue".
          if (chaosJobIds.has(jobId) && attempt === 1) await resumeGate.passed;
        } finally {
          executing.delete(jobId);
        }
      },
    });

    const enqueued: EnqueueResult[] = [];
    for (let n = 1; n <= NUM_JOBS; n += 1) {
      enqueued.push(
        await chaos.driver.enqueue({
          name: 'soakJob',
          queue: 'default',
          input: { n },
          idempotencyKey: handle.idempotencyKeyFor({ n }),
          maxAttempts: handle.retry.attempts,
        }),
      );
    }
    const [chaosOne, chaosTwo] = enqueued;
    if (chaosOne === undefined || chaosTwo === undefined) {
      throw new Error('expected at least two enqueued jobs to designate as chaos jobs');
    }
    chaosJobIds.add(chaosOne.id);
    chaosJobIds.add(chaosTwo.id);

    const workers = Array.from({ length: 3 }, () =>
      createWorker({
        driver: chaos.driver,
        context,
        clock,
        drainOnShutdown: false,
        pollIntervalMs: 5,
        visibilityTimeoutMs: VISIBILITY_MS,
      }),
    );
    for (const worker of workers) worker.start();

    let doneCount = 0;
    let deadCount = 0;
    try {
      // Both chaos jobs have paid for their work and are now parked on the gate — this is the
      // exact instant a real worker's process would die mid-job.
      await waitFor(async () => {
        for (const jobId of chaosJobIds) {
          const runId = enqueued.find((row) => row.id === jobId)?.runId ?? '';
          const step = await chaos.driver.steps.get(runId, 'work');
          if (step?.status !== 'completed') return false;
        }
        return true;
      }, 'both chaos jobs finished their work and are parked');

      const killed = new Set<string>();
      for (const jobId of chaosJobIds) {
        const owner = chaos.claimedBy(jobId);
        if (owner !== undefined) killed.add(owner);
      }
      expect(killed.size).toBeGreaterThan(0);
      for (const workerId of killed) chaos.kill(workerId);

      // The lease those dead workers held is now unrenewable and unackable — advance past its
      // visibility window, the only legal way for a lease to expire in this test.
      clock.advance(VISIBILITY_MS + 1);
      // Release the parked attempts: their ack/nack now fails the way a dead connection fails,
      // which is exactly what proves a killed worker cannot silently finish its job late.
      resumeGate.open();

      await waitFor(async () => {
        const done = (await chaos.driver.introspect?.list({ state: 'done' })) ?? [];
        const dead = (await chaos.driver.introspect?.list({ state: 'dead' })) ?? [];
        return done.length + dead.length === NUM_JOBS;
      }, 'every job reaches a terminal state');
      // Captured before stop(): every worker's teardown closes the SAME shared driver, and the
      // memory driver's close() clears its jobs map on the first one to get there.
      doneCount = ((await chaos.driver.introspect?.list({ state: 'done' })) ?? []).length;
      deadCount = ((await chaos.driver.introspect?.list({ state: 'dead' })) ?? []).length;
    } finally {
      await Promise.all(workers.map((worker) => worker.stop('test-end')));
    }

    // No orphan: every enqueued job is accounted for, none left stuck `running`/`ready`.
    expect(doneCount).toBe(NUM_JOBS);
    expect(deadCount).toBe(0);
    // No double-execution: the concurrency guard never tripped, and each job's actual unit of
    // work — the part `step.run` cannot replay away — ran exactly once, even the two that were
    // reclaimed after their original claimant went dark.
    expect(violations).toEqual([]);
    expect(started.length).toBe(NUM_JOBS);
    expect(new Set(started).size).toBe(NUM_JOBS);
    expect(executing.size).toBe(0);
  });
});
