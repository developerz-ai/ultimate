// The `scheduler` role: one node walks every registered task's cron, dispatches the occurrences
// it owes and enqueues their jobs. The `task` primitive it reads lives in `task.ts`.
//
// Exactly one node dispatches per tick, enforced by leader election. Multi-node that is an
// EXPIRING LEASE ROW in `x_scheduler_leader` (`createPgLeaseLeader`), never an advisory lock: an
// advisory lock is held by the SESSION, not by this process — it outlives every transaction and is
// released only by an explicit unlock, the pool's reset on release, or the connection dying, and
// the next round may run on a different connection. So a node can neither renew it nor prove it
// still holds one, and leadership passes to a second node while the first is still dispatching.
//
// **The occurrence key is not a second line of defence, and the lease is therefore re-asserted
// before EVERY task, not once per round.** `SQL_ENQUEUE`'s conflict target is the PARTIAL index
// over the live states (`ready`, `delayed`, `running`, `suspended`), so a duplicate enqueue is
// absorbed only while the first job is still one of those: a second dispatcher landing after that
// occurrence's job completed, dead-lettered or was retried past its row inserts a NEW row, and the
// handler runs twice. A round walks its tasks serially with an enqueue per job, so a 30s lease and
// a slow queue leave the tail of the walk running under a lease another node already took. Argued
// from the index definition, not reproduced — say it that way, as `outbox.ts` does for the same
// mechanism. One ROUND at a time is the same rule inside one process: the loop re-arms on the
// round it just finished, and any other caller joins that round rather than opening a second one
// over the same `lastFiredAt`.

import type { Clock } from '@ultimat3/core';
import { finiteOption, isUltimateError, logger, onShutdown, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { DrainBudget } from './drain-wait';
import { createDrainBudget, settleAllBy } from './drain-wait';
import type { JobDriver } from './driver';
import { signalEnqueued } from './enqueue-signal';
import type { LeaderElection } from './scheduler-leader';
import { soleLeader } from './scheduler-leader';
import { defaultCronResolver, latestOccurrence, occurrencesIn } from './scheduler-occurrences';
import type { SchedulerState } from './scheduler-state';
import { createMemorySchedulerState } from './scheduler-state';
import type { TaskHandle, TaskJobResult } from './task';
import { registeredTasks } from './task';

/**
 * A round that failed, as log fields. `message` alone throws away the half of an `UltimateError`
 * that makes it actionable — the operator reading `jobs.scheduler.tick-failed` at 3am needs the
 * stable code to search on and the `fix:` to run, not a sentence.
 */
function failureFields(error: unknown): Record<string, unknown> {
  const message = renderThrowable(error);
  return isUltimateError(error)
    ? { error: message, code: error.code, cause: error.cause, fix: error.fix }
    : { error: message };
}

/** Resolves the next fire time. Injected so scheduling logic is testable without a cron impl. */
export type CronResolver = (cron: string, options: { tz: string; from: Date }) => Date;

/** How often the leader folds old counter buckets. Only buckets a day old ever move. */
export const COUNTER_ROLLUP_INTERVAL_MS = 600_000;

/** How long a task found paused is left alone before the pause is read again. */
export const PAUSE_RECHECK_MS = 5_000;

export interface SchedulerOptions {
  readonly driver: JobDriver;
  readonly clock?: Clock;
  readonly leader?: LeaderElection;
  readonly state?: SchedulerState;
  readonly cron?: CronResolver;
  /** Gap between the end of one dispatch round and the start of the next. Default 1s. */
  readonly tickIntervalMs?: number;
  /** Defaults to every registered task. */
  readonly tasks?: readonly TaskHandle[];
  /** Default true. Registers a SIGTERM drain via `onShutdown`, exactly as the worker does. */
  readonly drainOnShutdown?: boolean;
}

export interface DispatchedOccurrence {
  readonly task: string;
  readonly occurrenceMs: number;
  readonly jobs: readonly TaskJobResult[];
  readonly catchUp: boolean;
}

export interface Scheduler {
  start(): void;
  /** Stop dispatching, wait out the round in flight, then hand the leader lock back. */
  stop(reason?: string): Promise<void>;
  /**
   * One dispatch round. Returns what it enqueued — tests call this, not the timer. A call
   * landing on a round already in flight JOINS that round; there is never a second one.
   */
  tick(): Promise<readonly DispatchedOccurrence[]>;
  nextRunFor(handle: TaskHandle, from?: Date): Date;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const schedulerState = options.state ?? createMemorySchedulerState();
  const resolveCron = options.cron ?? defaultCronResolver;
  const tickIntervalMs = finiteOption(
    'createScheduler',
    'tickIntervalMs',
    options.tickIntervalMs ?? 1_000,
  );
  const leader = options.leader ?? soleLeader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isLeader = false;
  let lastRollupAt = Number.NEGATIVE_INFINITY;
  let trustedUntil = Number.NEGATIVE_INFINITY;
  let standbyUntil = Number.NEGATIVE_INFINITY;
  const renewEveryMs = Number.isFinite(leader.renewEveryMs) ? Math.max(0, leader.renewEveryMs) : 0;
  /**
   * What this node knows of each task while it leads: the watermark it last read or wrote, the
   * first occurrence after it, and — for a task found paused — when to look again. It is what
   * makes an idle round FREE: `nextDueAt > now` for every task is a map walk, where it was a
   * `lastFiredAt` read and a cron resolution per task per second. Cleared whenever leadership is
   * (re)gained or lost; a fire the store refuses as already-fired drops the task's entry.
   */
  const known = new Map<
    string,
    {
      readonly handle: TaskHandle;
      readonly last: number;
      readonly nextDueAt: number;
      pausedUntil: number;
    }
  >();
  /** The drain's state, keyed on the same four values the worker's is. */
  let state: 'idle' | 'running' | 'draining' | 'stopped' = 'idle';
  /** The dispatch round in flight — what a second caller joins and what `stop()` waits out. */
  let round: Promise<readonly DispatchedOccurrence[]> | undefined;
  /**
   * The two `onShutdown` registrations this scheduler holds while it runs, both handed back by
   * `stop()`. Two, for the phases they answer — the worker's rule, and `listenSyncNode`'s.
   */
  let releaseShutdownHooks: (() => void)[] = [];
  /** The teardown in flight, so a SIGTERM landing on a manual stop joins it. */
  let stopping: Promise<void> | undefined;

  const nextRunFor = (handle: TaskHandle, from?: Date): Date =>
    resolveCron(handle.cron, { tz: handle.tz, from: from ?? new Date(nowMs(options.clock)) });

  const occurrencesSince = (handle: TaskHandle, after: number, until: number): readonly number[] =>
    occurrencesIn(nextRunFor, handle, after, until);
  const latestOccurrenceBy = (handle: TaskHandle, after: number, until: number): number =>
    latestOccurrence(nextRunFor, handle, after, until);

  const dispatch = async (
    handle: TaskHandle,
    occurrenceMs: number,
    catchUp: boolean,
  ): Promise<DispatchedOccurrence | undefined> => {
    // The occurrence, not `at`: a catch-up dispatch runs long after the instant it fires for,
    // and the payload has to describe the occurrence the email/report claims to be about.
    const requests = handle.entries(occurrenceMs).map(([handleForJob, input]) => {
      // The facade's refusal, at the one enqueue that does not go through it: an empty key.
      handleForJob.concurrencyKeyFor(input);
      return {
        name: handleForJob.name,
        queue: handleForJob.queue,
        input,
        // Occurrence-scoped key: belt to the watermark's braces across a deploy that still has
        // the old two-step fire in flight.
        idempotencyKey: `${handle.name}:${occurrenceMs}:${handleForJob.idempotencyKeyFor(input)}`,
        maxAttempts: handleForJob.retry.attempts,
        runAt: occurrenceMs,
      };
    });
    // Jobs and watermark in ONE step (`SchedulerState.fire`). `undefined` is an occurrence some
    // other dispatcher already fired: nothing was queued, and nothing is reported as dispatched.
    const results = await schedulerState.fire(options.driver, {
      task: handle.name,
      occurrenceMs,
      jobs: requests,
    });
    if (results === undefined) {
      logger.info('jobs.scheduler.already-fired', {
        task: handle.name,
        occurrence: new Date(occurrenceMs).toISOString(),
      });
      return undefined;
    }
    // A worker in this process that has backed off starts its next pass now.
    signalEnqueued();
    const jobs: TaskJobResult[] = requests.map((request, index) => ({
      job: request.name,
      result: results[index] ?? { id: '', runId: '', deduped: true },
    }));
    logger.info('jobs.scheduler.dispatched', {
      task: handle.name,
      occurrence: new Date(occurrenceMs).toISOString(),
      tz: handle.tz,
      catchUp,
      jobs: jobs.length,
    });
    return { task: handle.name, occurrenceMs, jobs, catchUp };
  };

  /** The drain's one question: may this scheduler still dispatch an occurrence? */
  const dispatching = (): boolean => state !== 'draining' && state !== 'stopped';

  /**
   * Asked every round AND before every task in it — and answered from memory inside the window
   * the election stated (`renewEveryMs`). A lease-backed election expires on a wall clock, so
   * `acquire()` is also its renewal; it was called 2T+1 times a round, each an UPSERT, which is 35
   * writes a second from a scheduler with nothing to fire. An election that states `0` is asked
   * every time, as before.
   */
  const stillLeading = async (): Promise<boolean> => {
    const at = nowMs(options.clock);
    // Inside the window the grant was stated for, the answer is known and costs nothing.
    if (isLeader && at < trustedUntil) return true;
    // A standby asks on the same cadence a leader renews on, not every round: the lease it is
    // waiting for cannot lapse sooner, and each ask is a write that is refused.
    if (!isLeader && at < standbyUntil) return false;
    if (await leader.acquire()) {
      // Newly elected: whatever this node remembers of the watermarks is from before another node
      // led, so it is read again rather than trusted.
      if (!isLeader) known.clear();
      isLeader = true;
      // Measured from BEFORE the call: the store stamped the grant no earlier than that.
      trustedUntil = at + renewEveryMs;
      return true;
    }
    // Demoted, or never elected. Nothing to release — a lease we no longer hold is not ours to
    // hand back, and `teardown` reads this same flag before it calls `release()`.
    if (isLeader) logger.warn('jobs.scheduler.leadership-lost', { at: nowMs(options.clock) });
    isLeader = false;
    standbyUntil = at + renewEveryMs;
    known.clear();
    return false;
  };

  const runRound = async (): Promise<readonly DispatchedOccurrence[]> => {
    // Never take the lock a drain is on its way to releasing: a round that acquired it here
    // would still be enqueueing after `stop()` handed the occurrence to the next node.
    if (!dispatching()) return [];
    if (!(await stillLeading())) return [];

    const at = nowMs(options.clock);
    const tasks = options.tasks ?? registeredTasks();
    const dispatched: DispatchedOccurrence[] = [];
    /** Records a dispatch; `false` is an occurrence the store says was already fired. */
    const fired = (occurrence: DispatchedOccurrence | undefined): boolean => {
      if (occurrence !== undefined) dispatched.push(occurrence);
      return occurrence !== undefined;
    };
    const remember = (handle: TaskHandle, last: number): void => {
      known.set(handle.name, {
        handle,
        last,
        nextDueAt: nextRunFor(handle, new Date(last)).getTime(),
        pausedUntil: Number.NEGATIVE_INFINITY,
      });
    };
    const operator = options.driver.introspect;
    // The counters' fold is the leader's: old one-minute buckets into five-minute ones, and so on
    // (`COUNTER_TIERS`). Only buckets a day old move, so once every ten minutes is often enough.
    if (operator !== undefined && at - lastRollupAt >= COUNTER_ROLLUP_INTERVAL_MS) {
      lastRollupAt = at;
      await operator.rollupCounters().catch((error: unknown) => {
        logger.warn('jobs.scheduler.rollup-failed', failureFields(error));
      });
    }
    /** The paused set, read at most once a round and only when a task is actually DUE. */
    let paused: ReadonlySet<string> | undefined;
    const isPaused = async (name: string): Promise<boolean> => {
      paused ??= new Set((await operator?.pausedTasks())?.map((entry) => entry.name));
      return paused.has(name);
    };

    for (const handle of tasks) {
      // Re-read per task, not once on entry: a `stop()` between two tasks means stop now, not
      // at the next round. A task not reached simply fires next time — its `lastFiredAt` is
      // untouched — while the occurrence this round already began is the one `stop()` waits for.
      if (!dispatching()) break;
      // Nothing due and nothing to learn: the idle path, and it touches no store.
      const seen = known.get(handle.name);
      if (seen !== undefined && seen.handle === handle) {
        if (seen.nextDueAt > at || seen.pausedUntil > at) continue;
      }
      // The lease, on the same rule and for the same reason the drain state is re-read: it expires
      // on a wall clock in the middle of this walk, not between rounds.
      if (!(await stillLeading())) break;
      // One task's failure is that task's: its `enqueue` callback, its state read or its dispatch
      // threw, and the round used to abort there — every task after it stopped firing, in every
      // round, until a deploy. Logged and skipped; its watermark is untouched, so it retries next
      // round.
      try {
        const remembered = known.get(handle.name);
        const last =
          remembered !== undefined && remembered.handle === handle
            ? remembered.last
            : await schedulerState.lastFiredAt(handle.name);
        if (last === undefined) {
          // First sight of this task: arm it, never fire retroactively for all of history.
          const armed = nextRunFor(handle, new Date(at)).getTime() - 1;
          await schedulerState.markFired(handle.name, armed);
          remember(handle, armed);
          continue;
        }
        remember(handle, last);

        const due = occurrencesSince(handle, last, at);
        if (due.length === 0) continue;
        // A paused task is skipped with its watermark untouched, so on resume its own `catchUp`
        // decides what the pause missed — exactly as if this scheduler had been down. Asked HERE,
        // when it is due, so a pause holds for the very next occurrence; a task found paused is
        // looked at again after `PAUSE_RECHECK_MS`, not every round.
        if (await isPaused(handle.name)) {
          const entry = known.get(handle.name);
          if (entry !== undefined) entry.pausedUntil = at + PAUSE_RECHECK_MS;
          continue;
        }
        // Whatever happens below moves the watermark, or should have: read it again next time.
        known.delete(handle.name);

        if (handle.catchUp === 'skip') {
          // The real latest occurrence, never `due`'s last element: that one is `maxCatchUp` steps
          // past the watermark, and dispatching it leaves the watermark there — so the next tick
          // found the next ten still due and fired again, until the walk reached `at`. The
          // occurrence key stays honest (this IS the occurrence the payload is for), and the
          // watermark `dispatch` leaves is that occurrence — nothing at or before `at` is due past it.
          const latest = latestOccurrenceBy(handle, last, at);
          if (fired(await dispatch(handle, latest, due.length > 1))) remember(handle, latest);
          continue;
        }
        if (handle.catchUp === 'run-once') {
          const first = due[0];
          if (first !== undefined) {
            const ran = fired(await dispatch(handle, first, due.length > 1));
            // `dispatch` leaves the watermark on the occurrence it RAN — the earliest missed one
            // here — so the next round found occurrences 2..n still due and fired the second, then
            // the third, one per tick until the backlog drained: 24 nightly digests a second apart
            // after a day down. "One catch-up" means the rest are DROPPED, and dropping an
            // occurrence is moving the watermark past it. `at` rather than the last element of
            // `due`, which `maxCatchUp` truncates: every occurrence at or before `at` is missed by
            // definition, and this policy fires none of them.
            if (first !== at) await schedulerState.markFired(handle.name, at);
            if (ran) remember(handle, Math.max(first, at));
          }
          continue;
        }
        let reached: number | undefined;
        for (const occurrence of due) {
          if (!fired(await dispatch(handle, occurrence, occurrence !== due[due.length - 1]))) {
            reached = undefined;
            break;
          }
          reached = occurrence;
        }
        if (reached !== undefined) remember(handle, reached);
      } catch (error) {
        logger.error('jobs.task.round_failed', { task: handle.name, ...failureFields(error) });
      }
    }

    return dispatched;
  };

  /**
   * One round, and never two at once. A round slower than `tickIntervalMs` used to leave the
   * timer starting a second one over the same `lastFiredAt`: both read the same watermark, both
   * walked the same occurrences and both dispatched them. The occurrence key deduped the JOBS,
   * so nothing downstream showed it — but the loser re-marked `lastFiredAt`, reported
   * occurrences it never enqueued, and under `run-all` interleaved a catch-up sequence with
   * itself. Joining also gives `stop()` the one promise it has to wait out.
   */
  const tick = (): Promise<readonly DispatchedOccurrence[]> => {
    round ??= runRound().finally(() => {
      round = undefined;
    });
    return round;
  };

  /**
   * Re-arms on the round it just finished, never on a fixed period — the interval is the GAP
   * between rounds, which is what makes overlap impossible at the source rather than caught by
   * a guard. Cron accuracy does not pay for it: an occurrence is computed from the clock, so a
   * few ms of drift between rounds moves nothing.
   */
  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick()
        .catch((error: unknown) => {
          logger.error('jobs.scheduler.tick-failed', failureFields(error));
        })
        .finally(() => {
          if (state === 'running') schedule();
        });
    }, tickIntervalMs);
  };

  /**
   * The whole of the `accept` phase: stop dispatching, and nothing else. Synchronous on purpose —
   * the hook behind this one is somebody else's "stop taking work", and a phase that waits is a
   * phase that spends the budget those hooks were going to need.
   */
  const stopDispatching = (): void => {
    if (state === 'stopped') return;
    state = 'draining';
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const teardown = async (reason: string, budget: DrainBudget): Promise<void> => {
    stopDispatching();
    logger.info('jobs.scheduler.draining', { reason, dispatching: round !== undefined });
    try {
      // The round this stop races runs to the end first. Releasing the lease under a
      // live dispatch hands the next node a task this one is still enqueueing for, and both
      // then own the same occurrence — the exact double-fire leader election exists to prevent.
      // Settled, not awaited: a round that failed is its own caller's to see, and the lease still
      // has to go back.
      //
      // Bounded on the SIGTERM path, `undefined` on a manual stop: a round parked in `enqueue` on
      // a queue that is not answering cannot be cancelled from here, and an unbounded wait is a
      // teardown that never ends — hooks never handed back, `state` never past 'draining', and the
      // memoised `stopping` every later `stop()` joins never settling.
      const dispatched = await settleAllBy(round === undefined ? [] : [round], budget);
      // A round we ABANDONED is a round still enqueueing, so the lock is deliberately NOT handed
      // back: promoting a standby onto an occurrence this process is mid-dispatch for is the
      // double-fire above, delivered by the shutdown. A lease row expires on its own, which is
      // what an expiry is for — and `isLeader` is cleared below either way.
      if (!dispatched) {
        logger.warn('jobs.scheduler.drain-abandoned', {
          reason,
          fix: 'raise the drain budget past a dispatch round — configureLifecycle({ deadlineMs: 60_000 }) — and set terminationGracePeriodSeconds to at least as many seconds',
        });
      } else if (isLeader) {
        await leader.release();
      }
    } finally {
      // Whatever the release did, this scheduler is done. `isLeader` false because a lock this
      // process no longer holds — or failed to hand back — must never be re-used as if it did,
      // and the hook goes back: one left registered dispatches through a stopped scheduler on
      // the next process-wide drain, and keeps this closure and its driver alive with it.
      isLeader = false;
      state = 'stopped';
      for (const release of releaseShutdownHooks) release();
      releaseShutdownHooks = [];
    }
  };

  /** The wait a teardown may spend, tightened by every shutdown that reaches it. */
  let budget = createDrainBudget();

  const stop = async (reason = 'stop', deadlineAt?: number): Promise<void> => {
    // Answered immediately once this scheduler is done: the teardown always REACHES 'stopped', so
    // a caller landing after an abandoned drain gets an answer rather than joining a promise that
    // never settles.
    if (state === 'stopped') return;
    // Bound on EVERY call, before the join — `createDrainBudget`, the worker's rule. A manual
    // stop waits with no deadline; a SIGTERM that lands on it joined that teardown without its
    // own, so a round parked on a queue that is not answering held the close hook past the whole
    // process budget. Reproduced in `scheduler-drain-budget.test.ts`.
    if (deadlineAt !== undefined) budget.bind(deadlineAt);
    // One teardown, joined rather than repeated — the worker's rule, for the same reason: a
    // SIGTERM landing on a manual stop must wait out the same round, not release the lock a
    // second time behind it. Cleared as it settles, so a scheduler started again stops again.
    stopping ??= teardown(reason, budget).finally(() => {
      stopping = undefined;
      budget = createDrainBudget();
    });
    await stopping;
  };

  return {
    start() {
      // Only from a standstill. A start mid-drain would re-arm the loop on a lock the drain is
      // about to release, and stack a second shutdown hook on the one still running.
      if (state !== 'idle' && state !== 'stopped') return;
      state = 'running';
      // TWO hooks, for the two phases. `accept` stops dispatching and returns — an occurrence
      // enqueued during the drain is work nothing in this process is left to run, and every hook
      // behind this one still has the whole budget. `close` waits the round out and hands the
      // lease back, bounded by the deadline it is given. Both unregisters are kept, never
      // discarded: `stop()` hands them back, so start -> stop -> start holds one pair rather
      // than one per start.
      if (options.drainOnShutdown !== false) {
        releaseShutdownHooks = [
          onShutdown('jobs.scheduler.accept', stopDispatching, { phase: 'accept' }),
          onShutdown('jobs.scheduler', (reason) => stop('SIGTERM', reason.deadlineAt), {
            phase: 'close',
          }),
        ];
      }
      schedule();
      logger.info('jobs.scheduler.started', { tasks: (options.tasks ?? registeredTasks()).length });
    },
    stop,
    tick,
    nextRunFor,
  };
}
