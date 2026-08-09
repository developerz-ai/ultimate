// The `task` primitive + the `scheduler` role. A task NEVER does work: it enqueues jobs, so
// retries, idempotency and observability all come from the job machinery instead of being
// re-invented per cron.
//
// `tz` is required by the type. A cron without a timezone is a bug waiting for March: `0 3 *
// * *` in a DST-observing zone runs twice or zero times on the switch day, and "the nightly
// digest went out at 2am and again at 3am" is not a mystery anyone should have to debug.
//
// Exactly one node dispatches per tick, enforced by a Postgres advisory lock. Two schedulers
// double-enqueue every task; the idempotency key would absorb it, but leader election means
// the queue never sees the duplicate at all.

import type { Clock } from '@ultimat3/core';
import { assert, logger } from '@ultimat3/core';
import { instant, nextCronOccurrence } from '@ultimat3/time';
import { nowMs } from './clock';
import type { EnqueueResult, JobDriver } from './driver';
import type { AnyJobHandle } from './job';
import type { EnqueueOptions } from './outbox';

/** `[[sendDigest, {}]]` — a job handle plus its input. */
export type TaskEnqueueEntry = readonly [AnyJobHandle, unknown];

/**
 * What to do when the scheduler was down across one or more occurrences.
 * `skip` (default) waits for the next one; `run-once` fires a single catch-up; `run-all`
 * fires one per missed occurrence, bounded by `maxCatchUp`.
 */
export type CatchUpPolicy = 'skip' | 'run-once' | 'run-all';

export interface TaskDefinition {
  readonly name?: string;
  readonly cron: string;
  /** REQUIRED IANA zone, e.g. `'UTC'`, `'America/New_York'`. */
  readonly tz: string;
  /**
   * Builds the entries for ONE occurrence, given that occurrence's instant in epoch ms.
   *
   * The argument exists because catch-up does: a tick dispatched late, or replayed for a
   * missed occurrence, has a wall clock that no longer matches the occurrence being fired.
   * A payload derived from `Date.now()` there is silently for the wrong day — and the
   * scheduler's own key is occurrence-scoped, so nothing downstream catches it.
   */
  enqueue: (occurrenceMs: number) => readonly TaskEnqueueEntry[];
  readonly catchUp?: CatchUpPolicy;
  readonly maxCatchUp?: number;
}

/** One entry's outcome, from a scheduled dispatch or a manual `task.enqueue()` alike. */
export interface TaskJobResult {
  readonly job: string;
  readonly result: EnqueueResult;
}

/** JSON-safe view of a task for the manifest, `/_x` and the MCP dev server. */
export interface TaskDescriptor {
  readonly kind: 'task';
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly catchUp: CatchUpPolicy;
  readonly maxCatchUp: number;
  readonly jobs: readonly string[];
}

export interface TaskHandle {
  readonly kind: 'task';
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly catchUp: CatchUpPolicy;
  readonly maxCatchUp: number;
  /**
   * Entries for `occurrenceMs`. Defaults to now, which is the honest answer for the two
   * callers that have no occurrence: a manual `task.enqueue()` and `describe()`, which only
   * wants the job names.
   */
  entries(occurrenceMs?: number): readonly TaskEnqueueEntry[];
  /**
   * Fire this task's declared entries now, through the same facade `JobHandle.enqueue` uses —
   * the backfill and "run it again" path, with no scheduler and no leader involved.
   */
  enqueue(options?: EnqueueOptions): Promise<readonly TaskJobResult[]>;
  describe(): TaskDescriptor;
}

/** Resolves the next fire time. Injected so scheduling logic is testable without a cron impl. */
export type CronResolver = (cron: string, options: { tz: string; from: Date }) => Date;

const defaultCronResolver: CronResolver = (cron, options) =>
  // Instant is a branded Date, so it satisfies CronResolver's Date return directly.
  nextCronOccurrence(cron, options.tz, instant(options.from));

const registry = new Map<string, TaskHandle>();
let anonymous = 0;

/**
 * `Intl` carries the runtime's copy of the tz database and rejects anything not in it with a
 * `RangeError`, so it is the only check that can tell `America/Bogota` from `Bogota`.
 */
function isIanaZone(tz: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export function task(definition: TaskDefinition): TaskHandle {
  anonymous += 1;
  const name = definition.name ?? `anonymous-task-${anonymous}`;
  // Runtime backstop; the type already makes an omitted tz a build error.
  assert(
    typeof definition.tz === 'string' && definition.tz.length > 0,
    `task "${name}" needs an explicit IANA tz — a cron without a timezone is a bug`,
    `add tz to task("${name}"), e.g. tz: 'UTC' — an unzoned cron silently drifts by an hour at every DST transition`,
  );
  // A non-empty string is not a timezone. `tz: 'Bogota'` would otherwise resolve every
  // occurrence in UTC and the cron would run five hours off, silently, forever.
  assert(
    isIanaZone(definition.tz),
    `task "${name}" has tz "${definition.tz}", which is not a zone in the IANA tz database`,
    `use the full zone id on task("${name}"), e.g. tz: 'America/Bogota' — list the valid ones with: bun -e "console.log(Intl.supportedValuesOf('timeZone').join('\\n'))"`,
  );

  const handle: TaskHandle = {
    kind: 'task',
    name,
    cron: definition.cron,
    tz: definition.tz,
    catchUp: definition.catchUp ?? 'skip',
    maxCatchUp: definition.maxCatchUp ?? 10,
    // `nowMs()` and not `Date.now()`: every reading of time in this package goes through a
    // Clock so a frozen one cannot be bypassed.
    entries: (occurrenceMs: number = nowMs()) => definition.enqueue(occurrenceMs),
    async enqueue(options?: EnqueueOptions): Promise<readonly TaskJobResult[]> {
      const fired: TaskJobResult[] = [];
      for (const [handleForJob, input] of handle.entries()) {
        // The job's PLAIN key, deliberately not `dispatch()`'s `task:occurrence:key`: that one
        // is occurrence-scoped so two schedulers cannot double-fire the same tick, and reusing
        // it here would make a manual run dedupe against whichever occurrence it landed in.
        fired.push({ job: handleForJob.name, result: await handleForJob.enqueue(input, options) });
      }
      return fired;
    },
    // Reads `handle`, never the captured `name`: `nameTasks()` rebinds the property in place.
    describe(): TaskDescriptor {
      return {
        kind: 'task',
        name: handle.name,
        cron: handle.cron,
        tz: handle.tz,
        catchUp: handle.catchUp,
        maxCatchUp: handle.maxCatchUp,
        // Declaration order: a task's entries are a sequence, not a set.
        jobs: handle.entries().map(([entry]) => entry.name),
      };
    },
  };
  registry.set(name, handle);
  return handle;
}

export function nameTasks(record: Readonly<Record<string, TaskHandle>>): void {
  for (const [exportName, handle] of Object.entries(record)) {
    if (handle.name === exportName) continue;
    registry.delete(handle.name);
    Object.defineProperty(handle, 'name', { value: exportName, configurable: true });
    registry.set(exportName, handle);
  }
}

export function registeredTasks(): readonly TaskHandle[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getTask(name: string): TaskHandle | undefined {
  return registry.get(name);
}

export function resetTasks(): void {
  registry.clear();
  anonymous = 0;
}

export interface LeaderElection {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** Single-node default: always the leader. Multi-node uses `createPgLeader()`. */
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
  readonly tickIntervalMs?: number;
  /** Defaults to every registered task. */
  readonly tasks?: readonly TaskHandle[];
}

export interface DispatchedOccurrence {
  readonly task: string;
  readonly occurrenceMs: number;
  readonly jobs: readonly TaskJobResult[];
  readonly catchUp: boolean;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** One dispatch round. Returns what it enqueued — tests call this, not the timer. */
  tick(): Promise<readonly DispatchedOccurrence[]>;
  nextRunFor(handle: TaskHandle, from?: Date): Date;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const state = options.state ?? createMemorySchedulerState();
  const resolveCron = options.cron ?? defaultCronResolver;
  const tickIntervalMs = options.tickIntervalMs ?? 1_000;
  const leader = options.leader ?? soleLeader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let isLeader = false;

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
    await state.markFired(handle.name, occurrenceMs);
    logger.info('jobs.scheduler.dispatched', {
      task: handle.name,
      occurrence: new Date(occurrenceMs).toISOString(),
      tz: handle.tz,
      catchUp,
      jobs: jobs.length,
    });
    return { task: handle.name, occurrenceMs, jobs, catchUp };
  };

  const tick = async (): Promise<readonly DispatchedOccurrence[]> => {
    if (!isLeader) {
      isLeader = await leader.acquire();
      if (!isLeader) return [];
    }

    const at = nowMs(options.clock);
    const tasks = options.tasks ?? registeredTasks();
    const dispatched: DispatchedOccurrence[] = [];

    for (const handle of tasks) {
      const last = await state.lastFiredAt(handle.name);
      if (last === undefined) {
        // First sight of this task: arm it, never fire retroactively for all of history.
        await state.markFired(handle.name, nextRunFor(handle, new Date(at)).getTime() - 1);
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
        if (first !== undefined) dispatched.push(await dispatch(handle, first, due.length > 1));
        continue;
      }
      for (const occurrence of due) {
        dispatched.push(await dispatch(handle, occurrence, occurrence !== due[due.length - 1]));
      }
    }

    return dispatched;
  };

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          logger.error('jobs.scheduler.tick-failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, tickIntervalMs);
      logger.info('jobs.scheduler.started', { tasks: (options.tasks ?? registeredTasks()).length });
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (isLeader) await leader.release();
      isLeader = false;
    },
    tick,
    nextRunFor,
  };
}
