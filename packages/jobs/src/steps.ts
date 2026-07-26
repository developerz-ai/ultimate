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
import { JobTimeoutError, StepDuplicateError } from './errors';

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
  /** Run once, ever. On replay the persisted output is returned and `fn` is not called. */
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
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
}

export interface StepRunner {
  readonly step: StepApi;
  /** Names used in THIS attempt, in order — the trace shown by `x jobs show`. */
  usedNames(): readonly string[];
  /** Names that were served from storage instead of executed. */
  replayedNames(): readonly string[];
}

export function createStepRunner(options: StepRunnerOptions): StepRunner {
  const { runId, jobName, store } = options;
  const used: string[] = [];
  const replayed: string[] = [];
  const clock = options.clock;
  const pollMs = options.eventPollMs ?? 30_000;

  const claimName = (name: string): void => {
    if (used.includes(name)) throw new StepDuplicateError({ job: jobName, step: name });
    used.push(name);
  };

  const now = (): number => nowMs(clock);

  async function run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    claimName(name);
    const existing = await store.get(runId, name);
    if (existing?.status === 'completed') {
      replayed.push(name);
      return existing.output as T;
    }

    const startedAt = existing?.startedAt ?? now();
    const attempts = (existing?.attempts ?? 0) + 1;
    try {
      const output = await withStepTimeout(
        fn(),
        options.stepTimeoutMs,
        () =>
          new JobTimeoutError({ job: jobName, step: name, timeoutMs: options.stepTimeoutMs ?? 0 }),
      );
      // Persist BEFORE returning: a crash one line later must not re-run this step.
      await store.put({
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
      await store.put({
        runId,
        name,
        status: 'failed',
        startedAt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function sleep(a: string | DurationInput, b?: DurationInput): Promise<void> {
    // `sleep('3d')` — the duration doubles as the step name, which stays deterministic.
    const name = b === undefined ? `sleep:${String(a)}` : String(a);
    const duration = b === undefined ? (a as DurationInput) : b;
    claimName(name);

    const existing = await store.get(runId, name);
    if (existing?.status === 'completed') {
      replayed.push(name);
      return;
    }

    const at = now();
    if (existing?.status === 'sleeping' && existing.wakeAt !== undefined) {
      if (existing.wakeAt <= at) {
        await store.put({ ...existing, status: 'completed', completedAt: at });
        return;
      }
      throw new StepSuspension({ step: name, resumeAt: existing.wakeAt, reason: 'sleep' });
    }

    const wakeAt = at + toMs(duration);
    await store.put({
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
    const existing = await store.get(runId, name);
    if (existing?.status === 'completed') {
      replayed.push(name);
      return existing.output as T | undefined;
    }

    const at = now();
    const startedAt = existing?.startedAt ?? at;
    const deadline = startedAt + toMs(waitOptions.timeout ?? 86_400_000);
    const correlationKey = waitOptions.match;

    const hit = await options.events?.find(event, correlationKey, startedAt);
    if (hit !== undefined) {
      await store.put({
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
      await store.put({
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
    await store.put({
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

function withStepTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number | undefined,
  error: () => Error,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), timeoutMs);
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
