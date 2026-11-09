// The rate limit as DECLARED: the shipped bucket table, the resolver `defineHttpConfig` runs over
// an app's half, and `toBucket`, the one conversion from `{ limit, windowMs }` to a `Bucket`. Every
// refusal is raised here, where an author can act on it, never on the first request.
import { httpCountInvalid } from './errors';
import type { Bucket, RateLimitConfig } from './rate-limit';
import { rateLimitInvalid, rateLimitScopeUnset, tenantBucketUnknown } from './rate-limit-errors';

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
  tenantBucket: null,
  buckets: {
    default: { capacity: 120, refillPerSecond: 2 },
    // Login/signup style endpoints: slow, no burst.
    auth: { capacity: 10, refillPerSecond: 0.2 },
    mutation: { capacity: 30, refillPerSecond: 1 },
  },
};

/**
 * `toBucket`'s rule, for a bucket written as numbers: at least one whole request held, and a
 * finite refill above zero. A refill of 0 never forgets a key — on a shared store one entry held
 * forever per caller, minted without bound by a caller rotating its IPv6 /64s.
 */
const assertBucket = (name: string, bucket: Bucket): void => {
  if (!Number.isFinite(bucket.capacity) || bucket.capacity < 1) {
    throw httpCountInvalid(
      `rateLimit.buckets.${name}.capacity`,
      bucket.capacity,
      'a finite number of at least 1 request',
      `rateLimit: { buckets: { ${name}: { capacity: 10, refillPerSecond: 0.2 } } }`,
    );
  }
  if (!Number.isFinite(bucket.refillPerSecond) || bucket.refillPerSecond <= 0) {
    throw httpCountInvalid(
      `rateLimit.buckets.${name}.refillPerSecond`,
      bucket.refillPerSecond,
      'a finite number of tokens per second above 0',
      `rateLimit: { buckets: { ${name}: { capacity: ${String(bucket.capacity)}, refillPerSecond: 0.2 } } }`,
    );
  }
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
  for (const [name, bucket] of Object.entries(merged.buckets)) assertBucket(name, bucket);
  // Here and not at the first request, for `assertRateLimitScope`'s reason: an unknown name falls
  // through `bucketFor` to `default`, so a tenant allowance somebody wrote as 5,000 would silently
  // be the 120-burst read bucket — looser than what the author declared, and invisible.
  if (merged.tenantBucket !== null && !Object.hasOwn(merged.buckets, merged.tenantBucket)) {
    throw tenantBucketUnknown(merged.tenantBucket, Object.keys(merged.buckets));
  }
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
