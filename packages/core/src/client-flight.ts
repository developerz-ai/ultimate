/**
 * One typed-client call's flight control: supersession, dedup, retry, a deadline and a
 * concurrency ceiling — composed from this package's own primitives, so no second fence, flight
 * map, gate or backoff curve exists anywhere. Transport-agnostic: the caller supplies the
 * dispatch, this file decides how many times it happens and whether the answer still counts.
 *
 * Tier 0 because `@ultimat3/action` and `@ultimat3/query` both project a typed client and are
 * both tier 3, so neither may import the other. It shipped as a byte-identical 288-line copy in
 * each; both re-export this one, so their public surface is unchanged and there is one file.
 *
 * Nothing here is imported by either package's `client.ts` at VALUE level. A caller that wants a
 * plain typed fetch never mentions `createClientFlight`, so this module and every module it
 * imports are shaken out of that caller's bundle — the 36 kB island problem is the reason it is
 * built this way, and `packages/{action,query}/src/client.ts` must keep naming `ClientFlight` as
 * an `import type`.
 */

import type { Random } from './backoff';
import { classifyThrown } from './error-retry';
import { UltimateError } from './errors';
import type { FlightGate, FlightGateLimits } from './flight-gate';
import { createFlightGate } from './flight-gate';
import { createFence } from './generation-fence';
import type { RetryPolicy } from './retry';
import { retry } from './retry';
import type { Scheduler } from './single-flight';
import { createSingleFlight } from './single-flight';

/** Overrides for the shipped policy. `attempts: 1` — the default — means one dispatch, no retry. */
export type ClientRetry = Partial<RetryPolicy>;

/**
 * `attempts: 1` is NO retry, and that is the default deliberately: every existing caller of
 * `rpc()` and `queryClient()` was written against exactly one dispatch, and a client that retries
 * by default triples the load on a service on the day it can least afford it. Opt in per client
 * or per call with `retry: { attempts: 3 }`; the curve, the ceiling and the jitter are then
 * `backoffDelay`'s, never a second table.
 */
export const DEFAULT_CLIENT_RETRY: RetryPolicy = {
  attempts: 1,
  base: 100,
  max: 2_000,
  jitter: 'full',
  curve: 'exponential',
};

/**
 * What a client may send again: a classification somebody DECLARED, plus a dispatch that produced
 * no response at all.
 *
 * The default is the OPPOSITE of `retryDecision`'s, one file over, and that is the point.
 * `retry.ts` sends a throw nobody classified again until the attempts run out — which for a
 * client means a caller's own `AbortError` and a `TypeError` out of a mapper both get retried.
 * `@ultimat3/ai` and `@ultimat3/db` each refused that executor outright over it; this predicate
 * keeps the executor and inverts the default instead, and is a parameter (`transient`) so an app
 * can do neither.
 */
export function isTransientFailure(error: unknown): boolean {
  const declared = classifyThrown(error);
  if (declared !== undefined) return declared !== 'terminal';
  return isNetworkRejection(error);
}

/**
 * A dispatch that never produced a response. `fetch` rejects with a plain `TypeError` when the
 * network is down, DNS fails or the connection drops mid-body — the one unclassified throw a
 * client must send again. An abort is excluded because it is somebody's DECISION, not a failure:
 * matched on `name` rather than `instanceof DOMException`, which is not constructible in every
 * runtime this bundles into.
 */
function isNetworkRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  return error.name === 'TypeError';
}

export interface FlightKeyOptions {
  readonly signal?: AbortSignal | undefined;
  /** `true` refuses to join a dispatch that left before this call did. */
  readonly fresh?: boolean | undefined;
}

export interface FlightPlan<T> {
  /** The dedup key, or `undefined` for a call that may not share one. A mutation is always `undefined`. */
  readonly key: string | undefined;
  /** Whether `bump()` and the deadline may ABORT this work. A read yes; a write never. */
  readonly abortable: boolean;
  /** One attempt. `signal` is the flight's own — a caller's signal never reaches here. */
  run(signal: AbortSignal | undefined, attempt: number): Promise<T>;
  /** Overrides the flight's policy for this one call. */
  readonly retry?: ClientRetry | undefined;
}

export interface ClientFlightOptions {
  /**
   * Who is asking, folded into every dedup key. Dedup is OFF without it, and that is enforced by
   * `keyFor` answering `undefined`: a key that is only the URL lets one caller join another's
   * still-open read across a sign-in, a tenant switch or an impersonation.
   */
  readonly principal?: (() => string) | undefined;
  readonly retry?: ClientRetry | undefined;
  /**
   * One wall-clock budget with three readers: the retry loop's `timeBudgetMs`, the abort that ends
   * an abortable dispatch, and the eviction that frees a wedged dedup key. A NON-abortable plan —
   * a write — is never aborted by it; it only stops being retried.
   */
  readonly deadlineMs?: number | undefined;
  /** A ceiling on calls in flight. Past the queue the answer is `X_FLIGHT_GATE_OVERLOADED`. */
  readonly limit?: FlightGateLimits | undefined;
  /** What the fence counts and what the gate names when it refuses. */
  readonly subject?: string | undefined;
  readonly transient?: ((error: unknown) => boolean) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly schedule?: Scheduler | undefined;
  readonly random?: Random | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ClientFlight {
  /** The generation work started NOW is issued at. */
  generation(): number;
  /** Everything issued before this call is superseded, and every abortable call is aborted. */
  bump(): number;
  /** The dedup key for one URL, or `undefined` when this call may not share a dispatch. */
  keyFor(url: string, options?: FlightKeyOptions): string | undefined;
  run<T>(plan: FlightPlan<T>): Promise<T>;
  /** Dispatches holding a dedup key right now. A number that does not fall back to 0 is a leak. */
  readonly inflight: number;
  readonly active: number;
  readonly queued: number;
}

/** Ends the retry loop by RESOLVING. Compared by identity and never observable to a caller. */
const STOPPED: unique symbol = Symbol('client-flight.stopped');

const defaultSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(timer);
  };
};

export function createClientFlight(options: ClientFlightOptions = {}): ClientFlight {
  const subject = options.subject ?? 'a typed client call';
  const fence = createFence(subject);
  const schedule = options.schedule ?? defaultSchedule;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((done) => {
        schedule(done, ms);
      }));
  const transient = options.transient ?? isTransientFailure;
  const deadlineMs = options.deadlineMs;
  const flights = createSingleFlight({ deadlineMs, schedule });
  const gate: FlightGate | undefined =
    options.limit === undefined ? undefined : createFlightGate(options.limit, { subject });
  const live = new Set<AbortController>();

  const attempt = async <T>(plan: FlightPlan<T>, signal: AbortSignal | undefined): Promise<T> => {
    const policy: RetryPolicy = {
      ...DEFAULT_CLIENT_RETRY,
      ...options.retry,
      ...plan.retry,
      ...(deadlineMs === undefined ? {} : { timeBudgetMs: deadlineMs }),
    };
    // A non-transient failure ends the loop by RESOLVING to a sentinel rather than by throwing:
    // core's `retryDecision` retries anything nobody classified, so a throw would send an abort
    // and a foreign `TypeError` again. The original value is rethrown below, unwrapped — wrapping
    // it would replace a code, a cause and a runnable `fix:` with the fact that something retried.
    let stopped: { readonly error: unknown } | undefined;
    const answer = await retry<T | typeof STOPPED>(
      async (count) => {
        try {
          return await plan.run(signal, count);
        } catch (error) {
          if (transient(error)) throw error;
          stopped = { error };
          return STOPPED;
        }
      },
      policy,
      {
        sleep,
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    if (stopped !== undefined) throw stopped.error;
    return answer as T;
  };

  const dispatch = async <T>(plan: FlightPlan<T>): Promise<T> => {
    const controller = plan.abortable ? new AbortController() : undefined;
    let expired: number | undefined;
    const cancel =
      controller === undefined || deadlineMs === undefined
        ? undefined
        : schedule(() => {
            expired = deadlineMs;
            controller.abort();
          }, deadlineMs);
    if (controller !== undefined) live.add(controller);
    try {
      return await attempt(plan, controller?.signal);
    } catch (error) {
      // Raised here rather than at the caller, so every joiner of a deduped read is told the same
      // thing: the leader's abort reaches them as a bare `AbortError` otherwise.
      if (expired !== undefined) throw deadlineExpired(subject, expired);
      throw error;
    } finally {
      cancel?.();
      if (controller !== undefined) live.delete(controller);
    }
  };

  const settle = async <T>(shared: Promise<T>, issued: number): Promise<T> => {
    try {
      const value = await shared;
      fence.guard(issued);
      return value;
    } catch (error) {
      // The guard runs on the failure path too: a bump supersedes a call's refusal exactly as
      // much as its answer, and a caller that cannot tell the two apart retries a request its own
      // context has already replaced.
      fence.guard(issued);
      throw error;
    }
  };

  return {
    generation: (): number => fence.generation(),

    bump: (): number => {
      const next = fence.bump();
      // Abortable plans only: `live` never holds a write's controller, because closing a
      // mutation's socket does not un-commit it — it only destroys this caller's one chance of
      // learning whether it landed.
      const aborting = [...live];
      live.clear();
      for (const controller of aborting) controller.abort();
      return next;
    },

    keyFor: (url: string, keyOptions?: FlightKeyOptions): string | undefined => {
      if (options.principal === undefined) return undefined;
      // A caller's own signal disqualifies the call from sharing, in ONE line rather than by
      // refcounting joiners: the leader owns the request, so one caller's abort would cancel every
      // other caller's read. The cost is that an explicitly cancellable call does its own dispatch.
      if (keyOptions?.signal !== undefined) return undefined;
      if (keyOptions?.fresh === true) return undefined;
      // JSON, never a joined string — a principal is app data and may carry the separator, the
      // reason `@ultimat3/entity`'s `scopeKey` gives for the same shape.
      return JSON.stringify([options.principal(), url]);
    },

    run<T>(plan: FlightPlan<T>): Promise<T> {
      const issued = fence.generation();
      const work = (): Promise<T> =>
        gate === undefined ? dispatch(plan) : gate.run(() => dispatch(plan));
      // The single flight sits OUTSIDE the gate: a joiner takes no slot, so dedup relieves the
      // ceiling instead of queueing behind it.
      return settle(plan.key === undefined ? work() : flights.run(plan.key, work), issued);
    },

    get inflight(): number {
      return flights.size;
    },
    get active(): number {
      return gate?.active ?? 0;
    },
    get queued(): number {
      return gate?.queued ?? 0;
    },
  };
}

/**
 * `X_TIMEOUT`, never a code of the calling package's: the deadline is the framework's own
 * vocabulary for "nothing was wrong, the budget ran out", and it is already classified `retryable`
 * in `error-retry.ts`, so a caller's own retry loop reads the right answer off `error.retry` with
 * no table to consult.
 */
function deadlineExpired(subject: string, deadlineMs: number): UltimateError {
  return new UltimateError({
    code: 'X_TIMEOUT',
    cause: `${subject} was aborted after its client deadline of ${deadlineMs}ms`,
    fix: 'raise deadlineMs at the createClientFlight({ deadlineMs }) call site, or find what is answering that slowly with x doctor --json',
    meta: { subject, deadlineMs },
  });
}
