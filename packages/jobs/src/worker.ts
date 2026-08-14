// The `worker` role: per-queue pools, a claim loop, lease heartbeats, and a graceful drain on
// SIGTERM (stop claiming -> finish in-flight -> close). A worker that exits mid-job is not a
// bug here — the visibility timeout re-delivers it — but a worker that exits mid-job on EVERY
// deploy turns "at least once" into "always twice", so draining is on by default.

import type { Clock, Ctx } from '@ultimat3/core';
import {
  logger,
  onShutdown,
  recordJob,
  recordQueueDepth,
  reportError,
  uuid,
  withSpan,
} from '@ultimat3/core';
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

/**
 * How often the claim loop republishes `queue_depth`. Its own interval, not `pollIntervalMs`:
 * `driver.stats()` is an aggregate over the whole jobs table and a scrape reads the gauge every
 * ~15s, so publishing at the poll rate would multiply the queue's read load by sixty to write the
 * same number sixty times.
 */
const QUEUE_DEPTH_INTERVAL_MS = 15_000;

export type JobOutcome = 'completed' | 'suspended' | 'retried' | 'dead-lettered';

/**
 * `JobOutcome` -> the `jobs_total` label, and `null` for the outcome that is not one. `suspended`
 * is deliberately unmapped: parking a run is control flow, so counting it would make every
 * `step.sleep` read as a finished job and make the failure ratio meaningless.
 */
const JOB_OUTCOME_LABELS: Readonly<Record<JobOutcome, 'ok' | 'failed' | 'dead' | null>> =
  Object.freeze({
    completed: 'ok',
    suspended: null,
    retried: 'failed',
    'dead-lettered': 'dead',
  });

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
    // This package's ONE error-reporting call site, and it is here rather than in the loop because
    // this is the only frame that still holds the thrown value — the loop sees a message string.
    // A retry is a failure the framework recovered from, so it is a `warning`; a dead letter is
    // one nobody recovered from. `x jobs run` takes this path too, which is the point: one
    // execution path means one place a failed job can become visible.
    reportError(error, {
      source: 'job',
      severity: decision.retry ? 'warning' : 'error',
      scope: {
        operation: handle.name,
        extra: {
          jobId: claimed.id,
          runId: claimed.runId,
          attempt: claimed.attempt,
          retry: decision.retry,
        },
      },
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
  /**
   * Claim rounds in flight. Jobs land in `inFlight` mid-round, so a drain that waited only on
   * `inFlight` waited on a set the round it was racing had not finished filling.
   */
  const rounds = new Set<Promise<unknown>>();
  let state: WorkerStats['state'] = 'idle';
  let loop: ReturnType<typeof setTimeout> | undefined;
  /** The `onShutdown` registration this worker holds while it runs. Handed back by `stop()`. */
  let releaseShutdownHook: (() => void) | undefined;
  /** The teardown in flight, so a second `stop()` joins it instead of running a second one. */
  let stopping: Promise<void> | undefined;
  let processed = 0;
  let failed = 0;
  let suspended = 0;
  let deadLettered = 0;
  let depthPublishedAt = Number.NEGATIVE_INFINITY;

  /**
   * This package's ONE metrics call site: the `queue_depth` series `docker/helm`'s worker HPA
   * scales on. `ready` and not `ready + delayed` — the gauge means "waiting to be picked up", and
   * a job parked until Tuesday is not backlog no matter how many workers are added. Every queue
   * the driver reports, not only the ones this process serves, because depth is the queue's fact
   * and a queue no pod published is a queue no autoscaler can see.
   */
  const publishQueueDepth = async (): Promise<void> => {
    const now = nowMs(options.clock);
    if (now - depthPublishedAt < QUEUE_DEPTH_INTERVAL_MS) return;
    depthPublishedAt = now;
    try {
      for (const stat of await options.driver.stats()) recordQueueDepth(stat.queue, stat.ready);
    } catch (error) {
      // Instrumentation never costs a tick: a queue that cannot be measured must still be worked.
      logger.warn('jobs.worker.depth-failed', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

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

  /** The drain's one question: may this worker still take work off the queue? */
  const claiming = (): boolean => state !== 'draining' && state !== 'stopped';

  const claimRound = async (): Promise<readonly JobExecution[]> => {
    await publishQueueDepth();
    const results: JobExecution[] = [];

    for (const queue of queues) {
      // Re-read per queue, not once at the top: a `stop()` between two queues means "stop
      // claiming" now, not at the next tick. What this round already holds still runs to the end
      // — that is the drain, and `stop()` waits for it.
      if (!claiming()) break;
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
            // The other half of this package's metrics contract: `queue_depth` says how much work
            // is waiting, `jobs_total` says whether any of it is succeeding. Depth alone cannot
            // tell a drained queue from a queue nothing ever claimed. Labelled by QUEUE and
            // OUTCOME only — a label per job name is unbounded in an app's own vocabulary.
            const label = JOB_OUTCOME_LABELS[execution.outcome];
            if (label !== null) recordJob(queue, label);
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

  /**
   * One claim round, tracked. The guard and the registration are one synchronous step — no await
   * between them — so a round is either refused by a drain already under way or visible to every
   * drain that starts after it. A round that reached `claim()` first is the one `stop()` must
   * wait out: it is still adding to `inFlight`.
   */
  const tick = (): Promise<readonly JobExecution[]> => {
    if (!claiming()) return Promise.resolve([]);
    const round = claimRound().finally(() => {
      rounds.delete(round);
    });
    rounds.add(round);
    return round;
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

  const teardown = async (reason: string): Promise<void> => {
    state = 'draining';
    if (loop !== undefined) clearTimeout(loop);
    loop = undefined;
    logger.info('jobs.worker.draining', { workerId, reason, inFlight: inFlight.size });
    try {
      // Stop claiming, finish what we hold, then close. Anything else re-runs work on deploy.
      // Rounds first: one that passed the guard before the flag flipped is still awaiting its
      // `claim()`, and the jobs it starts join `inFlight` after any snapshot taken here — so a
      // drain that waited on `inFlight` alone closed the driver under a job that had just begun.
      await Promise.allSettled([...rounds]);
      await Promise.allSettled([...inFlight]);
      await options.driver.close?.();
    } finally {
      // Whatever the close did, this worker is done: a state left at 'draining' is a drain that
      // is not happening — `start()` refuses it for the rest of the process and `stats()` reports
      // a worker still finishing work it finished. And the hook goes back. It exists only to call
      // this, so one left registered drains a stopped worker on the next process-wide shutdown —
      // through a driver already closed — and keeps this closure, its driver and its in-flight
      // set alive with it.
      state = 'stopped';
      releaseShutdownHook?.();
      releaseShutdownHook = undefined;
    }
  };

  const stop = async (reason = 'stop'): Promise<void> => {
    if (state === 'stopped') return;
    // One teardown, joined rather than repeated: a SIGTERM landing on a manual stop must wait out
    // the same in-flight work, not close the driver a second time underneath it. Cleared as it
    // settles, so a worker that started again tears down again instead of joining a promise that
    // settled a lifetime ago. A close that threw still stopped this worker — the failure is the
    // caller's to see on the promise it awaited, not a teardown to run twice.
    stopping ??= teardown(reason).finally(() => {
      stopping = undefined;
    });
    await stopping;
  };

  return {
    start() {
      // Only from a standstill. A start mid-drain would put the claim loop back on a driver the
      // drain is about to close, and stack a second shutdown hook on the one still running.
      if (state !== 'idle' && state !== 'stopped') return;
      state = 'running';
      logger.info('jobs.worker.started', { workerId, queues });
      // 'accept' phase: stop claiming before core waits on in-flight jobs. The unregister is
      // kept, never discarded: `stop()` hands it back, so start -> stop -> start holds ONE hook
      // rather than one per start, each retaining the driver of a worker that is already gone.
      if (options.drainOnShutdown !== false) {
        releaseShutdownHook = onShutdown(`jobs.worker.${workerId}`, () => stop('SIGTERM'), {
          phase: 'accept',
        });
      }
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
