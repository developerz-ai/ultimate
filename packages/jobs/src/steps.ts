// Durable steps — the heart of the package. Each step's result is PERSISTED before the next
// one starts, so a retry replays completed steps from storage instead of re-executing them:
// the welcome email is not sent twice because step 3 failed. That makes step names the replay
// key, which is why they must be deterministic and unique within a run (X_STEP_DUPLICATE).
//
// Suspension (sleep / waitForEvent) unwinds the run by throwing a StepSuspension. The worker
// catches it and re-queues the job for `resumeAt` instead of holding a process for three days.

import type { Clock } from '@ultimat3/core';
import { finiteOption, isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import { JobAbortedError, JobTimeoutError, StepDuplicateError } from './errors';
import { createRunSignal } from './run-signal';
import {
  isStepSuspension,
  isWaitTimedOut,
  StepSuspension,
  WAIT_TIMED_OUT,
} from './steps-suspension';
import { withStepTimeout } from './steps-timeout';

export { isStepSuspension, StepSuspension } from './steps-suspension';

/**
 * The runtime list is the declaration and `StepStatus` is derived from it, the shape
 * `BACKFILL_STATUSES` and `PRIMITIVE_KINDS` already have. A bare union cannot narrow a `text`
 * column, so `driver-pg-rows.ts` cast one instead — and a cast that lands an unknown status on a
 * record makes `stepRun`'s `existing?.status === 'completed'` false, which RE-EXECUTES a step
 * this file promises runs once.
 */
export const STEP_STATUSES = ['completed', 'sleeping', 'waiting', 'failed'] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

/** Narrows a status read back out of a store. Never a cast — the list decides. */
export const isStepStatus = (value: string): value is StepStatus =>
  (STEP_STATUSES as readonly string[]).includes(value);

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

/** The claim a step write is made under: `claimOf(claimed)`, plus the row it names. */
export interface StepFence {
  readonly job: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly claim: number;
}

export interface StepStore {
  get(runId: string, name: string): Promise<StepRecord | undefined>;
  /**
   * With `by`, the write lands only while that claim still holds the row (`running`, same worker,
   * same claim ordinal — `SQL_ACK`'s fence) and is `X_JOB_LEASE_LOST` otherwise: the in-process
   * signal cannot stop a body in ANOTHER process whose lease lapsed. Without it the write is
   * unfenced — a transfer (`x jobs drain`) or a runner driven by hand, with no row to hold.
   */
  put(record: StepRecord, by?: StepFence): Promise<void>;
  list(runId: string): Promise<readonly StepRecord[]>;
  del(runId: string, name: string): Promise<void>;
  clear(runId: string): Promise<void>;
}

/** The slice of the event bus a waiting step needs. Implemented by `events.ts`. */
export interface EventLookup {
  /**
   * The bus's OWN clock, in epoch ms: what a publish issued now would be stamped with. A consumer
   * that wants "published after I asked" takes its "asked at" from here and never from its own
   * process — `publishedAt` is this clock's, and two clocks compared is a skew between pods
   * deciding which answers count. `waitForEvent` stamps a NEW wait with it.
   */
  now(): Promise<number>;
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

export interface StepRunnerOptions {
  readonly runId: string;
  readonly jobName: string;
  readonly store: StepStore;
  /** The claim this attempt runs under — every write is fenced on it. `executeJob` passes it. */
  readonly fence?: StepFence;
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
  /**
   * Aborted the moment the ATTEMPT is over — settled, or past its job deadline. `signal` alone
   * cannot say so once the drain has aborted it first (a controller keeps its first reason), and
   * the drain's reason writes through `put` (`writesThrough`): this is what still refuses a step
   * left in flight by a body that returned without awaiting it. `executeJob` passes it.
   */
  readonly ended?: AbortSignal;
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

export function stepRunner(options: StepRunnerOptions): StepRunner {
  const { runId, jobName, store } = options;
  /** Every name this attempt has claimed. Membership only — the trace is `used`. */
  const claimed = new Set<string>();
  const used: string[] = [];
  const replayed: string[] = [];
  const clock = options.clock;
  const pollMs = finiteOption('step.waitForEvent', 'eventPollMs', options.eventPollMs ?? 30_000);
  // `job()` refuses a non-finite `stepTimeout` at declaration (`job.ts`); screened again here, where
  // it is read, because this runner is also built directly and `withStepTimeout` reads a `NaN`
  // ceiling as none at all — the backstop `pollMs` above already is.
  const stepTimeoutMs =
    options.stepTimeoutMs === undefined
      ? undefined
      : finiteOption('step.run', 'stepTimeoutMs', options.stepTimeoutMs);
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

  /**
   * The one-argument `sleep('1h')` derives its step name from the duration, so a poll loop —
   * `for (…) { await step.sleep('1h') }`, the form the docs show — minted `sleep:1h` twice and
   * died with `X_STEP_DUPLICATE` on iteration 2. The occurrence ORDINAL disambiguates them, the
   * way `backfill()`'s `batch:<index>` does: the body re-runs from the top on every replay, so
   * the same sequence of calls mints the same sequence of names.
   *
   * The FIRST occurrence keeps the bare `sleep:1h`, so a run already suspended on one resumes
   * across this change instead of re-sleeping under a new key.
   */
  const sleepOrdinals = new Map<string, number>();
  const derivedSleepName = (duration: string): string => {
    const base = `sleep:${duration}`;
    const occurrence = (sleepOrdinals.get(base) ?? 0) + 1;
    sleepOrdinals.set(base, occurrence);
    return occurrence === 1 ? base : `${base}#${occurrence}`;
  };

  const cancelled = (): boolean => runSignal.aborted;

  /**
   * A cancelled run whose step result is still this attempt's to record: the worker's drain cut
   * it short (`X_DRAINING`, `worker-drain-cutoff.ts`), the write is fenced on the claim, and the
   * attempt has not ended. The side effect behind the record HAPPENED — refused, the next worker
   * runs it again. The fence is what makes this safe and not the in-process signal: a row the
   * drain has already handed back answers the write `X_JOB_LEASE_LOST` in the store.
   */
  const writesThrough = (): boolean =>
    options.fence !== undefined &&
    options.ended?.aborted !== true &&
    isUltimateError(runSignal.reason) &&
    runSignal.reason.code === 'X_DRAINING';

  /**
   * The statement itself, declared deliberate to the N+1 detector. One write per step IS the
   * design this file's header states — each step completes at its own instant and its output has
   * to be durable before the next one starts, so five steps are five `SQL_STEP_PUT`s that no
   * batch could replace. Without the declaration `x dev` warned `X_N_PLUS_ONE_WRITE` on every
   * job of five or more steps, a verdict against the framework's own persistence that an app
   * could neither fix nor silence. The scope ends with the write: the hydrating `list` and the
   * job's own statements are judged as before.
   */
  const persist = (record: StepRecord): Promise<void> =>
    expectedQueryLoop(
      'a durable step is written the instant it completes, one statement per step by design',
      () => store.put(record, options.fence),
    );

  /**
   * EVERY write this runner makes, and the one place the cancellation is enforced. A step result
   * from a cancelled attempt is a write onto the attempt that replaced it: the deadline nacked
   * this job, another worker claimed the same `runId`, and a late `put` would hand it a step it
   * never ran — or overwrite one it did. The write is refused, and refusing it unwinds the body.
   */
  const put = async (record: StepRecord): Promise<void> => {
    if (cancelled() && !writesThrough()) {
      throw new JobAbortedError({ job: jobName, step: record.name });
    }
    await persist(record);
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
    // `createRunSignal` and never `AbortSignal.any`, which is the rule this package's `CLAUDE.md`
    // states as absolute: a composite cannot be undone, so ONE dependent signal per STEP stayed on
    // the run's signal for the whole attempt. A `backfill()` at `batch: 1000` over 5M rows is
    // 5,000 of them held at once, and an app whose `WorkerOptions.context()` carries a
    // process-lifetime signal keeps them past the run. Composed only when there is a second signal
    // to compose, and DISPOSED in the `finally` below, which is the whole reason `run-signal.ts`
    // exists — `worker-run.ts` disposes the run's own the same way.
    const composed =
      stepTimeoutMs === undefined ? null : createRunSignal([runSignal, deadline.signal]);
    const signal = composed?.signal ?? runSignal;
    try {
      const output = await withStepTimeout(
        fn(signal),
        stepTimeoutMs,
        deadline,
        () => new JobTimeoutError({ job: jobName, step: name, timeoutMs: stepTimeoutMs ?? 0 }),
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
          error: renderThrowable(error),
        };
        try {
          await persist(failure);
          remember(failure);
        } catch (unwritten) {
          logger.warn('jobs.step.failure-unrecorded', {
            job: jobName,
            step: name,
            error: renderThrowable(unwritten),
          });
        }
      }
      throw error;
    } finally {
      // Nothing of the run's is held past the step. Idempotent, and it never aborts: a step that
      // settled leaves its signal in whatever state it ended in.
      composed?.dispose();
    }
  }

  async function sleep(a: string | DurationInput, b?: DurationInput): Promise<void> {
    // `sleep('3d')` — the duration doubles as the step name, which stays deterministic.
    const name = b === undefined ? derivedSleepName(String(a)) : String(a);
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

    const wakeAt =
      at + finiteDurationMs(duration, `job "${jobName}" step.sleep("${name}")`, 'duration');
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
      return isWaitTimedOut(existing.output) ? undefined : (existing.output as T | undefined);
    }

    const at = now();
    // A NEW wait is stamped by the bus, whose clock stamps every `publishedAt` it is compared
    // with; the runner's own only when there is no bus to ask. A re-poll keeps what it persisted.
    const startedAt = existing?.startedAt ?? (await options.events?.now()) ?? at;
    const deadline =
      startedAt +
      finiteDurationMs(waitOptions.timeout ?? 86_400_000, 'step.waitForEvent', 'timeout');
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

    // `deadline` is on the BUS's clock, so the bus calls the timeout: asked only once this runner
    // believes the time is up, which costs a wait one statement at its end. A runner AHEAD of the
    // bus used to give up early by the skew — on an answer still inside its window. (A runner
    // BEHIND waits the skew longer; knowing that sooner would cost a round trip on every poll.)
    let remaining = deadline - at;
    if (remaining <= 0) remaining = deadline - ((await options.events?.now()) ?? at);
    if (remaining <= 0) {
      if (waitOptions.required === true) {
        throw new JobTimeoutError({
          job: jobName,
          step: name,
          timeoutMs: finiteDurationMs(
            waitOptions.timeout ?? 86_400_000,
            'step.waitForEvent',
            'timeout',
          ),
        });
      }
      logger.warn('jobs.step.wait-timeout', { job: jobName, step: name, event });
      await put({
        runId,
        name,
        status: 'completed',
        output: WAIT_TIMED_OUT,
        startedAt,
        completedAt: at,
        event,
        attempts: (existing?.attempts ?? 0) + 1,
      });
      return undefined;
    }

    const resumeAt = at + Math.min(remaining, pollMs);
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
