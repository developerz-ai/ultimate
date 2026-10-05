// The `worker` role: per-queue pools, a claim loop, lease heartbeats, and a graceful drain on
// SIGTERM (stop claiming -> finish in-flight -> cut off near the deadline -> hand back -> close).
// A worker that exits mid-job on EVERY deploy turns "at least once" into "always twice", so
// draining is on by default, and a drain never cancels work it still has budget to finish.

import type { ShutdownReason } from '@ultimat3/core';
import {
  beginWork,
  isDraining,
  logger,
  onShutdown,
  recordJob,
  renderThrowable,
  uuid,
} from '@ultimat3/core';
import { announceExhausted } from './claim-exhausted';
import { nowMs } from './clock';
import { createDrainBudget, settleAllBy } from './drain-wait';
import type { ClaimedJob, JobRecord } from './driver';
import { DEFAULT_QUEUE } from './driver';
import type { JobExecution } from './execute';
import { registeredJobs } from './job';
import { createLimiter } from './limits';
import { JOB_OUTCOME_LABELS } from './metrics';
import { claimAsks, createAdmission } from './worker-admit';
import { armWorkerCutoff, type DrainCutoff } from './worker-drain-cutoff';
import { assertConcurrencyEnforceable, createFleetSlots } from './worker-fleet-slots';
import { createHeldRuns } from './worker-held';
import type { ClaimLoop } from './worker-loop';
import { createClaimLoop } from './worker-loop';
import { resolveWorkerTimings } from './worker-options';
import { createQueueDepthPublisher } from './worker-queue-depth';
import type { WorkerRegistration } from './worker-registry';
import { reportUnregisteredQueues, startWorkerRegistry } from './worker-registry';
import { runClaimedJob } from './worker-run';
import { createWorkerTally } from './worker-tally';
import type { Worker, WorkerOptions, WorkerStats } from './worker-types';

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
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const admit = createAdmission({
    driver: options.driver,
    limiter,
    fleetSlots,
    workerId,
    pollIntervalMs,
    context: options.context,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  /** The runs this worker holds, each with its claim — what a drain's cut-off hands back. */
  const inFlight = createHeldRuns({ driver: options.driver, workerId });
  /**
   * Claim rounds in flight. Jobs land in `inFlight` mid-round, so a drain that waited only on
   * `inFlight` waited on a set the round it was racing had not finished filling.
   */
  const rounds = new Set<Promise<unknown>>();
  /**
   * The drain, as every run hears it: composed into each `ctx.signal` (`worker-run.ts`), aborted
   * with a `JobDrainedError` at the CUT-OFF (`worker-drain-cutoff.ts`), never at SIGTERM itself.
   * ONE controller, because "this process is going away" is one fact. Fresh after each teardown:
   * aborted once it stays aborted, and a restarted worker's jobs would be born cancelled.
   */
  let drainSignal = new AbortController();
  let cutoff: DrainCutoff | undefined; // armed by the first shutdown to reach this worker
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
  /**
   * The two `onShutdown` registrations this worker holds while it runs, both handed back by
   * `stop()`. Two, because they answer different questions in different PHASES — the split
   * `listenSyncNode` and `@ultimat3/http` already have.
   */
  let releaseShutdownHooks: (() => void)[] = [];
  /** The teardown in flight, so a second `stop()` joins it instead of running a second one. */
  let stopping: Promise<void> | undefined;
  const tally = createWorkerTally();
  let registration: WorkerRegistration | undefined;
  /** `queue_depth` and its two siblings, republished on their own interval (`worker-queue-depth.ts`). */
  const publishQueueDepth = createQueueDepthPublisher({
    driver: options.driver,
    clock: options.clock,
    workerId,
  });

  /** One claimed job, run under its lease, its slot and its span. `worker-run.ts` owns the wiring. */
  const runClaimed = (claimed: ClaimedJob, refusal?: unknown): Promise<JobExecution> =>
    runClaimedJob({
      driver: options.driver,
      claimed,
      ...(refusal === undefined ? {} : { refusal }),
      context: options.context,
      fleetSlots,
      workerId,
      visibilityTimeoutMs,
      heartbeatIntervalMs,
      pollIntervalMs,
      drain: drainSignal.signal,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });

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
    let found = false;

    const asks = claimAsks(
      queues,
      (queue) => slotsFor(queue) - limiter.inFlight({ queue }),
      loop.idle(),
    );

    for (const ask of asks) {
      // Re-read per claim, not once at the top: a `stop()` between two queues means "stop
      // claiming" now, not at the next tick. What this round already holds still runs to the end
      // — that is the drain, and `stop()` waits for it.
      if (!claiming()) break;
      // A lease that lapsed on a row's final attempt is settled by the claim itself and handed to
      // `onExhausted`, never out as work: this round is the only thing that can count it, log it
      // and tell the job. `dropExhausted` is the policy the row does not carry.
      const buried: JobRecord[] = [];
      const claimed = await options.driver.claim({
        ...ask,
        visibilityTimeoutMs,
        workerId,
        dropExhausted: registeredJobs()
          .filter((handle) => handle.retry.deadLetter === false)
          .map((handle) => handle.name),
        onExhausted: (dead) => {
          buried.push(...dead);
        },
      });
      if (claimed.length > 0) found = true;
      if (buried.length > 0) {
        found = true;
        const ended = await announceExhausted({
          exhausted: buried,
          workerId,
          context: options.context,
        });
        tally.buried(ended);
        for (const row of buried) {
          const label = JOB_OUTCOME_LABELS[row.state === 'failed' ? 'dropped' : 'dead-lettered'];
          if (label !== null) recordJob(row.queue, label);
        }
      }

      for (const [index, job] of claimed.entries()) {
        const queue = job.queue;
        // Both caps, and what becomes of a job that passes neither — `worker-admit.ts`.
        const admission = await admit(job, queue, claimed.slice(index + 1));
        if (admission.kind === 'waiting') continue;
        if (admission.kind === 'refused') {
          // Settled without a body: counted and returned with the pass, the one job this loop
          // itself finishes.
          tally.refused();
          const label = JOB_OUTCOME_LABELS[admission.execution.outcome];
          if (label !== null) recordJob(queue, label);
          started.push(Promise.resolve(admission.execution));
          continue;
        }
        const { lease } = admission;

        // The claimed job is the process's in-flight work, counted where the DRAIN can see it:
        // core's own in-flight wait sits between `accept` and `inflight` and exists for exactly
        // this. Counted nowhere, the worker had to wait for its own jobs inside a hook.
        const finishWork = beginWork();
        // Once per run, whichever comes first: the run's own `finally`, or the drain handing its
        // row back while the body is still running (`worker-held.ts`).
        let slotReleased = false;
        const releaseSlot = async (): Promise<void> => {
          if (slotReleased) return;
          slotReleased = true;
          await fleetSlots.release(job.id);
        };
        const running = runClaimed(job, admission.refusal)
          .then((execution) => {
            tally.count(execution);
            // The other half of this package's metrics contract: `queue_depth` says how much work
            // is waiting, `jobs_total` says whether any of it is succeeding. Depth alone cannot
            // tell a drained queue from a queue nothing ever claimed. Labelled by QUEUE and
            // OUTCOME only — a label per job name is unbounded in an app's own vocabulary.
            const label = JOB_OUTCOME_LABELS[execution.outcome];
            if (label !== null) recordJob(queue, label);
            // Handed back with a time on it — a retry's backoff, a sleep's wake: this worker
            // knows when the row is due, so it need not wait for a backed-off poll to find out.
            if (execution.resumeAt !== undefined) {
              loop.dueIn(execution.resumeAt - nowMs(options.clock));
            }
            return execution;
          })
          .finally(async () => {
            lease.release();
            // The slot is free NOW. A full worker asks the queue for nothing, so its loop backs
            // off like an idle one — and waiting that out with a backlog behind the job that
            // just finished is throughput lost to a timer.
            loop.kick();
            // AWAITED, never `void`: the slot is a row in `x_job_leases`, so the DELETE was still
            // on the wire when the teardown's `allSettled` returned and `driver.close()` took the
            // connection out from under it — a `concurrency: 1` job unclaimable by the pod
            // replacing this one for a whole visibility window after every deploy. `release`
            // swallows its own failures, so awaiting it cannot reject a job that finished; the
            // `finally` is for the one that could, because a lost `finishWork()` is an in-flight
            // count that never returns to zero and a drain that waits out its whole budget.
            try {
              await releaseSlot();
            } finally {
              finishWork();
            }
          });

        started.push(running);
        inFlight.add(running, job, async () => {
          await releaseSlot();
          finishWork();
        });
        // The claim loop no longer awaits these, so this is the one place a rejection is observed:
        // unobserved it is an unhandled rejection, which on Bun's default is the whole process.
        // `executeJob` settles the job itself, so reaching here means the driver could not be
        // told how it ended — the lease will lapse and the queue will deliver it again.
        void running.then(
          () => {
            inFlight.settle(running);
          },
          (error: unknown) => {
            inFlight.settle(running);
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

    // The loop's next wait: the floor while passes find work, doubling to the ceiling while they
    // do not (`idle-backoff.ts`). Reported by the pass itself, so `tick()` and the timer agree.
    loop.passed(found);
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
   * whole batch was done. `worker-loop.ts` owns the timer and everything that cuts its wait short.
   */
  const loop: ClaimLoop = createClaimLoop({
    subject: 'createWorker',
    floorMs: pollIntervalMs,
    ...(options.idlePollMaxMs === undefined ? {} : { ceilingMs: options.idlePollMaxMs }),
    queues,
    round,
    onError: (error) => {
      logger.error('jobs.worker.tick-failed', { workerId, error: renderThrowable(error) });
    },
  });

  /**
   * The whole of the `accept` phase: stop taking work and ARM the cut-off — nothing else, and no
   * wait: the hook behind this one is somebody else's "stop listening". Armed here and not in
   * `close`, which runs only after core's in-flight wait has spent the budget.
   *
   * The jobs held are NOT told. Until 2026-10-05 this aborted every run at SIGTERM, and a step
   * whose side effect completed during the drain was refused and run again by the next worker.
   * The cut-off (`worker-drain-cutoff.ts`) tells them at `deadlineAt − margin`, then hands back
   * what is still held so the replacement claims it at once, not after the visibility timeout.
   *
   * Only a SHUTDOWN binds the budget and arms it: a manual `stop()` has no budget and wants its
   * work finished. The bind runs on every call — a SIGTERM landing on a manual stop is what binds
   * the teardown already waiting — and a tighter deadline re-arms through the budget's watch.
   */
  const stopAccepting = (shutdown?: ShutdownReason): void => {
    if (state === 'stopped') return;
    state = 'draining';
    loop.stop();
    if (shutdown === undefined) return;
    budget.bind(shutdown.deadlineAt);
    if (cutoff !== undefined) return;
    logger.info('jobs.worker.drain-signalled', {
      workerId,
      signal: shutdown.signal,
      inFlight: inFlight.size,
    });
    cutoff = armWorkerCutoff({
      budget,
      workerId,
      signal: shutdown.signal,
      drain: drainSignal,
      held: inFlight,
    });
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
      // the memoized `stopping` every later `stop()` joins never settling. `empty()`, not a
      // snapshot: the cut-off's hand-back empties the set under bodies still running, and that
      // ends this wait. What a late round started is handed back below, before the close.
      const rounded = await settleAllBy([...rounds], budget);
      const drained = (await settleAllBy([inFlight.empty()], budget)) && rounded;
      if (!drained) {
        logger.warn('jobs.worker.drain-abandoned', {
          workerId,
          reason,
          inFlight: inFlight.size,
          fix: 'raise the drain budget past the slowest job — configureLifecycle({ deadlineMs: 600_000 }) — and set terminationGracePeriodSeconds to at least as many seconds',
        });
      }
      if (inFlight.size > 0 && budget.deadlineAt !== undefined) await inFlight.handBackAll();
      // Before the close, and awaited: the row is deleted through the driver being closed. Under
      // the SAME budget as the jobs: `forgetWorker` is a statement on the pool that may be the
      // thing failing, and unbounded it held a SIGTERM teardown open with the driver never closed.
      // Abandoned, the row expires on its own TTL — what a killed worker's does.
      const registered = registration;
      registration = undefined;
      if (registered !== undefined && !(await settleAllBy([registered.stop()], budget))) {
        logger.warn('jobs.worker.registry-abandoned', { workerId, reason });
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
      cutoff?.dispose();
      cutoff = undefined;
      drainSignal = new AbortController();
      budget = createDrainBudget();
    }
  };

  const stop = async (reason = 'stop', shutdown?: ShutdownReason): Promise<void> => {
    // Answered immediately once this worker is done: the teardown always REACHES 'stopped' (its
    // waits are bounded and the state is set in a `finally`), so a caller landing after an
    // abandoned drain gets an answer rather than joining a promise that never settles.
    if (state === 'stopped') return;
    // Before the join, every time: a SIGTERM landing on a manual stop still arms the cut-off and
    // binds the teardown already waiting to the shutdown's deadline.
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
      // Nor inside the PROCESS's drain: a boot that reached here after SIGTERM registers hooks the
      // drain is already past, so a worker that claimed now held jobs nothing would ever drain.
      if (isDraining()) {
        logger.warn('jobs.worker.start-refused-draining', { workerId });
        return;
      }
      // Refused HERE, at the earliest decidable point, and refused rather than logged: an agent
      // reads "max in-flight runs of THIS job across the fleet", writes `concurrency: 1` on
      // `rebuildSearchIndex`, ships, and two workers run it on the first deploy — while
      // `x jobs show` and the manifest both confirm a guarantee that does not exist.
      assertConcurrencyEnforceable(options.driver);
      state = 'running';
      logger.info('jobs.worker.started', { workerId, queues });
      reportUnregisteredQueues(workerId, queues);
      registration = startWorkerRegistry({
        driver: options.driver,
        workerId,
        host: options.host,
        queues,
        concurrency: queues.reduce((slots, queue) => slots + slotsFor(queue), 0),
        inFlight: () => inFlight.ids(),
        // The visibility timeout, renewed on the heartbeat interval: a killed worker leaves the
        // registry on exactly the schedule the queue takes its jobs back.
        ttlMs: visibilityTimeoutMs,
        intervalMs: heartbeatIntervalMs,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      });
      // TWO hooks, for the two phases that answer two questions. `accept` stops claiming, arms
      // the cut-off that tells the held runs near the deadline, and returns, so every hook behind it — the HTTP server's
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
      loop.start();
    },
    tick,
    stop,
    async stats(): Promise<WorkerStats> {
      return {
        workerId,
        queues,
        state,
        inFlight: inFlight.size,
        ...tally.snapshot(),
        pollDelayMs: loop.delayMs(),
        queueDepth: [...(await options.driver.stats())],
      };
    },
  };
}
