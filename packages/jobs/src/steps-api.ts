// What a job body is handed as `step`, and the slice of the event bus its waits read. Split from
// `steps.ts` at the file-size ceiling: that file is the runner, this is the contract it implements.

import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { StepOutput } from './steps-output';

/** How long a waiting step stays parked between polls when the bus does not wake it. */
export const DEFAULT_EVENT_POLL_MS = 30_000;

/**
 * The backstop when the bus DOES wake (`EventLookup.wakes`): a publish brings the run forward, so
 * the poll is only the guarantee — and what fires a timeout. 96 replays per 24 h wait, not 2,880.
 */
export const WAKING_EVENT_POLL_MS = 900_000;

/**
 * Where a wait begins — its stamp, and what the bus could see then (`EventLookup.mark`) — and the
 * events it refused BEHIND its cursor: one owed through the horizon sorts before the cursor, so
 * the cursor stays and its id is excluded by name. Moving the cursor back to it re-opened every
 * event between the two, the one refused before it included.
 */
export interface EventSince {
  readonly at: number;
  readonly horizon?: string | undefined;
  readonly refused?: readonly string[] | undefined;
}

/** The slice of the event bus a waiting step needs. Implemented by `events.ts`. */
export interface EventLookup {
  /**
   * Whether a publish makes the runs parked on it due in the same statement — `true` only for
   * `postgresEventBus({ wakes: true })` over the queue's own database. Then a waiting step parks
   * for `WAKING_EVENT_POLL_MS`, and asks once more after parking: an event committed between its
   * first `find` and its `waiting` row met no waiter to wake. Absent: the poll is the only way.
   */
  readonly wakes?: boolean;
  /**
   * The bus's OWN clock, in epoch ms: what a publish issued now would be stamped with. A consumer
   * that wants "published after I asked" takes its "asked at" from here and never from its own
   * process — `publishedAt` is this clock's, and two clocks compared is a skew between pods
   * deciding which answers count. `waitForEvent` stamps a NEW wait with it.
   */
  now(): Promise<number>;
  /**
   * A NEW wait's starting line, read in ONE statement: the bus's `now()`, and the `horizon` — what
   * the bus could see at that instant. Over a database an event is stamped at INSERT and visible
   * at COMMIT, so a publish whose transaction was still open when the wait began carries a stamp
   * BEFORE it: by `afterMs` alone every later search skips it and the wait runs to its timeout.
   * `find` given the horizon also matches every event the horizon could not see. Absent on a bus
   * with no transactions (the memory one): there every publish is visible as it is stamped.
   */
  mark?(): Promise<{ readonly at: number; readonly horizon?: string }>;
  /**
   * The earliest match past the cursor in the bus's own `(published, id)` order
   * (`events-cursor.ts`): published at or after `afterMs` — and, given `afterId`, strictly past
   * `(afterMs, afterId)`. The id is the cursor a refused event leaves: a floor of
   * `publishedAt + 1` stepped over every valid event stamped in the same millisecond. Compared,
   * never looked up, so a cursor whose event was purged still excludes what it excluded.
   *
   * Given a `horizon` (from `mark`, or a hit's own), ALSO every event that horizon could not see,
   * whatever its stamp. A hit answers the horizon of the search that found it, which is the one a
   * refusal's cursor must carry: anything that search could not see is still owed to the wait.
   *
   * `since` is the WAIT's own line, which a refusal's cursor never moves: only an event stamped at
   * or after `since.at`, or unseen by `since.horizon` (the mark's), is the wait's at all. Absent,
   * it is `{ at: afterMs, horizon }` — right for a search that never refused anything. A cursor
   * alone let an event committed BEFORE the wait sort past a refused one and be handed out.
   */
  find(
    event: string,
    correlationKey: string | undefined,
    afterMs: number,
    afterId?: string,
    horizon?: string,
    since?: EventSince,
  ): Promise<
    | {
        readonly id: string;
        readonly payload: unknown;
        readonly publishedAt: number;
        readonly horizon?: string;
      }
    | undefined
  >;
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

/** What a compensator is handed beside the step's own stored output. */
export interface CompensateContext {
  /** The run's cancellation, and the compensating step's own ceiling. */
  readonly signal: AbortSignal;
}

export interface StepRunOptions<T> {
  /**
   * Undoes this step if the run fails FOR GOOD — never on a retry, a cancel, a drain or a
   * suspension. Run last-in first-out, each as step `compensate:<name>`, so a replay skips what
   * already ran. Needs `job({ compensates: true })`, or the call is `X_JOB_DECLARATION_INVALID`.
   * Re-registered by every replay from the top: the closure is never stored.
   */
  readonly compensate?: (
    output: StepOutput<T>,
    ctx: CompensateContext,
  ) => Promise<unknown> | unknown;
  /**
   * At most once, ever. A `started` record is written BEFORE `fn`; a replay that finds it (or a
   * `failed` one) without `completed` stops with terminal `X_STEP_OUTCOME_UNKNOWN`, because a
   * crash and a throw both leave "did it happen?" unanswered. `x jobs resolve-step` answers it.
   */
  readonly once?: boolean;
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
  run<T>(
    name: string,
    fn: (signal: AbortSignal) => Promise<T> | T,
    options?: StepRunOptions<T>,
  ): Promise<StepOutput<T>>;
  /** Suspend the run. `sleep(duration)` derives the step name from the duration. */
  sleep(name: string, duration: DurationInput): Promise<void>;
  sleep(duration: DurationInput): Promise<void>;
  waitForEvent<S extends StandardSchemaV1>(
    name: string,
    event: string,
    options: WaitForEventOptions<S>,
  ): Promise<InferOutput<S> | undefined>;
}
