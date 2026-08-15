// Registration: a route that declares its own bucket puts it in the limiter's table. The bucket
// maths and the store stay in `rate-limit.ts`; this file is the one point where routes and config
// meet — `defineHttpConfig` runs before any route exists, so the table it builds cannot hold them,
// and a bucket name with nothing behind it falls through `bucketFor` to `default`.

import type { HttpConfig } from './config';
import { rateLimitBucketConflict } from './errors';
import type { Bucket } from './rate-limit';
import type { Route } from './router';

const same = (a: Bucket, b: Bucket): boolean =>
  a.capacity === b.capacity && a.refillPerSecond === b.refillPerSecond;

/**
 * The config with every route-declared bucket registered under the name that route selects.
 *
 * Precedence is refusal, never a winner: an equal restatement passes, and any disagreement — with
 * a configured bucket, or with another route claiming the same name — is
 * `X_RATE_LIMIT_BUCKET_CONFLICT` before the socket opens. Picking one would leave the other a
 * number an author read, an OpenAPI document published and nothing enforced, which is the exact
 * failure this seam closes. Same shape as `@ultimat3/auth`'s `AuthLimiter` policy check.
 *
 * Idempotent, so both construction paths (`createServer`, and `createPipeline` under it) can apply
 * it: a second pass compares each bucket against the copy the first pass registered.
 */
export const withRouteBuckets = (config: HttpConfig, routes: readonly Route[]): HttpConfig => {
  const declared = new Map<string, { readonly bucket: Bucket; readonly route: string }>();
  for (const route of routes) {
    const bucket = route.meta.rateLimitBucket;
    const name = route.meta.rateLimit;
    // Numbers with no name to file them under enforce nothing; `toRoute` always sets both.
    if (bucket === undefined || name === undefined) continue;
    const prior = declared.get(name);
    const configured = config.rateLimit.buckets[name];
    if (prior !== undefined && !same(prior.bucket, bucket)) {
      throw rateLimitBucketConflict({
        bucket: name,
        otherRoute: prior.route,
        route: route.meta.name,
        other: prior.bucket,
        declared: bucket,
      });
    }
    if (prior === undefined && configured !== undefined && !same(configured, bucket)) {
      throw rateLimitBucketConflict({
        bucket: name,
        otherRoute: null,
        route: route.meta.name,
        other: configured,
        declared: bucket,
      });
    }
    declared.set(name, { bucket, route: route.meta.name });
  }
  if (declared.size === 0) return config;
  const buckets: Record<string, Bucket> = { ...config.rateLimit.buckets };
  for (const [name, entry] of declared) buckets[name] = entry.bucket;
  return { ...config, rateLimit: { ...config.rateLimit, buckets } };
};
