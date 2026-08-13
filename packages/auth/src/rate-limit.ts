// Single responsibility: throttling and lockout for credential paths, plus the one generic
// failure every login path must throw. Two independent buckets — per IP (stops a spray across
// many accounts) and per account (stops a spray against one) — because either alone is
// bypassable. `loginFailed()` lives here so the throttle and the message can never drift apart.

import type { Clock } from '@ultimat3/core';
import { AuthError, accountLocked } from './errors';

/**
 * Hard bound on tracked keys. A key is one identity — `account:<email>` or `ip:<addr>` — so the
 * natural cardinality is lower than `@ultimat3/http`'s per-route buckets, and so is the cap.
 */
export const DEFAULT_MAX_AUTH_LIMIT_KEYS = 10_000;

export interface AuthRateLimitPolicy {
  /** Failures inside `windowMs` before the key is locked. */
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
  /** Bound on the in-memory table. Defaults to `DEFAULT_MAX_AUTH_LIMIT_KEYS`. */
  readonly maxKeys?: number | undefined;
}

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitPolicy = Object.freeze({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
  maxKeys: DEFAULT_MAX_AUTH_LIMIT_KEYS,
});

export interface AuthLimiter {
  /** Throws `X_ACCOUNT_LOCKED` if the key is inside a lockout. Call before any KDF work. */
  assertAllowed(key: string): void;
  recordFailure(key: string): void;
  /** A success clears the window: a legitimate user is not punished for a typo yesterday. */
  recordSuccess(key: string): void;
  lockedUntil(key: string): Date | null;
  reset(): void;
}

/** What `createAuthLimiter` returns: the interface, plus the bound it keeps, observable. */
export interface MemoryAuthLimiter extends AuthLimiter {
  readonly size: number;
}

export const accountKey = (email: string): string => `account:${email.trim().toLowerCase()}`;

export const ipKey = (ip: string): string => `ip:${ip}`;

interface Bucket {
  failures: number[];
  lockedUntilMs: number;
  /**
   * The instant this entry becomes indistinguishable from a missing one: the window has emptied
   * and any lockout has expired, so it answers exactly as a first-ever attempt does.
   */
  forgetAtMs: number;
}

/** An idle limiter still sweeps this often, so one spray's state does not sit until the next. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Sliding window over an injected `Clock` — never `Date.now()`, so a lockout test is
 * deterministic instead of a sleep. In-memory per process; a multi-process deployment passes
 * a shared implementation of the same interface.
 *
 * Bounded, because half the keys are attacker-chosen: `ipKey` mints one per source address, so
 * a spray from an IPv6 /64 is a fresh key per attempt and an unbounded map is an OOM. Two rules
 * keep it flat. An entry whose window has emptied and whose lockout has expired is *forgotten*,
 * not evicted — it answers exactly as a missing one, so dropping it changes no decision. Only if
 * that is not enough does the cap evict live state, and then the entries nearest to being
 * forgotten anyway go first: a locked account is the last key to go, so filling the table is not
 * a way to buy back attempts against one.
 */
export function createAuthLimiter(
  clock: Clock,
  policy: AuthRateLimitPolicy = DEFAULT_AUTH_RATE_LIMIT,
): MemoryAuthLimiter {
  const buckets = new Map<string, Bucket>();
  const maxKeys = Math.max(1, Math.floor(policy.maxKeys ?? DEFAULT_MAX_AUTH_LIMIT_KEYS));
  const evictTo = Math.max(1, Math.floor(maxKeys * 0.9));
  let lastSweepMs = Number.NEGATIVE_INFINITY;

  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing !== undefined) return existing;
    const fresh: Bucket = { failures: [], lockedUntilMs: 0, forgetAtMs: 0 };
    buckets.set(key, fresh);
    return fresh;
  };

  const sweep = (nowMs: number): void => {
    lastSweepMs = nowMs;
    for (const [key, bucket] of buckets) {
      if (bucket.forgetAtMs <= nowMs) buckets.delete(key);
    }
    if (buckets.size <= maxKeys) return;
    // Batched down to `evictTo` so this sort is paid once per 10% of the cap, not per failure.
    // A live lockout outranks its deadline: two entries recorded a second apart are otherwise
    // ordered by recency, which would let a spray evict the account it just locked.
    const locked = (bucket: Bucket): number => (bucket.lockedUntilMs > nowMs ? 1 : 0);
    const nearestForgotten = [...buckets.entries()].sort(
      (a, b) => locked(a[1]) - locked(b[1]) || a[1].forgetAtMs - b[1].forgetAtMs,
    );
    for (const [key] of nearestForgotten) {
      if (buckets.size <= evictTo) break;
      buckets.delete(key);
    }
  };

  return {
    get size() {
      return buckets.size;
    },
    assertAllowed(key) {
      const bucket = buckets.get(key);
      if (bucket === undefined) return;
      const nowMs = clock.now().getTime();
      if (bucket.lockedUntilMs <= nowMs) return;
      throw accountLocked(key, Math.ceil((bucket.lockedUntilMs - nowMs) / 1000));
    },
    recordFailure(key) {
      const nowMs = clock.now().getTime();
      const bucket = bucketFor(key);
      bucket.failures = bucket.failures.filter((at) => at > nowMs - policy.windowMs);
      bucket.failures.push(nowMs);
      if (bucket.failures.length >= policy.maxAttempts) {
        bucket.lockedUntilMs = nowMs + policy.lockoutMs;
      }
      // The newest failure leaves the window last, so that is the earliest this entry is free —
      // unless a lockout outlives it. Recorded here because this is the only growth path.
      bucket.forgetAtMs = Math.max(bucket.lockedUntilMs, nowMs + policy.windowMs);
      if (buckets.size > maxKeys || nowMs - lastSweepMs >= SWEEP_EVERY_MS) sweep(nowMs);
    },
    recordSuccess(key) {
      buckets.delete(key);
    },
    lockedUntil(key) {
      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.lockedUntilMs <= clock.now().getTime()) return null;
      return new Date(bucket.lockedUntilMs);
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * The single generic failure. Every credential path — unknown email, wrong password, disabled
 * account, unverified address — throws exactly this object shape, so the rendered error is
 * byte-identical and account existence is unobservable. Do not add a parameter to it.
 */
export function loginFailed(): AuthError {
  return new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause:
      'the email and password combination did not match an account — re-enter them before ' +
      'issuing the reset below, which mails a single-use token',
    fix: "issueVerification(runtime, { purpose: 'password-reset', identifier: email, locale })",
  });
}
