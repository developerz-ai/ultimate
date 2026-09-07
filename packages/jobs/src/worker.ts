// The `worker` role: per-queue pools, a claim loop, lease heartbeats, and a graceful drain on
// SIGTERM (stop claiming -> finish in-flight -> close). A worker that exits mid-job is not a
// bug here — the visibility timeout re-delivers it — but a worker that exits mid-job on EVERY
// deploy turns "at least once" into "always twice", so draining is on by default.

import type { ShutdownReason } from '@ultimat3/core';
import {
  beginWork,
  logger,
  onShutdown,
  recordJob,
  recordQueueDepth,
  renderThrowable,
  uuid,
} from '@ultimat3/core';
import { nowMs } from './clock';
import { createDrainBudget, settleAllBy } from './drain-wait';
import type { ClaimedJob } from './driver';
import { DEFAULT_QUEUE } from './driver';
import { ConcurrencyUnenforceableError, JobDrainedError } from './errors';
import type { JobExecution } from './execute';
import { getJob, registeredJobs } from './job';
import { createLimiter } from './limits';
import { JOB_OUTCOME_LABELS, recordQueueDeadJobs, recordQueueOldestReady } from './metrics';
import { createFleetSlots } from './worker-fleet-slots';
import { resolveWorkerTimings } from './worker-options';
import { runClaimedJob } from './worker-run';
import type { Worker, WorkerOptions, WorkerStats } from './worker-types';

/**
 * How often the claim loop republishes `queue_depth`. Its own interval, not `pollIntervalMs`:
 * `driver.stats()` is an aggregate over the whole jobs table and a scrape reads the gauge every
 * ~15s, so publishing at the poll rate would multiply the queue's read load by sixty to write the
 * same number sixty times.
 */
const QUEUE_DEPTH_INTERVAL_MS = 15_000;

export type { Worker, WorkerOptions, WorkerStats } from './worker-types';

export function createWorker(options: WorkerOptions): Worker {
  const workerId = options.workerId ?? `worker-${uuid()}`;
  const queues = options.queues ?? [DEFAULT_QUEUE];
  // Every numeric knob, read and refused in one place — `worker-options.ts` says why a non-finite
  // one is a refusal rather than a clamp, and carries the slot table's own-key read with it.
  const { visibilityTimeoutMs, pollIntervalMs, heartbeatIntervalMs, slotsFor } =
    resolveWorkerTimings(options);
  const limiter = options.limiter ?? createLimiter({});
  const driverLeases = options.driver.leases;
  // `job.concurrency`, held as a row every replica sees. The TTL is the visibility timeout and the
  // renewal rides the lease heartbeat's interval — `worker-fleet-slots.ts` says why both.
  const fleetSlots = createFleetSlots({
    leases: driverLeases,
    workerId,
    ttlMs: visibilityTimeoutMs,
    renewIntervalMs: heartbeatIntervalMs,
  });

  const inFlight = new Set<Promise<unknown>>();
  /**
   * Claim rounds in flight. Jobs land in `inFlight` mid-round, so a drain that waited only on
   * `inFlight` waited on a set the round it was racing had not finished filling.
   */
  const rounds = new Set<Promise<unknown>>();
  /**
   * The drain, as every run this worker starts hears it: composed into each run's `ctx.signal`
   * (`worker-run.ts`), aborted by the `accept` hook with a `JobDrainedError`. ONE controller and
   * not one per run, because the fact it carries — "this process is going away" — is one fact.
   * Replaced with a fresh one when a teardown ends: a controller aborted once stays aborted, and
   * a restarted worker would otherwise hand every job it claimed a signal born cancelled.
   */
  let drainSignal = new AbortController();
  /**
   * The deadline the teardown waits under. `undefined` for a manual `stop()`, bound the moment a
   * shutdown lands — and bound LATE when that shutdown lands on a teardown already in flight: the
   * `close` hook joins the memoised `stopping` rather than starting a second, and until 2026-09-07
   * the teardown it joined kept the `undefined` it was started with. Core abandoned the hook at
   * the deadline; the worker sat on a body ignoring `ctx.signal` with its driver open. Fresh per
   * teardown, for the controller's reason: a restarted worker's manual stop is unbounded again.
   */
  let budget = createDrainBudget();
  let state: WorkerStats['state'] = 'idle';
  let loop: ReturnType<typeof setTimeout> | undefined;
  /**
   * The two `onShutdown` registrations this worker holds while it runs, both handed back by
   * `stop()`. Two, because they answer different questions in different PHASES — the split
   * `listenSyncNode` and `@ultimat3/http` already have.
   */
  let releaseShutdownHooks: (() => void)[] = [];
  /** The teardown in flight, so a second `stop()` joins it instead of running a second one. */
  let stopping: Promise<void> | undefined;
  let processed = 0;
  let failed = 0;
  let suspended = 0;
  let deadLettered = 0;
  let interrupted = 0;
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
      for (const stat of await options.driver.stats()) {
        recordQueueDepth(stat.queue, stat.ready);
        // Depth alone is not alertable: it cannot tell "10 jobs stuck for an hour" from "10 jobs
        // enqueued a second ago", and `jobs_total{outcome="dead"}` is a rate, so a dead-letter
        // queue that filled overnight and stopped growing pages nobody. Both numbers are already
        // in `stats()` — this queries nothing new.
        recordQueueOldestReady(stat.queue, stat.oldestReadyMs);
        recordQueueDeadJobs(stat.queue, stat.dead);
      }
    } catch (error) {
      // Instrumentation never costs a tick: a queue that cannot be measured must still be worked.
      logger.warn('jobs.worker.depth-failed', {
        workerId,
        error: renderThrowable(error),
      });
    }
  };

  /** One claimed job, run under its lease, its slot and its span. `worker-run.ts` owns the wiring. */
  const runClaimed = (claimed: ClaimedJob): Promise<JobExecution> =>
    runClaimedJob({
      driver: options.driver,
      claimed,
      context: options.context,
      fleetSlots,
      workerId,
      visibilityTimeoutMs,
      heartbeatIntervalMs,
      drain: drainSignal.signal,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });

  /**
   * A claimed job handed straight back over a cap. It is NOT a suspension and NOT a failure: no
   * `park`, so the row stays where `queue_depth` and `queue_oldest_ready_seconds` can see it, and
   * no `error`, so `x jobs show` does not report a `lastError` for a job that never ran. It was
   * both of those until 2026-08 — parked beside a 3-day `step.sleep`, and stamped with a failure
   * it never had — which is why the two sheds go through one function now.
   */
  const shed = async (
    claimed: ClaimedJob,
    detail: { readonly queue: string; readonly reason: string },
  ): Promise<void> => {
    logger.debug('jobs.worker.shed', {
      workerId,
      job: claimed.name,
      jobId: claimed.id,
      ...detail,
    });
    await options.driver.nack(claimed.id, { delayMs: pollIntervalMs, countsAsAttempt: false });
  };

  /** The drain's one question: may this worker still take work off the queue? */
  const claiming = (): boolean => state !== 'draining' && state !== 'stopped';

  /**
   * One claim pass: every queue asked once, and everything it hands back STARTED. It does not wait
   * for the jobs — a slot is free again the moment its own job settles and the limiter releases
   * the lease, so the next pass refills exactly that slot. Waiting for the whole batch made a pool
   * as slow as its slowest member and, because the pass walks every queue before it waits, left
   * every OTHER queue idle behind one long-running job too.
   */
  const claimRound = async (): Promise<readonly Promise<JobExecution>[]> => {
    await publishQueueDepth();
    const started: Promise<JobExecution>[] = [];

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
          // Over a tenant/queue/global cap: hand it straight back for another worker. No `park`
          // and no `error` — the row stays in the ready bucket the depth gauge reads, and nothing
          // about this job failed, so `x jobs show` must not report a `lastError` for it. The
          // reason is a log FIELD instead, where it costs nothing when nobody is asking.
          await shed(job, {
            queue,
            reason:
              limiter.blockedBy({
                queue,
                ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }),
              }) ?? 'unknown',
          });
          continue;
        }

        // `job.concurrency`, at last enforced. The limiter above counts slots in THIS heap, which
        // twenty pods multiply by twenty; this one is a row every replica sees. Taken after the
        // in-process lease so the cheap refusal happens first, and released in the same `finally`.
        //
        // The `try` is the whole of a bug this had: taking a fleet slot is a WRITE to
        // `x_job_leases`, so a failover, a pool timeout or a `57P01` REJECTS here — between the
        // in-process lease above and the `.finally` below that gives it back. The slot was burned
        // permanently, and four of them on a concurrency-4 worker is the whole role dead, silent
        // but for `jobs.worker.tick-failed` and a queue depth that climbs forever.
        let granted: boolean;
        try {
          granted = await fleetSlots.acquire(job);
        } catch (error) {
          lease.release();
          throw error;
        }
        if (!granted) {
          lease.release();
          await shed(job, {
            queue,
            reason: `job concurrency (${getJob(job.name)?.concurrency ?? 0})`,
          });
          continue;
        }

        // The claimed job is the process's in-flight work, counted where the DRAIN can see it:
        // core's own in-flight wait sits between `accept` and `inflight` and exists for exactly
        // this. Counted nowhere, the worker had to wait for its own jobs inside a hook.
        const finishWork = beginWork();
        const running = runClaimed(job)
          .then((execution) => {
            if (execution.outcome === 'completed') processed += 1;
            else if (execution.outcome === 'suspended') suspended += 1;
            else if (execution.outcome === 'retried') failed += 1;
            else if (execution.outcome === 'interrupted') interrupted += 1;
            else deadLettered += 1;
            // The other half of this package's metrics contract: `queue_depth` says how much work
            // is waiting, `jobs_total` says whether any of it is succeeding. Depth alone cannot
            // tell a drained queue from a queue nothing ever claimed. Labelled by QUEUE and
            // OUTCOME only — a label per job name is unbounded in an app's own vocabulary.
            const label = JOB_OUTCOME_LABELS[execution.outcome];
            if (label !== null) recordJob(queue, label);
            return execution;
          })
          .finally(async () => {
            lease.release();
            // AWAITED, never `void`: the slot is a row in `x_job_leases`, so the DELETE was still
            // on the wire when the teardown's `allSettled` returned and `driver.close()` took the
            // connection out from under it — a `concurrency: 1` job unclaimable by the pod
            // replacing this one for a whole visibility window after every deploy. `release`
            // swallows its own failures, so awaiting it cannot reject a job that finished; the
            // `finally` is for the one that could, because a lost `finishWork()` is an in-flight
            // count that never returns to zero and a drain that waits out its whole budget.
            try {
              await fleetSlots.release(job.id);
            } finally {
              finishWork();
            }
          });

        started.push(running);
        inFlight.add(running);
        // The claim loop no longer awaits these, so this is the one place a rejection is observed:
        // unobserved it is an unhandled rejection, which on Bun's default is the whole process.
        // `executeJob` settles the job itself, so reaching here means the driver could not be
        // told how it ended — the lease will lapse and the queue will deliver it again.
        void running.then(
          () => {
            inFlight.delete(running);
          },
          (error: unknown) => {
            inFlight.delete(running);
            logger.error('jobs.worker.settle-failed', {
              workerId,
              job: job.name,
              jobId: job.id,
              error: renderThrowable(error),
            });
          },
        );
      }
    }

    return started;
  };

  /**
   * One claim pass, tracked. The guard and the registration are one synchronous step — no await
   * between them — so a pass is either refused by a drain already under way or visible to every
   * drain that starts after it. A pass that reached `claim()` first is the one `stop()` must
   * wait out: it is still adding to `inFlight`.
   */
  const round = (): Promise<readonly Promise<JobExecution>[]> => {
    if (!claiming()) return Promise.resolve([]);
    const pass = claimRound().finally(() => {
      rounds.delete(pass);
    });
    rounds.add(pass);
    return pass;
  };

  /** One claim+run round: the pass, then the jobs THIS pass started — never the whole pool. */
  const tick = async (): Promise<readonly JobExecution[]> => {
    const settled = await Promise.allSettled(await round());
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  };

  /**
   * The claim loop re-arms on the PASS, not on the jobs: polling is how a free slot gets refilled,
   * and a loop that waited for the last job of the previous pass could not refill one until the
   * whole batch was done.
   */
  const schedule = (): void => {
    loop = setTimeout(() => {
      void round()
        .catch((error: unknown) => {
          logger.error('jobs.worker.tick-failed', {
            workerId,
            error: renderThrowable(error),
          });
        })
        .finally(() => {
          if (state === 'running') schedule();
        });
    }, pollIntervalMs);
  };

  /**
   * The whole of the `accept` phase: stop taking work, tell the work already held, and nothing
   * else. Synchronous on purpose — a phase whose job is to be over before the load balancer's next
   * health check must not contain a wait, and the hook behind this one is somebody else's "stop
   * listening". An abort is synchronous and costs nothing, which is why it belongs HERE and not in
   * the teardown: core runs `accept`, then waits out in-flight work (every claimed job is
   * `beginWork()`ed) under the same budget, then `close`. Told in `close`, a body that reads
   * `ctx.signal` would hear it after the in-flight wait had already spent the whole budget on it —
   * which is what happened until 2026-09-07: a job that would have stopped in a second was waited
   * on for the full deadline and abandoned there, exactly like one that ignores the signal.
   *
   * Only a SHUTDOWN aborts, and only a shutdown binds the budget. A manual `stop()` passes
   * nothing: a caller that asked has no budget to spend and wants its work finished, the same
   * line `settleAllBy` draws for the wait. The bind comes BEFORE the abort's once-guard and on
   * every call, because the second shutdown to reach a worker is the one that finds the abort
   * already fired and the teardown already waiting — with no deadline, if the first was manual.
   */
  const stopAccepting = (shutdown?: ShutdownReason): void => {
    if (state === 'stopped') return;
    state = 'draining';
    if (loop !== undefined) clearTimeout(loop);
    loop = undefined;
    if (shutdown === undefined) return;
    budget.bind(shutdown.deadlineAt);
    if (drainSignal.signal.aborted) return;
    logger.info('jobs.worker.drain-signalled', {
      workerId,
      signal: shutdown.signal,
      inFlight: inFlight.size,
    });
    drainSignal.abort(new JobDrainedError({ workerId, signal: shutdown.signal }));
  };

  const teardown = async (reason: string): Promise<void> => {
    logger.info('jobs.worker.draining', { workerId, reason, inFlight: inFlight.size });
    try {
      // Stop claiming, finish what we hold, then close. Anything else re-runs work on deploy.
      // Rounds first: one that passed the guard before the flag flipped is still awaiting its
      // `claim()`, and the jobs it starts join `inFlight` after any snapshot taken here — so a
      // drain that waited on `inFlight` alone closed the driver under a job that had just begun.
      //
      // Both waits share ONE budget: unbound on a manual stop, which waits as long as its jobs
      // take, and bound by the SIGTERM — whether it arrived before this teardown or lands in the
      // middle of it. Nothing can kill a body that ignores `ctx.signal`, so an unbounded wait
      // here is a teardown that never ends: driver never closed, state never past 'draining', and
      // the memoized `stopping` every later `stop()` joins never settling. Abandoning costs a
      // lapsed lease and a redelivered job — at-least-once, as promised.
      const rounded = await settleAllBy([...rounds], budget);
      const drained = (await settleAllBy([...inFlight], budget)) && rounded;
      if (!drained) {
        logger.warn('jobs.worker.drain-abandoned', {
          workerId,
          reason,
          inFlight: inFlight.size,
          fix: 'raise the drain budget past the slowest job — configureLifecycle({ deadlineMs: 600_000 }) — and set terminationGracePeriodSeconds to at least as many seconds',
        });
      }
      await options.driver.close?.();
    } finally {
      // Whatever the close did, this worker is done: a state left at 'draining' is a drain that
      // is not happening — `start()` refuses it for the rest of the process and `stats()` reports
      // a worker still finishing work it finished. And the hook goes back. It exists only to call
      // this, so one left registered drains a stopped worker on the next process-wide shutdown —
      // through a driver already closed — and keeps this closure, its driver and its in-flight
      // set alive with it.
      state = 'stopped';
      for (const release of releaseShutdownHooks) release();
      releaseShutdownHooks = [];
      // A run this drain abandoned still follows the old controller through its own composition;
      // the next start's jobs must not. Fresh here, in the one place a teardown always reaches —
      // and the budget with it, or the next manual stop would inherit a deadline already spent.
      drainSignal = new AbortController();
      budget = createDrainBudget();
    }
  };

  const stop = async (reason = 'stop', shutdown?: ShutdownReason): Promise<void> => {
    // Answered immediately once this worker is done: the teardown always REACHES 'stopped' (its
    // waits are bounded and the state is set in a `finally`), so a caller landing after an
    // abandoned drain gets an answer rather than joining a promise that never settles.
    if (state === 'stopped') return;
    // Before the join, every time: a SIGTERM landing on a manual stop still aborts every held
    // run's `ctx.signal` and binds the teardown already waiting to the shutdown's deadline.
    stopAccepting(shutdown);
    // One teardown, joined rather than repeated: that SIGTERM must wait out the same in-flight
    // work, not close the driver a second time underneath it. Cleared as it settles, so a worker
    // that started again tears down again instead of joining a promise that settled a lifetime
    // ago. A close that threw still stopped this worker — the failure is the caller's to see on
    // the promise it awaited, not a teardown to run twice.
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
      // Refused HERE, at the earliest decidable point, and refused rather than logged: an agent
      // reads "max in-flight runs of THIS job across the fleet", writes `concurrency: 1` on
      // `rebuildSearchIndex`, ships, and two workers run it on the first deploy — while
      // `x jobs show` and the manifest both confirm a guarantee that does not exist. A driver
      // with no `leases` can only hold the cap per process, so it does not get to claim it.
      if (driverLeases === undefined) {
        const capped = registeredJobs()
          .filter((handle) => handle.concurrency !== undefined)
          .map((handle) => handle.name);
        if (capped.length > 0) {
          throw new ConcurrencyUnenforceableError({ driver: options.driver.name, jobs: capped });
        }
      }
      state = 'running';
      logger.info('jobs.worker.started', { workerId, queues });
      // TWO hooks, for the two phases that answer two questions. `accept` stops claiming, aborts
      // every held run's `ctx.signal` and returns, so every hook behind it — the HTTP server's
      // "stop listening", the sync node's "stop upgrading" — runs while the budget is still whole;
      // one hook doing both spent all of it in the phase whose whole purpose is to be quick.
      // `close` waits out what this worker holds and closes the driver, bounded by the deadline
      // the hook is handed.
      //
      // Both unregisters are kept, never discarded: `stop()` hands them back, so
      // start -> stop -> start holds one pair rather than one per start, each retaining the
      // driver of a worker that is already gone.
      if (options.drainOnShutdown !== false) {
        releaseShutdownHooks = [
          onShutdown(`jobs.worker.${workerId}.accept`, (reason) => stopAccepting(reason), {
            phase: 'accept',
          }),
          onShutdown(`jobs.worker.${workerId}`, (reason) => stop(reason.signal, reason), {
            phase: 'close',
          }),
        ];
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
        interrupted,
        queueDepth: [...(await options.driver.stats())],
      };
    },
  };
}
