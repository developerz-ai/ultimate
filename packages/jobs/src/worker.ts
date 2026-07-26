// The `worker` role: per-queue pools, a claim loop, lease heartbeats, and a graceful drain on
// SIGTERM (stop claiming -> finish in-flight -> close). A worker that exits mid-job is not a
// bug here — the visibility timeout re-delivers it — but a worker that exits mid-job on EVERY
// deploy turns "at least once" into "always twice", so draining is on by default.

import type { Clock, Ctx } from '@ultimat3/core';
import { logger, onShutdown, uuid, withSpan } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver, QueueStats } from './driver';
import { DEFAULT_QUEUE, DEFAULT_VISIBILITY_TIMEOUT_MS } from './driver';
import { JobTimeoutError } from './errors';
import { eventBus } from './events';
import type { AnyJobHandle } from './job';
import { getJob } from './job';
import type { Limiter } from './limits';
import { createLimiter } from './limits';
import { nextRetry } from './retry';
import type { EventLookup, StepRecord } from './steps';
import { createStepRunner, isStepSuspension } from './steps';

export type JobOutcome = 'completed' | 'suspended' | 'retried' | 'dead-lettered';

export interface JobExecution {
  readonly outcome: JobOutcome;
  readonly jobId: string;
  readonly job: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly resumeAt?: number;
  readonly error?: string;
  readonly steps: readonly StepRecord[];
  readonly replayed: readonly string[];
}

export interface ExecuteJobOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  readonly handle: AnyJobHandle;
  readonly ctx: Ctx;
  readonly clock?: Clock;
  readonly events?: EventLookup;
}

/**
 * Run one claimed job to completion, suspension or failure, and settle it with the driver.
 * Shared by the worker loop and `x jobs run` so both take exactly the same code path.
 */
export async function executeJob(options: ExecuteJobOptions): Promise<JobExecution> {
  const { driver, claimed, handle } = options;
  const startedAt = nowMs(options.clock);
  const runner = createStepRunner({
    runId: claimed.runId,
    jobName: handle.name,
    store: driver.steps,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    events: options.events ?? eventBus(),
  });

  const settle = async (outcome: JobExecution): Promise<JobExecution> => {
    const steps = await driver.steps.list(claimed.runId);
    return { ...outcome, steps, replayed: runner.replayedNames() };
  };

  try {
    const input = handle.parse(claimed.input);
    const work = handle.run({
      input,
      step: runner.step,
      ctx: options.ctx,
      attempt: claimed.attempt,
      jobId: claimed.id,
      runId: claimed.runId,
    });

    await (handle.timeoutMs === undefined
      ? work
      : raceTimeout(work, handle.timeoutMs, handle.name));

    await driver.ack(claimed.id);
    return settle({
      outcome: 'completed',
      jobId: claimed.id,
      job: handle.name,
      attempt: claimed.attempt,
      durationMs: nowMs(options.clock) - startedAt,
      steps: [],
      replayed: [],
    });
  } catch (error) {
    if (isStepSuspension(error)) {
      const delayMs = Math.max(0, error.resumeAt - nowMs(options.clock));
      // countsAsAttempt: false — parking a run is not a failure.
      await driver.nack(claimed.id, { delayMs, countsAsAttempt: false });
      return settle({
        outcome: 'suspended',
        jobId: claimed.id,
        job: handle.name,
        attempt: claimed.attempt,
        durationMs: nowMs(options.clock) - startedAt,
        resumeAt: error.resumeAt,
        steps: [],
        replayed: [],
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    const decision = nextRetry(handle.retry, claimed.attempt);
    await driver.nack(claimed.id, {
      delayMs: decision.delayMs,
      error: message,
      countsAsAttempt: true,
      deadLetter: !decision.retry && decision.deadLetter,
    });
    logger.warn('jobs.attempt.failed', {
      job: handle.name,
      jobId: claimed.id,
      attempt: claimed.attempt,
      retry: decision.retry,
      error: message,
    });
    return settle({
      outcome: decision.retry ? 'retried' : 'dead-lettered',
      jobId: claimed.id,
      job: handle.name,
      attempt: claimed.attempt,
      durationMs: nowMs(options.clock) - startedAt,
      error: message,
      steps: [],
      replayed: [],
    });
  }
}

function raceTimeout(work: Promise<unknown>, timeoutMs: number, job: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new JobTimeoutError({ job, timeoutMs })), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface WorkerOptions {
  readonly driver: JobDriver;
  /** Queues this process serves. Default `['default']`. */
  readonly queues?: readonly string[];
  /** Slots per queue. A number applies to every queue. */
  readonly concurrency?: number | Readonly<Record<string, number>>;
  readonly limiter?: Limiter;
  readonly clock?: Clock;
  readonly events?: EventLookup;
  /** Supplies the ambient Ctx for a job run; the app wires ALS + tenant here. */
  readonly context: () => Ctx;
  readonly visibilityTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly workerId?: string;
  /** Default true. Registers a SIGTERM drain via `onShutdown`. */
  readonly drainOnShutdown?: boolean;
}

export interface WorkerStats {
  readonly workerId: string;
  readonly queues: readonly string[];
  readonly state: 'idle' | 'running' | 'draining' | 'stopped';
  readonly inFlight: number;
  readonly processed: number;
  readonly failed: number;
  readonly suspended: number;
  readonly deadLettered: number;
  readonly queueDepth: readonly QueueStats[];
}

export interface Worker {
  start(): void;
  /** One claim+run round. Returns jobs processed. Tests drive this instead of the timer. */
  tick(): Promise<readonly JobExecution[]>;
  stop(reason?: string): Promise<void>;
  stats(): Promise<WorkerStats>;
}

export function createWorker(options: WorkerOptions): Worker {
  const workerId = options.workerId ?? `worker-${uuid()}`;
  const queues = options.queues ?? [DEFAULT_QUEUE];
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(visibilityTimeoutMs / 3);
  const slotsFor = (queue: string): number =>
    typeof options.concurrency === 'number'
      ? options.concurrency
      : (options.concurrency?.[queue] ?? 5);
  const limiter = options.limiter ?? createLimiter({});

  const inFlight = new Set<Promise<unknown>>();
  let state: WorkerStats['state'] = 'idle';
  let loop: ReturnType<typeof setTimeout> | undefined;
  let processed = 0;
  let failed = 0;
  let suspended = 0;
  let deadLettered = 0;

  const runClaimed = async (claimed: ClaimedJob): Promise<JobExecution> => {
    const handle = getJob(claimed.name);
    if (handle === undefined) {
      // Unknown job name: almost always a deploy skew. Park it, do not burn attempts.
      await options.driver.nack(claimed.id, {
        delayMs: 30_000,
        error: `no job registered as "${claimed.name}"`,
        countsAsAttempt: false,
      });
      return {
        outcome: 'suspended',
        jobId: claimed.id,
        job: claimed.name,
        attempt: claimed.attempt,
        durationMs: 0,
        error: `no job registered as "${claimed.name}"`,
        steps: [],
        replayed: [],
      };
    }

    const heartbeat = setInterval(() => {
      void options.driver.heartbeat(claimed.id, { visibilityTimeoutMs }).catch(() => undefined);
    }, heartbeatIntervalMs);

    try {
      return await withSpan(`job.${handle.name}`, () =>
        executeJob({
          driver: options.driver,
          claimed,
          handle,
          ctx: options.context(),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.events === undefined ? {} : { events: options.events }),
        }),
      );
    } finally {
      clearInterval(heartbeat);
    }
  };

  const tick = async (): Promise<readonly JobExecution[]> => {
    if (state === 'draining' || state === 'stopped') return [];
    const results: JobExecution[] = [];

    for (const queue of queues) {
      const free = Math.max(0, slotsFor(queue) - limiter.inFlight({ queue }));
      if (free === 0) continue;

      const claimed = await options.driver.claim({
        queues: [queue],
        limit: free,
        visibilityTimeoutMs,
        workerId,
      });

      for (const job of claimed) {
        const lease = limiter.tryAcquire({
          queue,
          ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }),
        });
        if (lease === undefined) {
          // Over a tenant/queue/global cap: hand it straight back for another worker.
          await options.driver.nack(job.id, {
            delayMs: pollIntervalMs,
            countsAsAttempt: false,
            error: `limited: ${limiter.blockedBy({ queue, ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }) }) ?? 'unknown'}`,
          });
          continue;
        }

        const running = runClaimed(job)
          .then((execution) => {
            results.push(execution);
            if (execution.outcome === 'completed') processed += 1;
            else if (execution.outcome === 'suspended') suspended += 1;
            else if (execution.outcome === 'retried') failed += 1;
            else deadLettered += 1;
            return execution;
          })
          .finally(() => {
            lease.release();
          });

        inFlight.add(running);
        void running.finally(() => inFlight.delete(running));
      }
    }

    await Promise.allSettled([...inFlight]);
    return results;
  };

  const schedule = (): void => {
    loop = setTimeout(() => {
      void tick()
        .catch((error: unknown) => {
          logger.error('jobs.worker.tick-failed', {
            workerId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (state === 'running') schedule();
        });
    }, pollIntervalMs);
  };

  const stop = async (reason = 'stop'): Promise<void> => {
    if (state === 'stopped') return;
    state = 'draining';
    if (loop !== undefined) clearTimeout(loop);
    loop = undefined;
    logger.info('jobs.worker.draining', { workerId, reason, inFlight: inFlight.size });
    // Stop claiming, finish what we hold, then close. Anything else re-runs work on deploy.
    await Promise.allSettled([...inFlight]);
    await options.driver.close?.();
    state = 'stopped';
  };

  return {
    start() {
      if (state === 'running') return;
      state = 'running';
      logger.info('jobs.worker.started', { workerId, queues });
      if (options.drainOnShutdown !== false) onShutdown(() => stop('SIGTERM'));
      schedule();
    },
    tick,
    stop,
    async stats(): Promise<WorkerStats> {
      return {
        workerId,
        queues,
        state,
        inFlight: inFlight.size,
        processed,
        failed,
        suspended,
        deadLettered,
        queueDepth: [...(await options.driver.stats())],
      };
    },
  };
}
