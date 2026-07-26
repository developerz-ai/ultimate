// Single responsibility: throttling and lockout for credential paths, plus the one generic
// failure every login path must throw. Two independent buckets — per IP (stops a spray across
// many accounts) and per account (stops a spray against one) — because either alone is
// bypassable. `loginFailed()` lives here so the throttle and the message can never drift apart.

import type { Clock } from '@ultimat3/core';
import { AuthError, accountLocked } from './errors';

export interface AuthRateLimitPolicy {
  /** Failures inside `windowMs` before the key is locked. */
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitPolicy = Object.freeze({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
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

export const accountKey = (email: string): string => `account:${email.trim().toLowerCase()}`;

export const ipKey = (ip: string): string => `ip:${ip}`;

interface Bucket {
  failures: number[];
  lockedUntilMs: number;
}

/**
 * Sliding window over an injected `Clock` — never `Date.now()`, so a lockout test is
 * deterministic instead of a sleep. In-memory per process; a multi-process deployment passes
 * a shared implementation of the same interface.
 */
export function createAuthLimiter(
  clock: Clock,
  policy: AuthRateLimitPolicy = DEFAULT_AUTH_RATE_LIMIT,
): AuthLimiter {
  const buckets = new Map<string, Bucket>();

  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing !== undefined) return existing;
    const fresh: Bucket = { failures: [], lockedUntilMs: 0 };
    buckets.set(key, fresh);
    return fresh;
  };

  return {
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
    cause: 'the email and password combination did not match an account',
    fix: 'check the address and password, or reset it at POST /auth/password/reset',
  });
}
