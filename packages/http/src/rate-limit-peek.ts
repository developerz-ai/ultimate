// The READ half of a token bucket: what a key holds now, refill applied, with nothing written.
// Split from `rate-limit.ts` at the size ceiling; every `RateLimitStore.peek` answers through it.

import type { Bucket } from './rate-limit';

/** A read of a bucket: whole tokens left, and how long until one more is there when none is. */
export interface RateLimitPeek {
  readonly remaining: number;
  /** `0` while a whole token is left; otherwise the seconds until one is, at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * The peek every store answers from the tokens it computed — exported for the reason
 * `rateLimitDecision` is: two drivers deriving "when may I come back" separately is two answers.
 * A bucket that never refills is clamped to a day, as a decision's `Retry-After` is.
 */
export const rateLimitPeek = (bucket: Bucket, tokens: number): RateLimitPeek => {
  if (tokens >= 1) return { remaining: Math.floor(tokens), retryAfterSeconds: 0 };
  const seconds =
    bucket.refillPerSecond > 0 ? Math.min(86_400, (1 - tokens) / bucket.refillPerSecond) : 86_400;
  return { remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
};

/** `stored` tokens last written at `lastMs`, refilled to `nowMs` and capped — no mutation. */
export const refilledTokens = (
  bucket: Bucket,
  stored: number,
  lastMs: number,
  nowMs: number,
): number =>
  Math.min(bucket.capacity, stored + (Math.max(0, nowMs - lastMs) / 1000) * bucket.refillPerSecond);
