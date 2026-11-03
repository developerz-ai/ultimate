// What a job body is handed as `step`, and the slice of the event bus its waits read. Split from
// `steps.ts` at the file-size ceiling: that file is the runner, this is the contract it implements.

import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { StepOutput } from './steps-output';

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

export interface WaitForEventOptions<S extends StandardSchemaV1 = StandardSchemaV1> {
  /**
   * What the event must be. REQUIRED: publisher and waiter are usually different files, so a type
   * the waiter wrote is a cast. A payload it refuses is `X_JOB_EVENT_INVALID`, on a hit or a replay.
   */
  readonly schema: S;
  /** How long to wait before giving up. Default 24h. */
  readonly timeout?: DurationInput;
  /** Correlation key the published event must carry — usually an entity id. */
  readonly match?: string;
  /** Default false: a timeout resolves `undefined`. `true` fails the job with X_JOB_TIMEOUT. */
  readonly required?: boolean;
}

export interface StepApi {
  /**
   * Run once, ever. On replay the persisted output is returned and `fn` is not called. Both
   * attempts answer the stored JSON form, `StepOutput<T>`: a `Date` comes back a string on attempt
   * 1 too, and a value JSON cannot hold is `X_STEP_OUTPUT_UNSERIALIZABLE`.
   *
   * `fn` receives the step's `AbortSignal` — the run's cancellation and this step's own ceiling,
   * whichever fires first. Hand it to `fetch`, or read `.aborted` in a loop: past it, this step
   * may no longer write, because the attempt that replaced this one owns the run.
   */
  run<T>(name: string, fn: (signal: AbortSignal) => Promise<T> | T): Promise<StepOutput<T>>;
  /** Suspend the run. `sleep(duration)` derives the step name from the duration. */
  sleep(name: string, duration: DurationInput): Promise<void>;
  sleep(duration: DurationInput): Promise<void>;
  waitForEvent<S extends StandardSchemaV1>(
    name: string,
    event: string,
    options: WaitForEventOptions<S>,
  ): Promise<InferOutput<S> | undefined>;
}
