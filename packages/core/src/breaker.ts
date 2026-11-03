// Single responsibility: the circuit breaker's state machine, and nothing about what counts as a
// failure — the TRIGGER is the caller's (`classify`, or `failed()` called by hand). Four apps wrote
// this machine and disagreed only on the trigger; `@ultimat3/db`'s replica router held a private
// copy. Per process, by design: a shared row would make the breaker depend on the slow thing.

import type { Clock } from './clock';
import { systemClock } from './clock';
import { declaredErrorRetry, registerErrorRetry } from './error-retry';
import { isUltimateError, UltimateError } from './errors';
import { finiteCount } from './finite-option';
import { recordBreakerTransition } from './runtime-metrics';

// Here, not in `error-retry.ts`'s core table, which rides every browser page: a breaker is server
// work. Open names the time left in `retryAfterSeconds`, the flight gate's spelling.
registerErrorRetry({ X_BREAKER_OPEN: 'retry-after' });

export type BreakerState = 'closed' | 'open' | 'half-open';

/** What one settled call says about the dependency. `ignore` says nothing: a caller's abort. */
export type BreakerVerdict = 'failure' | 'success' | 'ignore';

export interface BreakerOptions {
  /** A bounded label chosen in code (`'resend'`, `'replica'`) — never a tenant or a URL. */
  readonly name: string;
  /** Consecutive failures that open it. */
  readonly failures: number;
  /** How long it stays open before one probe is let through, in ms. */
  readonly cooldownMs: number;
  /** The trigger. Default: `defaultBreakerClassify`. */
  readonly classify?: ((error: unknown) => BreakerVerdict) | undefined;
  /** Monotonic time only: a wall-clock step must not close a breaker. */
  readonly clock?: Pick<Clock, 'monotonic'> | undefined;
}

/**
 * One admission. The breaker settles the half-open probe only through ITS ticket, so a call
 * admitted before the trip — aborting, failing or answering late — never frees or closes it.
 */
export interface BreakerTicket {
  /** Whether this admission is the half-open probe. */
  readonly probe: boolean;
}

export interface Breaker {
  readonly name: string;
  /** May a call go out now: its ticket, or `undefined`. In `half-open` the one ticket IS the probe. */
  admit(): BreakerTicket | undefined;
  /** The dependency answered. In `half-open` only the probe's ticket closes it; `open` ignores it. */
  succeeded(ticket?: BreakerTicket): void;
  failed(ticket?: BreakerTicket): void;
  /** The call ended for a reason that says nothing: the probe's ticket gives the probe back. */
  released(ticket?: BreakerTicket): void;
  /** Read-only: never consumes a probe. `half-open` once the cooldown has passed. */
  state(): BreakerState;
  /** The current run of consecutive failures. */
  failures(): number;
  /** This breaker's `classify`, the default applied when none was given. */
  judge(error: unknown): BreakerVerdict;
  /** `X_BREAKER_OPEN` with the time left, for a caller that refuses without `run`. */
  refusal(): UltimateError;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Retryable means the dependency did not answer: a failure. A caller going away is no statement
 * about the dependency (`X_ABORTED`, `X_DRAINING`, checked first: the second is retryable). Any
 * other outcome is an answer, refusals included — a 400 is a vendor that is up.
 */
export function defaultBreakerClassify(error: unknown): BreakerVerdict {
  if (!isUltimateError(error)) return 'success';
  if (error.code === 'X_ABORTED' || error.code === 'X_DRAINING') return 'ignore';
  const retry = declaredErrorRetry(error.code);
  return retry === 'retryable' || retry === 'retry-after' ? 'failure' : 'success';
}

export function breakerOpen(name: string, retryAfterSeconds: number): UltimateError {
  return new UltimateError({
    code: 'X_BREAKER_OPEN',
    cause: `the breaker "${name}" is open after consecutive failures, so this call was not sent`,
    fix: `breaker({ name: '${name}', failures, cooldownMs })   # raise failures if this outage is not one; else wait ${String(retryAfterSeconds)} s and check the dependency "${name}" names`,
    meta: { name, retryAfterSeconds },
  });
}

export function breaker(options: BreakerOptions): Breaker {
  const limit = finiteCount('breaker()', 'failures', options.failures, 1);
  const cooldownMs = finiteCount('breaker()', 'cooldownMs', options.cooldownMs, 1);
  const clock = options.clock ?? systemClock;
  const classify = options.classify ?? defaultBreakerClassify;
  let current: BreakerState = 'closed';
  let count = 0;
  /** When it opened (`open`) or when the probe went out (`half-open`). */
  let since = 0;

  const move = (to: BreakerState): void => {
    if (current === to) return;
    current = to;
    recordBreakerTransition(options.name, to);
  };
  const lapsed = (): boolean => clock.monotonic() - since >= cooldownMs;

  const CLOSED_TICKET: BreakerTicket = Object.freeze({ probe: false });
  /** The outstanding probe's ticket, compared by identity. */
  let probe: BreakerTicket | undefined;
  const isProbe = (ticket: BreakerTicket | undefined): boolean =>
    ticket !== undefined && ticket === probe;

  const self: Breaker = {
    name: options.name,
    admit() {
      if (current === 'closed') return CLOSED_TICKET;
      if (current === 'open' && !lapsed()) return undefined;
      // Past an open cooldown, or a probe that never settled: its holder may be dead.
      if (current === 'half-open' && probe !== undefined && !lapsed()) return undefined;
      move('half-open');
      probe = { probe: true };
      since = clock.monotonic();
      return probe;
    },
    succeeded(ticket) {
      // A late answer from a call admitted BEFORE the trip proves nothing about now: only a
      // closed breaker or the half-open probe's own ticket may close it.
      if (current === 'open' || (current === 'half-open' && !isProbe(ticket))) return;
      count = 0;
      probe = undefined;
      move('closed');
    },
    failed(ticket) {
      count += 1;
      if (current === 'half-open' && isProbe(ticket)) {
        probe = undefined;
        since = clock.monotonic();
        move('open');
      } else if (current === 'closed' && count >= limit) {
        since = clock.monotonic();
        move('open');
      }
    },
    released(ticket) {
      if (isProbe(ticket)) probe = undefined;
    },
    state() {
      return current === 'open' && lapsed() ? 'half-open' : current;
    },
    failures: () => count,
    judge: (error) => classify(error),
    refusal() {
      const leftMs = Math.max(0, cooldownMs - (clock.monotonic() - since));
      return breakerOpen(options.name, Math.max(1, Math.ceil(leftMs / 1_000)));
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const ticket = self.admit();
      if (ticket === undefined) throw self.refusal();
      let value: T;
      try {
        value = await fn();
      } catch (error) {
        settleWith(self, self.judge(error), ticket);
        throw error;
      }
      self.succeeded(ticket);
      return value;
    },
  };
  return self;
}

/** Record one verdict. Exported for a caller that classifies itself (`outbound()`). */
export function settleWith(
  gate: Breaker,
  verdict: BreakerVerdict,
  ticket: BreakerTicket | undefined,
): void {
  if (verdict === 'failure') gate.failed(ticket);
  else if (verdict === 'success') gate.succeeded(ticket);
  else gate.released(ticket);
}
