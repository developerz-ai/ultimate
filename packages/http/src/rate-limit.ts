// Token-bucket rate limiting. The store is an interface so the same limiter runs
// in-memory in dev/tests and against Redis/Postgres in a multi-replica deployment;
// the bucket maths lives here so every driver agrees on the numbers.
import { rateLimited } from './errors';

export interface Bucket {
  /** Burst size. */
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  take(key: string, bucket: Bucket, cost: number, nowMs: number): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
}

export interface RateLimitConfig {
  readonly enabled: boolean;
  /** Named buckets; a route selects one via `meta.rateLimit`. `default` is required. */
  readonly buckets: Readonly<Record<string, Bucket>>;
  readonly defaultBucket: string;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  defaultBucket: 'default',
  buckets: {
    default: { capacity: 120, refillPerSecond: 2 },
    // Login/signup style endpoints: slow, no burst.
    auth: { capacity: 10, refillPerSecond: 0.2 },
    mutation: { capacity: 30, refillPerSecond: 1 },
  },
};

interface BucketState {
  tokens: number;
  lastMs: number;
}

const decide = (
  state: BucketState,
  bucket: Bucket,
  cost: number,
  nowMs: number,
): RateLimitDecision => {
  const elapsedSeconds = Math.max(0, (nowMs - state.lastMs) / 1000);
  const tokens = Math.min(bucket.capacity, state.tokens + elapsedSeconds * bucket.refillPerSecond);
  state.lastMs = nowMs;
  const allowed = tokens >= cost;
  state.tokens = allowed ? tokens - cost : tokens;
  const deficit = allowed ? bucket.capacity - state.tokens : cost - state.tokens;
  // A bucket that never refills would give an infinite reset; clamp to a day so the
  // Retry-After header stays a number a client can act on.
  const secondsToRefill =
    bucket.refillPerSecond > 0 ? Math.min(86_400, deficit / bucket.refillPerSecond) : 86_400;
  return {
    allowed,
    limit: bucket.capacity,
    remaining: Math.floor(state.tokens),
    resetAtMs: nowMs + Math.ceil(secondsToRefill * 1000),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(secondsToRefill)),
  };
};

/** Default driver: correct for one process, which is exactly dev and tests. */
export const memoryRateLimitStore = (): RateLimitStore => {
  const buckets = new Map<string, BucketState>();
  return {
    take(key, bucket, cost, nowMs) {
      const state = buckets.get(key) ?? { tokens: bucket.capacity, lastMs: nowMs };
      buckets.set(key, state);
      return Promise.resolve(decide(state, bucket, cost, nowMs));
    },
    reset(key) {
      buckets.delete(key);
      return Promise.resolve();
    },
  };
};

export interface RateLimitKeyParts {
  readonly actorId: string | null;
  readonly orgId: string | null;
  readonly ip: string | null;
  readonly routeName: string;
}

/**
 * Key precedence: actor > org > ip. An authenticated actor gets its own bucket so
 * one noisy user cannot exhaust a whole tenant's allowance, and an anonymous
 * request falls back to the connection address.
 */
export const rateLimitKey = (parts: RateLimitKeyParts): string => {
  const subject =
    parts.actorId !== null
      ? `actor:${parts.actorId}`
      : parts.orgId !== null
        ? `org:${parts.orgId}`
        : `ip:${parts.ip ?? 'unknown'}`;
  return `${parts.routeName}|${subject}`;
};

export interface RateLimiter {
  check(key: string, bucketName: string, cost?: number): Promise<RateLimitDecision>;
  headers(decision: RateLimitDecision): Record<string, string>;
  /** Throws `X_RATE_LIMITED` when the bucket is empty. */
  assert(key: string, bucketName: string, cost?: number): Promise<RateLimitDecision>;
}

export const createRateLimiter = (options: {
  config: RateLimitConfig;
  store?: RateLimitStore;
  now?: () => number;
}): RateLimiter => {
  const store = options.store ?? memoryRateLimitStore();
  const now = options.now ?? (() => Date.now());
  const bucketFor = (name: string): Bucket =>
    options.config.buckets[name] ??
    options.config.buckets[options.config.defaultBucket] ??
    DEFAULT_RATE_LIMIT.buckets['default'] ?? { capacity: 60, refillPerSecond: 1 };

  const check: RateLimiter['check'] = (key, bucketName, cost = 1) =>
    store.take(key, bucketFor(bucketName), cost, now());

  return {
    check,
    headers: (decision) => ({
      'ratelimit-limit': String(decision.limit),
      'ratelimit-remaining': String(decision.remaining),
      'ratelimit-reset': String(Math.ceil((decision.resetAtMs - now()) / 1000)),
    }),
    async assert(key, bucketName, cost = 1) {
      const decision = await check(key, bucketName, cost);
      if (!decision.allowed) throw rateLimited(key, decision.retryAfterSeconds);
      return decision;
    },
  };
};
