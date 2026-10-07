// Single responsibility: how many of one kind of work may run at once, and how many callers may
// wait. THREE bounded pools shipped before this one — `@ultimat3/auth`'s kdf gate, `@ultimat3/ai`'s
// hive pool, `@ultimat3/http`'s `maxInflight` — and only the first refuses past its queue. This
// header counted `@ultimat3/scraping`'s pacer as a fourth until 2026-08-23 and it is not one: a
// pacer bounds how OFTEN work starts, not how many run at once, so ten concurrent navigations all
// proceed merely staggered — no `maxConcurrent`, no queue bound, no refusal. Past the bound the
// answer here is a refusal, never a longer queue: an unbounded queue converts a load spike into a
// memory fault and answers it minutes late.

import { UltimateError } from './errors';
import { finiteCount } from './finite-option';

export interface FlightGateLimits {
  /** Work running at once. */
  readonly maxConcurrent: number;
  /** Callers allowed to WAIT for a slot. Past this the answer is a refusal, not a longer queue. */
  readonly maxQueued: number;
}

export interface FlightGateState extends FlightGateLimits {
  readonly active: number;
  readonly queued: number;
  readonly subject: string;
}

export interface FlightGateOptions {
  /** What is bounded, for the refusal's `cause`. */
  readonly subject?: string | undefined;
  /**
   * The refusal to raise instead of `X_FLIGHT_GATE_OVERLOADED`. The seam that lets a package keep
   * its own shipped code while delegating the mechanism — `@ultimat3/auth`'s `kdfOverloaded` is
   * `X_OVERLOADED` and a client already reads it as a 503.
   */
  readonly overflow?: ((state: FlightGateState) => UltimateError) | undefined;
}

export interface FlightGate {
  /**
   * `signal` makes a QUEUED wait cancellable: on abort the waiter leaves the queue and the call
   * rejects with the abort's reason. Once a slot is handed over the work runs; the signal is then
   * the work's own business.
   */
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Running right now. */
  readonly active: number;
  /** Waiting for a slot right now. A count that does not fall back to 0 is a leak. */
  readonly queued: number;
}

/**
 * A slot is HANDED OVER on release rather than released and re-acquired: decrementing first would
 * let a caller arriving in the same tick past the ceiling while a waiter's continuation is still a
 * queued microtask, which is how a "bounded" pool goes over its bound under exactly the load it
 * exists for. `@ultimat3/auth`'s `boundedKdfGate` states the same rule; this is that function with
 * the refusal made injectable.
 */
export function flightGate(limits: FlightGateLimits, options?: FlightGateOptions): FlightGate {
  const subject = options?.subject ?? 'in-flight work';
  // Refused at CONSTRUCTION, because this pair wedges rather than fails: `active < NaN` and
  // `waiters.length >= NaN` are both false, so every caller parks in a queue with no bound. Zero
  // is a real value at both — "never wait" and, at the width, "refuse everything".
  const maxConcurrent = finiteCount(
    `flightGate (${subject})`,
    'maxConcurrent',
    limits.maxConcurrent,
  );
  const maxQueued = finiteCount(`flightGate (${subject})`, 'maxQueued', limits.maxQueued);
  const waiters: Array<() => void> = [];
  let active = 0;

  const state = (): FlightGateState => ({
    maxConcurrent,
    maxQueued,
    active,
    queued: waiters.length,
    subject,
  });

  const acquire = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted === true) throw signal.reason;
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    // A width of zero has no slot to hand over, so a waiter would never be resumed: the queue is
    // for work that WILL run, and here none will.
    if (maxConcurrent === 0 || waiters.length >= maxQueued) {
      const current = state();
      throw options?.overflow?.(current) ?? gateOverloaded(current);
    }
    // A waiter that only stored its resolver could not be taken back: a superseded or abandoned
    // call stayed pending and kept its queue place until a slot reached it. The abort removes it.
    await new Promise<void>((resume, refuse) => {
      const onAbort = (): void => {
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        refuse(signal?.reason);
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resume();
      };
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next === undefined) active -= 1;
    else next();
  };

  return {
    get active(): number {
      return active;
    },
    get queued(): number {
      return waiters.length;
    },
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

/**
 * `retryAfterSeconds: 1` is the same value and the same field `@ultimat3/auth`'s `kdfOverloaded`
 * carries — `@ultimat3/http`'s `retryAfterOf` reads exactly this key onto the `Retry-After`
 * header, so a gate refusal and a rate limit answer a client the same way. One second, because a
 * gate at its ceiling clears in the time one unit of work takes, not in a minute.
 */
export function gateOverloaded(state: FlightGateState): UltimateError {
  return new UltimateError({
    code: 'X_FLIGHT_GATE_OVERLOADED',
    cause: `${state.active} of ${state.subject} are running at the ceiling of ${state.maxConcurrent} and ${state.queued} more are queued at the limit of ${state.maxQueued}`,
    fix: 'retry after the Retry-After header, or widen the ceiling at the flightGate({ maxConcurrent, maxQueued }) call site — only if the box has the capacity the extra slots buy',
    meta: {
      active: state.active,
      queued: state.queued,
      maxConcurrent: state.maxConcurrent,
      maxQueued: state.maxQueued,
      subject: state.subject,
      retryAfterSeconds: 1,
    },
  });
}
