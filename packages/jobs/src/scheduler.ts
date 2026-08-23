// The `scheduler` role: one node walks every registered task's cron, dispatches the occurrences
// it owes and enqueues their jobs. The `task` primitive it reads lives in `task.ts`.
//
// Exactly one node dispatches per tick, enforced by leader election. Multi-node that is an
// EXPIRING LEASE ROW in `x_scheduler_leader` (`createPgLeaseLeader`), never an advisory lock: an
// advisory lock is held by the SESSION, not by this process — it outlives every transaction and is
// released only by an explicit unlock, the pool's reset on release, or the connection dying, and
// the next round may run on a different connection. So a node can neither renew it nor prove it
// still holds one, and leadership passes to a second node while the first is still dispatching. Two schedulers
// double-enqueue every task; the idempotency key would absorb it, but leader election means
// the queue never sees the duplicate at all. One ROUND at a time is the same rule inside one
// process: the loop re-arms on the round it just finished, and any other caller joins that
// round rather than opening a second one over the same `lastFiredAt`.

import type { Clock } from '@ultimat3/core';
import { isUltimateError, logger, onShutdown } from '@ultimat3/core';
import { instant, nextCronOccurrence } from '@ultimat3/time';
import { nowMs } from './clock';
import type { JobDriver } from './driver';
import type { TaskHandle, TaskJobResult } from './task';
import { registeredTasks } from './task';

/**
 * A round that failed, as log fields. `message` alone throws away the half of an `UltimateError`
 * that makes it actionable — the operator reading `jobs.scheduler.tick-failed` at 3am needs the
 * stable code to search on and the `fix:` to run, not a sentence.
 */
function failureFields(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return isUltimateError(error)
    ? { error: message, code: error.code, cause: error.cause, fix: error.fix }
    : { error: message };
}

/** Resolves the next fire time. Injected so scheduling logic is testable without a cron impl. */
export type CronResolver = (cron: string, options: { tz: string; from: Date }) => Date;

const defaultCronResolver: CronResolver = (cron, options) =>
  // Instant is a branded Date, so it satisfies CronResolver's Date return directly.
  nextCronOccurrence(cron, options.tz, instant(options.from));

export interface LeaderElection {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** Single-node default: always the leader. Multi-node uses `createPgLeaseLeader()` — never
 * `createPgLeader()`, whose advisory lock is owned by a pooled session this process cannot name. */
export function soleLeader(): LeaderElection {
  return {
    acquire: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
}

export interface SchedulerState {
  /** Epoch ms of the last occurrence this task was dispatched for. */
  lastFiredAt(taskName: string): Promise<number | undefined>;
  markFired(taskName: string, occurrenceMs: number): Promise<void>;
}

export function createMemorySchedulerState(): SchedulerState {
  const fired = new Map<string, number>();
  return {
    lastFiredAt: (taskName) => Promise.resolve(fired.get(taskName)),
    markFired(taskName, occurrenceMs) {
      fired.set(taskName, occurrenceMs);
      return Promise.resolve();
    },
  };
}

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
  const tickIntervalMs = options.tickIntervalMs ?? 1_000;
  const leader = options.leader ?? soleLeader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isLeader = false;
  /** The drain's state, keyed on the same four values the worker's is. */
  let state: 'idle' | 'running' | 'draining' | 'stopped' = 'idle';
  /** The dispatch round in flight — what a second caller joins and what `stop()` waits out. */
  let round: Promise<readonly DispatchedOccurrence[]> | undefined;
  /** The `onShutdown` registration this scheduler holds while it runs. Handed back by `stop()`. */
  let releaseShutdownHook: (() => void) | undefined;
  /** The teardown in flight, so a SIGTERM landing on a manual stop joins it. */
  let stopping: Promise<void> | undefined;

  const nextRunFor = (handle: TaskHandle, from?: Date): Date =>
    resolveCron(handle.cron, { tz: handle.tz, from: from ?? new Date(nowMs(options.clock)) });

  /**
   * Occurrences in `(after, until]`. Walking forward from the last fire is what makes
   * catch-up possible at all — a scheduler that only knows "now" cannot know what it missed.
   */
  const occurrencesSince = (
    handle: TaskHandle,
    after: number,
    until: number,
  ): readonly number[] => {
    const out: number[] = [];
    let cursor = after;
    for (let i = 0; i < handle.maxCatchUp; i += 1) {
      const next = nextRunFor(handle, new Date(cursor)).getTime();
      if (!Number.isFinite(next) || next <= cursor || next > until) break;
      out.push(next);
      cursor = next;
    }
    return out;
  };

  const dispatch = async (
    handle: TaskHandle,
    occurrenceMs: number,
    catchUp: boolean,
  ): Promise<DispatchedOccurrence> => {
    const jobs: TaskJobResult[] = [];
    // The occurrence, not `at`: a catch-up dispatch runs long after the instant it fires for,
    // and the payload has to describe the occurrence the email/report claims to be about.
    for (const [handleForJob, input] of handle.entries(occurrenceMs)) {
      const result = await options.driver.enqueue({
        name: handleForJob.name,
        queue: handleForJob.queue,
        input,
        // Occurrence-scoped key: two schedulers, or a retried tick, cannot double-fire.
        idempotencyKey: `${handle.name}:${occurrenceMs}:${handleForJob.idempotencyKeyFor(input)}`,
        maxAttempts: handleForJob.retry.attempts,
        runAt: occurrenceMs,
      });
      jobs.push({ job: handleForJob.name, result });
    }
    await schedulerState.markFired(handle.name, occurrenceMs);
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

  const runRound = async (): Promise<readonly DispatchedOccurrence[]> => {
    // Never take the lock a drain is on its way to releasing: a round that acquired it here
    // would still be enqueueing after `stop()` handed the occurrence to the next node.
    if (!dispatching()) return [];
    // Asked EVERY round, not only while `isLeader` is false. A lease-backed election (the one a
    // pooled executor can use — `createPgLeaseLeader`) expires, so `acquire()` is also its
    // renewal, and a node that cached `isLeader = true` would keep dispatching past a lease
    // another node has already taken. `soleLeader` answers true every time, and `createPgLeader`
    // holds its grant internally, so this is a no-op for both.
    const held = await leader.acquire();
    if (!held) {
      // Demoted, or never elected. Nothing to release — a lease we no longer hold is not ours to
      // hand back, and `teardown` reads this same flag before it calls `release()`.
      if (isLeader) logger.warn('jobs.scheduler.leadership-lost', { at: nowMs(options.clock) });
      isLeader = false;
      return [];
    }
    isLeader = true;

    const at = nowMs(options.clock);
    const tasks = options.tasks ?? registeredTasks();
    const dispatched: DispatchedOccurrence[] = [];

    for (const handle of tasks) {
      // Re-read per task, not once on entry: a `stop()` between two tasks means stop now, not
      // at the next round. A task not reached simply fires next time — its `lastFiredAt` is
      // untouched — while the occurrence this round already began is the one `stop()` waits for.
      if (!dispatching()) break;
      const last = await schedulerState.lastFiredAt(handle.name);
      if (last === undefined) {
        // First sight of this task: arm it, never fire retroactively for all of history.
        await schedulerState.markFired(handle.name, nextRunFor(handle, new Date(at)).getTime() - 1);
        continue;
      }

      const due = occurrencesSince(handle, last, at);
      if (due.length === 0) continue;

      if (handle.catchUp === 'skip') {
        const latest = due[due.length - 1];
        if (latest !== undefined) dispatched.push(await dispatch(handle, latest, due.length > 1));
        continue;
      }
      if (handle.catchUp === 'run-once') {
        const first = due[0];
        if (first !== undefined) {
          dispatched.push(await dispatch(handle, first, due.length > 1));
          // `dispatch` leaves the watermark on the occurrence it RAN — the earliest missed one
          // here — so the next round found occurrences 2..n still due and fired the second, then
          // the third, one per tick until the backlog drained: 24 nightly digests a second apart
          // after a day down. "One catch-up" means the rest are DROPPED, and dropping an
          // occurrence is moving the watermark past it. `at` rather than the last element of
          // `due`, which `maxCatchUp` truncates: every occurrence at or before `at` is missed by
          // definition, and this policy fires none of them.
          if (first !== at) await schedulerState.markFired(handle.name, at);
        }
        continue;
      }
      for (const occurrence of due) {
        dispatched.push(await dispatch(handle, occurrence, occurrence !== due[due.length - 1]));
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

  const teardown = async (reason: string): Promise<void> => {
    state = 'draining';
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    logger.info('jobs.scheduler.draining', { reason, dispatching: round !== undefined });
    try {
      // The round this stop races runs to the end first. Releasing the lease under a
      // live dispatch hands the next node a task this one is still enqueueing for, and both
      // then own the same occurrence — the exact double-fire leader election exists to prevent.
      // Settled, not awaited: a round that failed is its own caller's to see, and the lease still
      // has to go back.
      await Promise.allSettled([round]);
      if (isLeader) await leader.release();
    } finally {
      // Whatever the release did, this scheduler is done. `isLeader` false because a lock this
      // process no longer holds — or failed to hand back — must never be re-used as if it did,
      // and the hook goes back: one left registered dispatches through a stopped scheduler on
      // the next process-wide drain, and keeps this closure and its driver alive with it.
      isLeader = false;
      state = 'stopped';
      releaseShutdownHook?.();
      releaseShutdownHook = undefined;
    }
  };

  const stop = async (reason = 'stop'): Promise<void> => {
    if (state === 'stopped') return;
    // One teardown, joined rather than repeated — the worker's rule, for the same reason: a
    // SIGTERM landing on a manual stop must wait out the same round, not release the lock a
    // second time behind it. Cleared as it settles, so a scheduler started again stops again.
    stopping ??= teardown(reason).finally(() => {
      stopping = undefined;
    });
    await stopping;
  };

  return {
    start() {
      // Only from a standstill. A start mid-drain would re-arm the loop on a lock the drain is
      // about to release, and stack a second shutdown hook on the one still running.
      if (state !== 'idle' && state !== 'stopped') return;
      state = 'running';
      // 'accept' phase: stop dispatching before core waits on in-flight work — an occurrence
      // enqueued during the drain is work nothing in this process is left to run. The
      // unregister is kept, never discarded: `stop()` hands it back, so start -> stop -> start
      // holds ONE hook rather than one per start.
      if (options.drainOnShutdown !== false) {
        releaseShutdownHook = onShutdown('jobs.scheduler', () => stop('SIGTERM'), {
          phase: 'accept',
        });
      }
      schedule();
      logger.info('jobs.scheduler.started', { tasks: (options.tasks ?? registeredTasks()).length });
    },
    stop,
    tick,
    nextRunFor,
  };
}
