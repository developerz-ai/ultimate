// Token-bucket rate limiting. The store is an interface so the same limiter runs in-memory in
// dev/tests and against a shared tier in a multi-replica deployment — installed through
// `createServer({ rateLimitStore })`, and refused at boot when its scope cannot keep the app's
// declaration; the bucket maths lives here so every driver agrees on the numbers.
import { rateLimited, rateLimitNotShared } from './errors';

/**
 * Where a limiter's counters live. A store says which it provides; `RateLimitConfig` says which
 * the deployment requires, and the two are checked against each other once, at boot.
 */
export type RateLimitScope = 'process' | 'shared';

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
  /** Declared, never inferred: a driver knows where its counters live; nothing else does. */
  readonly scope: RateLimitScope;
  take(key: string, bucket: Bucket, cost: number, nowMs: number): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
}

export interface RateLimitConfig {
  readonly enabled: boolean;
  /** Named buckets; a route selects one via `meta.rateLimit`. `default` is required. */
  readonly buckets: Readonly<Record<string, Bucket>>;
  readonly defaultBucket: string;
  /**
   * What this deployment requires of the store. `'shared'` says these numbers are the whole
   * fleet's allowance, and a per-process store then refuses to boot — because N replicas each
   * holding their own counters enforce N × every number here, silently and only in production.
   */
  readonly scope: RateLimitScope;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  defaultBucket: 'default',
  // One process is the only thing a framework can promise without being told; an app that runs
  // more than one says so, and brings the store that makes it true.
  scope: 'process',
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
  /**
   * The instant this entry becomes indistinguishable from a missing one: a bucket back at
   * capacity answers exactly as a first-ever request does. `Infinity` for a bucket that never
   * refills — only the cap can forget that one.
   */
  forgetAtMs: number;
}

const forgetAt = (state: BucketState, bucket: Bucket, nowMs: number): number => {
  const toFull = bucket.capacity - state.tokens;
  if (toFull <= 0) return nowMs;
  if (bucket.refillPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return nowMs + Math.ceil((toFull / bucket.refillPerSecond) * 1000);
};

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
  state.forgetAtMs = forgetAt(state, bucket, nowMs);
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

/**
 * Hard bound on tracked keys. A key is `route|subject`, so one subject throttled on N routes is
 * N entries — a higher natural cardinality than an identity table, which is why this cap is
 * larger than `@ultimat3/auth`'s. At ~200 bytes an entry that is a few megabytes, held.
 */
export const DEFAULT_MAX_RATE_LIMIT_KEYS = 20_000;

/** An idle store still sweeps this often, so a burst's state does not sit until the next one. */
const SWEEP_EVERY_MS = 60_000;

export interface MemoryRateLimitStore extends RateLimitStore {
  /** Entries tracked right now — the bound, observable. */
  readonly size: number;
}

/**
 * Default driver: correct for one process, which is exactly dev and tests.
 *
 * Bounded, because the key falls back to the connection address: a scan rotating through an
 * IPv6 /64 mints a fresh key per request, and an unbounded map turns that into an OOM. Two
 * rules keep it flat. A refilled bucket is *forgotten*, not evicted — it answers exactly as a
 * missing one, so dropping it costs nothing and a scanner's one-request buckets qualify within
 * a second. Only if that is not enough does the cap evict live state, and then the entries
 * closest to full go first: throwing away a spent bucket is what would hand the scanner a free
 * reset, so the most-throttled key is the last one to go.
 */
export const memoryRateLimitStore = (
  options: { readonly maxKeys?: number | undefined } = {},
): MemoryRateLimitStore => {
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? DEFAULT_MAX_RATE_LIMIT_KEYS));
  const evictTo = Math.max(1, Math.floor(maxKeys * 0.9));
  const buckets = new Map<string, BucketState>();
  let lastSweepMs = Number.NEGATIVE_INFINITY;

  const sweep = (nowMs: number): void => {
    lastSweepMs = nowMs;
    for (const [key, state] of buckets) {
      if (state.forgetAtMs <= nowMs) buckets.delete(key);
    }
    if (buckets.size <= maxKeys) return;
    // Batched down to `evictTo` so this sort is paid once per 10% of the cap, not per request.
    const nearestFull = [...buckets.entries()].sort((a, b) => a[1].forgetAtMs - b[1].forgetAtMs);
    for (const [key] of nearestFull) {
      if (buckets.size <= evictTo) break;
      buckets.delete(key);
    }
  };

  return {
    scope: 'process',
    get size() {
      return buckets.size;
    },
    take(key, bucket, cost, nowMs) {
      const state = buckets.get(key) ?? {
        tokens: bucket.capacity,
        lastMs: nowMs,
        forgetAtMs: nowMs,
      };
      buckets.set(key, state);
      const decision = decide(state, bucket, cost, nowMs);
      if (buckets.size > maxKeys || nowMs - lastSweepMs >= SWEEP_EVERY_MS) sweep(nowMs);
      return Promise.resolve(decision);
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
  /** The store's scope, carried up so the boot check has one thing to read. */
  readonly scope: RateLimitScope;
  /**
   * The table this limiter resolves a bucket NAME against. Declared, never inferred — the same
   * rule as `RateLimitStore.scope` and `@ultimat3/auth`'s `AuthLimiter.policy`, and for the same
   * reason: `createRateLimiter` closes over its config, so nothing outside can see which buckets
   * it actually holds. `createPipeline` compares this against the buckets the ROUTES declare, and
   * an unknown name is refused instead of falling through `bucketFor` to `default`.
   *
   * Optional only so an existing external implementation still type-checks; an absent table
   * cannot be checked, so it is refused exactly as a wrong one is.
   */
  readonly buckets?: Readonly<Record<string, Bucket>> | undefined;
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
    scope: store.scope,
    // Published, not private: this is the table `bucketFor` above reads, and the boot check has
    // no other way to learn what this limiter can enforce.
    buckets: options.config.buckets,
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

/**
 * Boot, never the first request. A per-node store under a `'shared'` declaration is a limit that
 * is quietly N × what the config says — the kind of wrong answer that only shows up as a flood
 * nobody was throttling, at the worst hour. A process that cannot enforce what it was configured
 * to enforce must not start; `enabled: false` is checked too, because a limit declared fleet-wide
 * and then switched off is the same claim with nothing behind it.
 */
export const assertRateLimitScope = (config: RateLimitConfig, limiter: RateLimiter): void => {
  if (config.scope !== 'shared') return;
  if (!config.enabled) throw rateLimitNotShared('disabled');
  if (limiter.scope !== 'shared') throw rateLimitNotShared('process');
};
