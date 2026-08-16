// Durable steps — the heart of the package. Each step's result is PERSISTED before the next
// one starts, so a retry replays completed steps from storage instead of re-executing them:
// the welcome email is not sent twice because step 3 failed. That makes step names the replay
// key, which is why they must be deterministic and unique within a run (X_STEP_DUPLICATE).
//
// Suspension (sleep / waitForEvent) unwinds the run by throwing a StepSuspension. The worker
// catches it and re-queues the job for `resumeAt` instead of holding a process for three days.

import type { Clock } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { nowMs, toMs } from './clock';
import { JobAbortedError, JobTimeoutError, StepDuplicateError } from './errors';

export type StepStatus = 'completed' | 'sleeping' | 'waiting' | 'failed';

export interface StepRecord {
  readonly runId: string;
  readonly name: string;
  readonly status: StepStatus;
  /** The memoized return value. Present only when `status === 'completed'`. */
  readonly output?: unknown;
  readonly startedAt: number;
  readonly completedAt?: number;
  /** Epoch ms at which a sleeping/waiting step becomes runnable. */
  readonly wakeAt?: number;
  readonly event?: string;
  readonly correlationKey?: string;
  readonly attempts: number;
  readonly error?: string;
}

export interface StepStore {
  get(runId: string, name: string): Promise<StepRecord | undefined>;
  put(record: StepRecord): Promise<void>;
  list(runId: string): Promise<readonly StepRecord[]>;
  del(runId: string, name: string): Promise<void>;
  clear(runId: string): Promise<void>;
}

/** The slice of the event bus a waiting step needs. Implemented by `events.ts`. */
export interface EventLookup {
  find(
    event: string,
    correlationKey: string | undefined,
    afterMs: number,
  ): Promise<{ readonly payload: unknown; readonly publishedAt: number } | undefined>;
}

export interface WaitForEventOptions {
  /** How long to wait before giving up. Default 24h. */
  readonly timeout?: DurationInput;
  /** Correlation key the published event must carry — usually an entity id. */
  readonly match?: string;
  /** Default false: a timeout resolves `undefined`. `true` fails the job with X_JOB_TIMEOUT. */
  readonly required?: boolean;
}

export interface StepApi {
  /**
   * Run once, ever. On replay the persisted output is returned and `fn` is not called.
   *
   * `fn` receives the step's `AbortSignal` — the run's cancellation and this step's own ceiling,
   * whichever fires first. Hand it to `fetch`, or read `.aborted` in a loop: past it, this step
   * may no longer write, because the attempt that replaced this one owns the run.
   */
  run<T>(name: string, fn: (signal: AbortSignal) => Promise<T> | T): Promise<T>;
  /** Suspend the run. `sleep(duration)` derives the step name from the duration. */
  sleep(name: string, duration: DurationInput): Promise<void>;
  sleep(duration: DurationInput): Promise<void>;
  waitForEvent<T>(
    name: string,
    event: string,
    options?: WaitForEventOptions,
  ): Promise<T | undefined>;
}

/**
 * Control flow, not a failure: it must never be logged as an error or counted as an attempt.
 * Branded by string rather than `instanceof` so two copies of this module still agree.
 */
export class StepSuspension extends Error {
  static readonly brand = 'ultimate.jobs.suspension';
  readonly brand: string = StepSuspension.brand;
  readonly step: string;
  readonly resumeAt: number;
  readonly reason: 'sleep' | 'event';

  constructor(input: { step: string; resumeAt: number; reason: 'sleep' | 'event' }) {
    super(`step "${input.step}" suspended until ${new Date(input.resumeAt).toISOString()}`);
    this.name = 'StepSuspension';
    this.step = input.step;
    this.resumeAt = input.resumeAt;
    this.reason = input.reason;
  }
}

export function isStepSuspension(error: unknown): error is StepSuspension {
  return error instanceof Error && (error as { brand?: unknown }).brand === StepSuspension.brand;
}

export function createMemoryStepStore(): StepStore {
  const byRun = new Map<string, Map<string, StepRecord>>();
  const runOf = (runId: string): Map<string, StepRecord> => {
    let run = byRun.get(runId);
    if (run === undefined) {
      run = new Map();
      byRun.set(runId, run);
    }
    return run;
  };
  return {
    get(runId, name) {
      return Promise.resolve(byRun.get(runId)?.get(name));
    },
    put(record) {
      runOf(record.runId).set(record.name, record);
      return Promise.resolve();
    },
    list(runId) {
      const records = [...(byRun.get(runId)?.values() ?? [])];
      return Promise.resolve(records.sort((a, b) => a.startedAt - b.startedAt));
    },
    del(runId, name) {
      byRun.get(runId)?.delete(name);
      return Promise.resolve();
    },
    clear(runId) {
      byRun.delete(runId);
      return Promise.resolve();
    },
  };
}

export interface StepRunnerOptions {
  readonly runId: string;
  readonly jobName: string;
  readonly store: StepStore;
  readonly clock?: Clock;
  readonly events?: EventLookup;
  /** How long a waiting step stays parked between event polls. Default 30s. */
  readonly eventPollMs?: number;
  /** Per-step ceiling; the job-level timeout is enforced by the worker. */
  readonly stepTimeoutMs?: number;
  /**
   * The run's cancellation — `executeJob` aborts it at the job's deadline. Once aborted this
   * runner writes nothing: the nack that follows a deadline makes the job claimable, so the
   * store belongs to whichever attempt has it now.
   */
  readonly signal?: AbortSignal;
}

export interface StepRunner {
  readonly step: StepApi;
  /**
   * Names used in THIS attempt, in order — the trace shown by `x jobs show`. Bounded at
   * `MAX_TRACE_NAMES`, oldest dropped: duplicate detection reads its own set, so this is a
   * window on a long run and never the run's record.
   */
  usedNames(): readonly string[];
  /** Names that were served from storage instead of executed. Bounded the same way. */
  replayedNames(): readonly string[];
}

/** Stands in for an absent run signal, so the fence has one shape and no `undefined` branch. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * What one attempt's trace keeps. The trace is a diagnostic `x jobs show` renders, never the
 * run's record — `driver.steps.list(runId)` is that — and a `backfill()` over a million rows
 * claims 20,000 names in a single attempt, all of them carried to the end of the run.
 */
export const MAX_TRACE_NAMES = 200;

/** Most recent first out: the tail of a long run is the half an operator is reading. */
function trace(into: string[], name: string): void {
  into.push(name);
  if (into.length > MAX_TRACE_NAMES) into.shift();
}

export function createStepRunner(options: StepRunnerOptions): StepRunner {
  const { runId, jobName, store } = options;
  /** Every name this attempt has claimed. Membership only — the trace is `used`. */
  const claimed = new Set<string>();
  const used: string[] = [];
  const replayed: string[] = [];
  const clock = options.clock;
  const pollMs = options.eventPollMs ?? 30_000;
  const runSignal = options.signal ?? NEVER_ABORTED;

  /**
   * This attempt's view of the run's persisted steps, hydrated from ONE `store.list(runId)` the
   * first time a step asks. Replay used to cost one `SQL_STEP_GET` per completed step: a
   * `backfill()` over 5M rows at `batch: 1000` is 5,000 steps, so an attempt killed at 4,800
   * issued 4,800 sequential round trips before reading a single new row — and re-paid them on
   * every retry, often outrunning its own visibility timeout while the heartbeat was still
   * renewing.
   *
   * Sound because the fence in `put()` is: only the attempt that owns the run may write to it, so
   * within one attempt an absent name stays absent unless this runner writes it. Writes go into
   * the map as they go into the store, never the other way round — the store is still the record.
   */
  let hydrated: Map<string, StepRecord> | undefined;

  const load = async (name: string): Promise<StepRecord | undefined> => {
    if (hydrated === undefined) {
      hydrated = new Map();
      for (const record of await store.list(runId)) hydrated.set(record.name, record);
    }
    return hydrated.get(name);
  };

  /** Keep the hydrated view in step with what was just persisted. */
  const remember = (record: StepRecord): void => {
    hydrated?.set(record.name, record);
  };

  const claimName = (name: string): void => {
    // The Set decides, the array only reports. `Array.includes` made a long run quadratic —
    // `backfill({ batch: 50 })` over a million rows is 20,000 steps and ~200M string compares.
    if (claimed.has(name)) throw new StepDuplicateError({ job: jobName, step: name });
    claimed.add(name);
    trace(used, name);
  };

  const cancelled = (): boolean => runSignal.aborted;

  /**
   * EVERY write this runner makes, and the one place the cancellation is enforced. A step result
   * from a cancelled attempt is a write onto the attempt that replaced it: the deadline nacked
   * this job, another worker claimed the same `runId`, and a late `put` would hand it a step it
   * never ran — or overwrite one it did. The write is refused, and refusing it unwinds the body.
   */
  const put = async (record: StepRecord): Promise<void> => {
    if (cancelled()) throw new JobAbortedError({ job: jobName, step: record.name });
    await store.put(record);
    remember(record);
  };

  const now = (): number => nowMs(clock);

  async function run<T>(name: string, fn: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    claimName(name);
    const existing = await load(name);
    if (existing?.status === 'completed') {
      trace(replayed, name);
      return existing.output as T;
    }

    const startedAt = existing?.startedAt ?? now();
    const attempts = (existing?.attempts ?? 0) + 1;
    // The step's own ceiling, folded into the run's cancellation so the body reads ONE signal and
    // sees whichever deadline lands first. Composed only when there is a second one to compose.
    const deadline = new AbortController();
    const signal =
      options.stepTimeoutMs === undefined
        ? runSignal
        : AbortSignal.any([runSignal, deadline.signal]);
    try {
      const output = await withStepTimeout(
        fn(signal),
        options.stepTimeoutMs,
        deadline,
        () =>
          new JobTimeoutError({ job: jobName, step: name, timeoutMs: options.stepTimeoutMs ?? 0 }),
      );
      // Persist BEFORE returning: a crash one line later must not re-run this step.
      await put({
        runId,
        name,
        status: 'completed',
        output,
        startedAt,
        completedAt: now(),
        attempts,
      });
      return output;
    } catch (error) {
      if (isStepSuspension(error)) throw error;
      // The failure is this run's own history, so it is recorded on the way out — unless the
      // attempt was cancelled, in which case the history is no longer ours to write. The original
      // error is what the caller has to see, never one raised by the bookkeeping.
      if (!cancelled()) {
        // Deliberately NOT through `put`: the caller has to see the original error, never one
        // raised by the bookkeeping. The hydrated view is updated by hand for the same reason.
        const failure: StepRecord = {
          runId,
          name,
          status: 'failed',
          startedAt,
          attempts,
          error: error instanceof Error ? error.message : String(error),
        };
        await store.put(failure);
        remember(failure);
      }
      throw error;
    }
  }

  async function sleep(a: string | DurationInput, b?: DurationInput): Promise<void> {
    // `sleep('3d')` — the duration doubles as the step name, which stays deterministic.
    const name = b === undefined ? `sleep:${String(a)}` : String(a);
    const duration = b === undefined ? (a as DurationInput) : b;
    claimName(name);

    const existing = await load(name);
    if (existing?.status === 'completed') {
      trace(replayed, name);
      return;
    }

    const at = now();
    if (existing?.status === 'sleeping' && existing.wakeAt !== undefined) {
      if (existing.wakeAt <= at) {
        await put({ ...existing, status: 'completed', completedAt: at });
        return;
      }
      throw new StepSuspension({ step: name, resumeAt: existing.wakeAt, reason: 'sleep' });
    }

    const wakeAt = at + toMs(duration);
    await put({
      runId,
      name,
      status: 'sleeping',
      startedAt: at,
      wakeAt,
      attempts: 1,
    });
    throw new StepSuspension({ step: name, resumeAt: wakeAt, reason: 'sleep' });
  }

  async function waitForEvent<T>(
    name: string,
    event: string,
    waitOptions: WaitForEventOptions = {},
  ): Promise<T | undefined> {
    claimName(name);
    const existing = await load(name);
    if (existing?.status === 'completed') {
      trace(replayed, name);
      return existing.output as T | undefined;
    }

    const at = now();
    const startedAt = existing?.startedAt ?? at;
    const deadline = startedAt + toMs(waitOptions.timeout ?? 86_400_000);
    const correlationKey = waitOptions.match;

    const hit = await options.events?.find(event, correlationKey, startedAt);
    if (hit !== undefined) {
      await put({
        runId,
        name,
        status: 'completed',
        output: hit.payload,
        startedAt,
        completedAt: at,
        event,
        attempts: (existing?.attempts ?? 0) + 1,
        ...(correlationKey === undefined ? {} : { correlationKey }),
      });
      return hit.payload as T;
    }

    if (at >= deadline) {
      if (waitOptions.required === true) {
        throw new JobTimeoutError({
          job: jobName,
          step: name,
          timeoutMs: toMs(waitOptions.timeout ?? 86_400_000),
        });
      }
      logger.warn('jobs.step.wait-timeout', { job: jobName, step: name, event });
      await put({
        runId,
        name,
        status: 'completed',
        output: undefined,
        startedAt,
        completedAt: at,
        event,
        attempts: (existing?.attempts ?? 0) + 1,
      });
      return undefined;
    }

    const resumeAt = Math.min(deadline, at + pollMs);
    await put({
      runId,
      name,
      status: 'waiting',
      startedAt,
      wakeAt: resumeAt,
      event,
      attempts: (existing?.attempts ?? 0) + 1,
      ...(correlationKey === undefined ? {} : { correlationKey }),
    });
    throw new StepSuspension({ step: name, resumeAt, reason: 'event' });
  }

  const step: StepApi = {
    run,
    sleep: sleep as StepApi['sleep'],
    waitForEvent,
  };

  return {
    step,
    usedNames: () => [...used],
    replayedNames: () => [...replayed],
  };
}

/**
 * A step's own ceiling. It ABORTS before it rejects, in that order: `run()` fails the step on this
 * rejection and the job retries, so a body still holding a socket open past the deadline would be
 * racing the attempt that replaced it. Cancelling first is the only thing that can stop it.
 */
function withStepTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number | undefined,
  deadline: AbortController,
  error: () => Error,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const failure = error();
      deadline.abort(failure);
      reject(failure);
    }, timeoutMs);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
