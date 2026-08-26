// Single responsibility: bounding how many argon2 hashes this process runs at once.
//
// WHY it is not covered by the limiters that already exist: `rate-limit.ts`'s `ipKey(ip)` and
// `@ultimat3/http`'s `auth` bucket are both keyed by SOURCE, so an attacker rotating an IPv6 /64
// mints a fresh key per attempt and is never throttled by either; and both cap ATTEMPTS, while
// what argon2id costs is MEMORY — 19 MiB per hash at the OWASP floor. The only remaining backstop
// was `http.maxInflight` (1000), i.e. roughly 19 GB of arenas queued on one box.

import { createFlightGate } from '@ultimat3/core';
import { kdfOverloaded } from './errors';
import { assertFiniteAuthCount } from './policy-numbers';

export interface KdfLimits {
  /** Hashes running at once. Multiply by `memoryCost` for the resident ceiling this buys. */
  readonly maxConcurrent: number;
  /** Callers allowed to WAIT for a slot. Past this the answer is a refusal, not a longer queue. */
  readonly maxQueued: number;
}

/**
 * 8 x 19 MiB is ~152 MiB resident, which fits the smallest box anyone runs a web role on, and 64
 * waiters is about two seconds of backlog at that width — long enough to absorb a burst of real
 * logins, short enough that a spray is refused while the process is still answering.
 */
export const DEFAULT_KDF_LIMITS: KdfLimits = Object.freeze({ maxConcurrent: 8, maxQueued: 64 });

export interface KdfGate {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The mechanism is `@ultimat3/core`'s — including the rule that made this file worth having: a
 * slot is HANDED OVER on release rather than released and re-acquired, because decrementing first
 * would let a caller arriving in the same tick past the ceiling while a waiter's continuation is
 * still a queued microtask.
 *
 * `overflow:` is why delegating costs this package nothing: the shed stays `kdfOverloaded`, so the
 * code an HTTP client already reads as a 503 is still `X_OVERLOADED` and core's own
 * `X_FLIGHT_GATE_OVERLOADED` never leaves this package. `subject:` is deliberately not passed —
 * it feeds only `gateOverloaded`'s prose, which this gate never reaches, and an option nothing
 * reads is the defect this repo keeps re-shipping.
 *
 * The declared return type stays `KdfGate` rather than core's `FlightGate`: `active` and `queued`
 * are observations no caller here has ever had, and widening a public signature is not a refactor.
 */
export function createKdfGate(limits: KdfLimits = DEFAULT_KDF_LIMITS): KdfGate {
  // Screened at the CONSTRUCTOR, because this pair WEDGES rather than fails: core asks
  // `active < maxConcurrent` and then `waiters.length >= maxQueued`, and both are false for `NaN`,
  // so every hash on the box parks in a queue with no bound and nothing to release it — login
  // stops answering instead of shedding.
  //
  // ZERO is legitimate at BOTH, which is why the minimum is 0 and not 1: `maxQueued: 0` means
  // "shed at the width, never wait", and `{ maxConcurrent: 0, maxQueued: 0 }` is a gate that
  // refuses every hash — `password.test.ts`'s way of proving the unreadable-hash path burns the
  // same KDF the other two failures do. Refusing zero here would have failed that test, which is
  // the deployment this screen must not break.
  assertFiniteAuthCount(
    'kdf.maxConcurrent',
    limits.maxConcurrent,
    '`active < NaN` is false, so no hash ever starts and every caller queues instead',
    0,
  );
  assertFiniteAuthCount(
    'kdf.maxQueued',
    limits.maxQueued,
    '`waiters.length >= NaN` is false, so the queue this gate exists to bound has no bound at all',
    0,
  );
  return createFlightGate(limits, {
    overflow: (state) => kdfOverloaded(state.active, state.queued),
  });
}

let gate = createKdfGate();

/** The process-wide gate every `hashPassword`/`verifyPassword` passes through. */
export const kdfGate = (): KdfGate => gate;

/**
 * The ONE install point, the same shape as `configureCursorSigning` in `@ultimat3/core`: a box
 * with more memory may widen the ceiling, and a test needs a narrow one. Not a `defineAuth` key,
 * because this is a property of the MACHINE, not of the app's auth policy — the same app config
 * runs on a 512 MiB PaaS dyno and a 64 GiB node.
 */
export function configureKdfGate(limits: KdfLimits): void {
  gate = createKdfGate(limits);
}

/** Back to the shipped defaults. Tests that call `configureKdfGate` must call this in cleanup. */
export function resetKdfGate(): void {
  gate = createKdfGate();
}
