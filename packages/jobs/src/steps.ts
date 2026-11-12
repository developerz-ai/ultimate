// Durable steps — the heart of the package. Each step's result is PERSISTED before the next
// one starts, so a retry replays completed steps from storage instead of re-executing them:
// the welcome email is not sent twice because step 3 failed. That makes step names the replay
// key, which is why they must be deterministic and unique within a run (X_STEP_DUPLICATE).
//
// Suspension (sleep / waitForEvent) unwinds the run by throwing a StepSuspension. The worker
// catches it and re-queues the job for `resumeAt` instead of holding a process for three days.
// `waitForEvent` is `steps-wait.ts`; compensation, `steps-unwind.ts`; both over `steps-core.ts`.

import type { Clock } from '@ultimat3/core';
import { finiteOption, isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import { JobAbortedError, JobTimeoutError, StepDuplicateError } from './errors';
import {
  isReservedStepName,
  StepCompensateUndeclaredError,
  StepNameReservedError,
  StepOutcomeUnknownError,
  UNWINDING_STEP,
} from './errors-saga';
import { createRunSignal } from './run-signal';
import { inStep } from './step-scope';
import type { EventLookup, StepApi, StepRunOptions } from './steps-api';
import { DEFAULT_EVENT_POLL_MS, WAKING_EVENT_POLL_MS } from './steps-api';
import type { RunnerCore } from './steps-core';
import type { StepOutput } from './steps-output';
import { jsonForm, stepOutputCeiling } from './steps-output';
import type { StepFence, StepRecord, StepStore } from './steps-store';
import { isStepSuspension, StepSuspension, UnwindReached } from './steps-suspension';
import { withStepTimeout } from './steps-timeout';
import { compensationStack } from './steps-unwind';
import { waitForEventStep } from './steps-wait';

export type {
  CompensateContext,
  EventLookup,
  EventSince,
  StepApi,
  StepRunOptions,
  WaitForEventOptions,
} from './steps-api';
export { DEFAULT_EVENT_POLL_MS, WAKING_EVENT_POLL_MS } from './steps-api';
export type { StepOutput } from './steps-output';
export type { StepFence, StepRecord, StepStatus, StepStore } from './steps-store';
export { isStepStatus, STEP_STATUSES } from './steps-store';
export { isStepSuspension, StepSuspension } from './steps-suspension';

export interface StepRunnerOptions {
  readonly runId: string;
  readonly jobName: string;
  readonly store: StepStore;
  /** The claim this attempt runs under — every write is fenced on it. `executeJob` passes it. */
  readonly fence?: StepFence;
  /**
   * The run's steps as the claim read them (`ClaimedJob.steps`): the hydrated view starts from
   * these and `store.list` is never asked. Sound for the reason the memo is — only the attempt
   * holding the claim writes to the run. Omitted, the first step lists the store.
   */
  readonly steps?: readonly StepRecord[];
  readonly clock?: Clock;
  readonly events?: EventLookup;
  /**
   * How long a waiting step stays parked between event polls. Default `DEFAULT_EVENT_POLL_MS`
   * (30 s), or `WAKING_EVENT_POLL_MS` (15 min) when `events.wakes`: a publish then brings the run
   * forward, and the poll is only the backstop. A value set here wins either way.
   */
  readonly eventPollMs?: number;
  /** The job declares `compensates: true`: `step.run(…, { compensate })` is legal. */
  readonly compensates?: boolean;
  /**
   * This attempt is past the policy's last (`isUnwindAttempt`): the run is unwinding whether or
   * not `unwinding` was written — the final attempt crashed before it could be.
   */
  readonly unwind?: boolean;
  /** Per-step ceiling; the job-level timeout is enforced by the worker. */
  readonly stepTimeoutMs?: number;
  /** Most JSON bytes a `step.run` output may hold (`job({ stepOutputMax })`): refused past it. */
  readonly stepOutputMaxBytes?: number;
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
  /** Whether the run is unwinding: `options.unwind`, or `unwinding` found among its steps. */
  unwinding(): Promise<boolean>;
  /**
   * Run this attempt's registered compensators, last-in first-out (`steps-unwind.ts`). Answers
   * the failure the run unwinds from — the one already recorded, else `failure`.
   */
  unwind(failure: string): Promise<string>;
  /**
   * The run's steps as this attempt holds them — what the claim handed over or the first list
   * read, plus every write since — oldest first; `undefined` until it has read them. What a
   * settle reports, without listing the store again.
   */
  known(): readonly StepRecord[] | undefined;
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
  const pollMs = finiteOption(
    'step.waitForEvent',
    'eventPollMs',
    options.eventPollMs ??
      (options.events?.wakes === true ? WAKING_EVENT_POLL_MS : DEFAULT_EVENT_POLL_MS),
  );
  // `job()` refuses a non-finite `stepTimeout` at declaration (`job.ts`); screened again here, where
  // it is read, because this runner is also built directly and `withStepTimeout` reads a `NaN`
  // ceiling as none at all — the backstop `pollMs` above already is.
  const stepTimeoutMs =
    options.stepTimeoutMs === undefined
      ? undefined
      : finiteOption('step.run', 'stepTimeoutMs', options.stepTimeoutMs);
  const outputCeiling = stepOutputCeiling(options.stepOutputMaxBytes);
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
   *
   * The PROMISE is the memo, and the map is published only when the list has answered: a map
   * assigned before the await let a second caller read it empty, so `Promise.all` over completed
   * steps re-ran one on replay and answered a value the store did not hold. A rejected list clears
   * the memo, so the next call asks again rather than this attempt failing on one blip for good.
   */
  let hydrated: Map<string, StepRecord> | undefined =
    options.steps === undefined
      ? undefined
      : new Map(options.steps.map((record) => [record.name, record]));
  let hydrating: Promise<Map<string, StepRecord>> | undefined =
    hydrated === undefined ? undefined : Promise.resolve(hydrated);

  const hydrate = (): Promise<Map<string, StepRecord>> => {
    if (hydrating !== undefined) return hydrating;
    const pending = (async () => {
      const records = await store.list(runId);
      hydrated = new Map(records.map((record) => [record.name, record]));
      return hydrated;
    })();
    hydrating = pending;
    pending.catch(() => {
      if (hydrating === pending) hydrating = undefined;
    });
    return pending;
  };

  const load = async (name: string): Promise<StepRecord | undefined> => (await hydrate()).get(name);

  /** Keep the hydrated view in step. Every write follows a `load`, so the list has answered. */
  const remember = (record: StepRecord): void => {
    hydrated?.set(record.name, record);
  };

  const claimName = (name: string): void => {
    // Refused for EVERY job, so one that gains `compensates` later cannot meet a step it wrote.
    if (isReservedStepName(name)) throw new StepNameReservedError({ job: jobName, step: name });
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

  // The run cancelled, or this attempt over — `ended` also covers one that COMPLETED, whose
  // `ctx.signal` stays un-aborted on purpose (`execute.ts`).
  const cancelled = (): boolean => runSignal.aborted || options.ended?.aborted === true;

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
      throw new JobAbortedError({
        job: jobName,
        step: record.name,
        ...(runSignal.aborted ? {} : { ended: true }),
      });
    }
    await persist(record);
    remember(record);
  };

  const now = (): number => nowMs(clock);

  /**
   * The run is unwinding: this attempt is past the policy's last, or `unwinding` is among the
   * steps the first `load` hydrated. Sticky — once true for an attempt it stays true.
   */
  let unwindMode = options.unwind === true;
  const unwinding = async (): Promise<boolean> => {
    if (!unwindMode) unwindMode = (await hydrate()).has(UNWINDING_STEP);
    return unwindMode;
  };

  /**
   * One step body, run under its ceiling and recorded: `completed` before it returns, `failed` on
   * the way out. Shared by `step.run` and by every compensator (`steps-unwind.ts`).
   */
  const execute = async <T>(
    name: string,
    existing: StepRecord | undefined,
    fn: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<StepOutput<T>> => {
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
        inStep(name, () => fn(signal)),
        stepTimeoutMs,
        deadline,
        () =>
          new JobTimeoutError({
            job: jobName,
            step: name,
            timeoutMs: stepTimeoutMs ?? 0,
            fix: `job({ name: '${jobName}', stepTimeout: '5m' })   # raises the ceiling; or split step.run('${name}', …) into smaller steps`,
          }),
      );
      // What goes in the store is what comes back, so both attempts see one value.
      const stored = jsonForm(output as T, { job: jobName, step: name }, outputCeiling);
      // Persist BEFORE returning: a crash one line later must not re-run this step.
      await put({
        runId,
        name,
        status: 'completed',
        output: stored,
        startedAt,
        completedAt: now(),
        attempts,
      });
      return stored;
    } catch (error) {
      if (isStepSuspension(error)) throw error;
      // The failure is this run's own history, so it is recorded on the way out — unless the
      // attempt was cancelled, in which case the history is no longer ours to write.
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
  };

  const core: RunnerCore = {
    runId,
    jobName,
    events: options.events,
    pollMs,
    claim: claimName,
    load,
    put,
    now,
    replayed: (name) => trace(replayed, name),
    forwardOnly: async (name) => {
      if (await unwinding()) throw new UnwindReached(name);
    },
  };
  const compensations = compensationStack(core, execute);

  async function run<T>(
    name: string,
    fn: (signal: AbortSignal) => Promise<T> | T,
    runOptions: StepRunOptions<T> = {},
  ): Promise<StepOutput<T>> {
    const { compensate, once = false } = runOptions;
    if (compensate !== undefined && options.compensates !== true) {
      throw new StepCompensateUndeclaredError({ job: jobName, step: name });
    }
    claimName(name);
    const undo =
      compensate === undefined
        ? undefined
        : (output: StepOutput<T>) => async (signal: AbortSignal) => {
            // A compensator's answer is not the run's to keep: `null` is what its step records.
            await compensate(output, { signal });
            return null;
          };
    const existing = await load(name);
    if (existing?.status === 'completed') {
      trace(replayed, name);
      const output = existing.output as StepOutput<T>;
      if (undo !== undefined) compensations.done(name, undo(output));
      return output;
    }
    // `started` or `failed` and never `completed`: a crash or a throw, and nobody knows which side
    // of the side effect it stopped on. `cleared` is an operator's "it did not run".
    const unknown = once && (existing?.status === 'started' || existing?.status === 'failed');
    if (unknown && undo !== undefined) compensations.unknown(name);
    await core.forwardOnly(name);
    if (unknown) throw new StepOutcomeUnknownError({ job: jobName, step: name });
    if (once) {
      // BEFORE `fn`: from here on, a replay cannot tell whether `fn` ran, and so never runs it.
      await put({
        runId,
        name,
        status: 'started',
        startedAt: existing?.startedAt ?? now(),
        attempts: existing?.attempts ?? 0,
      });
    }
    const output = await execute(name, once ? await load(name) : existing, fn);
    if (undo !== undefined) compensations.done(name, undo(output));
    return output;
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
    await core.forwardOnly(name);

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

  const step: StepApi = {
    run,
    sleep: sleep as StepApi['sleep'],
    waitForEvent: waitForEventStep(core),
  };

  return {
    step,
    usedNames: () => [...used],
    replayedNames: () => [...replayed],
    known: () =>
      hydrated === undefined
        ? undefined
        : [...hydrated.values()].sort((a, b) => a.startedAt - b.startedAt),
    unwinding,
    unwind: (failure) => compensations.unwind(failure),
  };
}
