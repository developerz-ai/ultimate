// Single responsibility: how many of one kind of work may run at once, and how many callers may
// wait. THREE bounded pools shipped before this one — `@ultimat3/auth`'s kdf gate, `@ultimat3/ai`'s
// hive pool, `@ultimat3/http`'s `maxInflight` — and only the first refuses past its queue. This
// header counted `@ultimat3/scraping`'s pacer as a fourth until 2026-08-23 and it is not one: a
// pacer bounds how OFTEN work starts, not how many run at once, so ten concurrent navigations all
// proceed merely staggered — no `maxConcurrent`, no queue bound, no refusal. Past the bound the
// answer here is a refusal, never a longer queue: an unbounded queue converts a load spike into a
// memory fault and answers it minutes late.

import { UltimateError } from './errors';

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
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Running right now. */
  readonly active: number;
  /** Waiting for a slot right now. A count that does not fall back to 0 is a leak. */
  readonly queued: number;
}

/**
 * A slot is HANDED OVER on release rather than released and re-acquired: decrementing first would
 * let a caller arriving in the same tick past the ceiling while a waiter's continuation is still a
 * queued microtask, which is how a "bounded" pool goes over its bound under exactly the load it
 * exists for. `@ultimat3/auth`'s `createKdfGate` states the same rule; this is that function with
 * the refusal made injectable.
 */
export function createFlightGate(
  limits: FlightGateLimits,
  options?: FlightGateOptions,
): FlightGate {
  const subject = options?.subject ?? 'in-flight work';
  const waiters: Array<() => void> = [];
  let active = 0;

  const state = (): FlightGateState => ({
    maxConcurrent: limits.maxConcurrent,
    maxQueued: limits.maxQueued,
    active,
    queued: waiters.length,
    subject,
  });

  const acquire = async (): Promise<void> => {
    if (active < limits.maxConcurrent) {
      active += 1;
      return;
    }
    if (waiters.length >= limits.maxQueued) {
      const current = state();
      throw options?.overflow?.(current) ?? gateOverloaded(current);
    }
    await new Promise<void>((resume) => {
      waiters.push(resume);
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
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
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
    fix: 'retry after the Retry-After header, or widen the ceiling at the createFlightGate({ maxConcurrent, maxQueued }) call site — only if the box has the capacity the extra slots buy',
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
