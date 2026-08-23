// Token-bucket rate limiting. The store is an interface so the same limiter runs in-memory in
// dev/tests and against a shared tier in a multi-replica deployment — installed through
// `createServer({ rateLimitStore })`, and refused at boot when its scope cannot keep the app's
// declaration; the bucket maths lives here so every driver agrees on the numbers.
import { type Clock, systemClock } from '@ultimat3/core';
import {
  rateLimited,
  rateLimitInvalid,
  rateLimitNotShared,
  rateLimitScopeUnset,
} from './rate-limit-errors';

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

/**
 * Everything the framework can decide on its own. `scope` is NOT here: one process is the only
 * thing a framework can promise without being told, and defaulting to it made "we did not ask"
 * indistinguishable from "the app said one replica" — so the chart's `replicas: 3` enforced every
 * number three times over, silently, and the boot check that exists for this
 * (`assertRateLimitScope`) never fired because it only reads a `'shared'` declaration. The
 * comment that used to sit here was right about the fact and wrong about the conclusion: ask.
 */
export const DEFAULT_RATE_LIMIT: Omit<RateLimitConfig, 'scope'> = {
  enabled: true,
  defaultBucket: 'default',
  buckets: {
    default: { capacity: 120, refillPerSecond: 2 },
    // Login/signup style endpoints: slow, no burst.
    auth: { capacity: 10, refillPerSecond: 0.2 },
    mutation: { capacity: 30, refillPerSecond: 1 },
  },
};

/**
 * `defineHttpConfig`'s one resolver for this slice, so the refusal happens where an author can
 * act on it rather than at the first request. A limiter that is switched off has nothing to be
 * wrong about, so `enabled: false` needs no declaration — and reads as `'process'`.
 */
export const resolveRateLimitConfig = (
  input: Partial<RateLimitConfig> | undefined,
): RateLimitConfig => {
  const merged = { ...DEFAULT_RATE_LIMIT, ...input };
  if (input?.scope !== undefined) return { ...merged, scope: input.scope };
  if (!merged.enabled) return { ...merged, scope: 'process' };
  throw rateLimitScopeUnset();
};

/** How a route, an action or a query spells a limit before it becomes a `Bucket`. */
export interface RateLimitDeclaration {
  /** The burst a caller may spend at once. */
  readonly limit: number;
  /** The window that refills it. */
  readonly windowMs: number;
}

/**
 * `{ limit, windowMs }` as the limiter's own vocabulary: `5 / 600_000ms` is five held, one back
 * every two minutes. The only conversion between a declaration and the enforcement, so the
 * numbers an OpenAPI operation publishes and the numbers `withRouteBuckets` registers cannot
 * drift. It lives HERE, beside `Bucket` and the maths, because `@ultimat3/action` and
 * `@ultimat3/query` are the same tier and can never import each other — a copy in one of them is
 * a second answer to "what does this limit mean" for the other.
 *
 * **The COMPUTED rate is validated, not just the two declared halves.** The division is where a
 * pair that reads fine becomes one the limiter cannot run on, in both directions:
 * `{ limit: Number.MAX_VALUE, windowMs: 1 }` computes to `Infinity` — a bucket that never empties,
 * which is the same "declared a limit, enforced nothing" as `windowMs: 0` — and a tiny limit over
 * a huge window underflows to `0`, a bucket that never refills, so the endpoint is closed after
 * its first burst rather than limited.
 */
export const toBucket = (owner: string, declared: RateLimitDeclaration): Bucket => {
  const refuse = (reason: string): never => {
    throw rateLimitInvalid({
      owner,
      limit: declared.limit,
      windowMs: declared.windowMs,
      reason,
    });
  };
  // A capacity under one token cannot admit a single request, so the endpoint is closed, not
  // limited — a policy's job, never a rate limit's.
  if (!Number.isFinite(declared.limit) || declared.limit < 1) {
    refuse('limit must be a finite number of at least 1 request');
  }
  if (!Number.isFinite(declared.windowMs) || declared.windowMs <= 0) {
    refuse('windowMs must be finite and greater than zero');
  }
  const refillPerSecond = declared.limit / (declared.windowMs / 1000);
  // Kept though the two checks above make it unreachable today: with `limit >= 1` and a finite
  // window the smallest rate is ~5.6e-306, which is normal, not zero. It is the guard that has to
  // move first if `limit >= 1` is ever relaxed.
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    refuse(
      `the refill rate it computes to is ${refillPerSecond} per second, which is a bucket that never empties — nothing would be enforced`,
    );
  }
  return { capacity: declared.limit, refillPerSecond };
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

/**
 * The numbers a caller is owed, given what the bucket holds AFTER the take. Exported because a
 * store that keeps its counters in Postgres does the refill and the spend in SQL and has nothing
 * left to compute them with — and two drivers deriving `retryAfterSeconds` separately is two
 * answers to "when may I come back", one of which is wrong. `allowed` is passed rather than
 * inferred: `tokens` alone cannot tell a spend that landed at 0.5 from a refusal with 0.5 left.
 */
export const rateLimitDecision = (
  bucket: Bucket,
  tokens: number,
  cost: number,
  allowed: boolean,
  nowMs: number,
): RateLimitDecision => {
  const deficit = allowed ? bucket.capacity - tokens : cost - tokens;
  // A bucket that never refills would give an infinite reset; clamp to a day so the
  // Retry-After header stays a number a client can act on.
  const secondsToRefill =
    bucket.refillPerSecond > 0 ? Math.min(86_400, deficit / bucket.refillPerSecond) : 86_400;
  return {
    allowed,
    limit: bucket.capacity,
    remaining: Math.floor(tokens),
    resetAtMs: nowMs + Math.ceil(secondsToRefill * 1000),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(secondsToRefill)),
  };
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
  return rateLimitDecision(bucket, state.tokens, cost, allowed, nowMs);
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
  /**
   * The one source of "now" for the bucket maths. `Date.now()` used to be read inline here, and
   * BOTH production call sites (`server.ts`, `pipeline.ts`) build their limiter without an
   * override — so the limiter that actually throttles requests could not be frozen by any test,
   * while `@ultimat3/auth`'s credential limiter has taken an injected `Clock` since it shipped.
   * Defaulted rather than required, the same shape as `createRequestContext`'s `init.clock`;
   * `PipelineDeps.limiter` stays the one seam for handing the pipeline a limiter of your own,
   * because a second `clock` beside it would be a second way to set one number.
   */
  clock?: Clock;
}): RateLimiter => {
  const store = options.store ?? memoryRateLimitStore();
  const clock = options.clock ?? systemClock;
  const now = (): number => clock.now().getTime();
  // `Object.hasOwn`, never `buckets[name]` — the same read `error-map.ts`'s `statusFor` and
  // `naming.ts` already take for a table of this shape. `buckets` is a plain object literal, so it
  // holds every name on `Object.prototype`: `rateLimit: 'constructor'` read `Object` itself out of
  // it, and a `Bucket` whose `capacity` is `undefined` is a limiter that decides nothing. Author-
  // controlled, and still the one form — a table indexed by a name is indexed through `hasOwn`.
  const declared = (name: string): Bucket | undefined =>
    Object.hasOwn(options.config.buckets, name) ? options.config.buckets[name] : undefined;
  const bucketFor = (name: string): Bucket =>
    declared(name) ??
    declared(options.config.defaultBucket) ??
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
