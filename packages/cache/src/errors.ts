// The X_* codes owned by @ultimat3/cache. Each one names the exact config change or
// command that resolves it, so an agent reading the failure can act without a doc lookup.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const CACHE_OWNED_ERROR_CODES = [
  'X_CACHE_DRIVER_UNAVAILABLE',
  'X_CACHE_JITTER_INVALID',
  'X_CACHE_PURGE_FAILED',
  'X_CACHE_TAG_UNKNOWN',
  'X_CACHE_TOO_LARGE',
  'X_CACHE_TTL_INVALID',
] as const;

/** Every code cache can throw. It borrows none: every remote driver here is implemented. */
export const CACHE_ERROR_CODES = [...CACHE_OWNED_ERROR_CODES] as const;

export type CacheOwnedErrorCode = (typeof CACHE_OWNED_ERROR_CODES)[number];
export type CacheErrorCode = (typeof CACHE_ERROR_CODES)[number];

export const CACHE_ERROR_TITLES: Readonly<Record<CacheOwnedErrorCode, string>> = {
  X_CACHE_DRIVER_UNAVAILABLE: "a tier's backing store is missing",
  X_CACHE_JITTER_INVALID: 'a TTL jitter fraction outside [0, 1)',
  X_CACHE_PURGE_FAILED: 'the CDN refused a purge',
  X_CACHE_TAG_UNKNOWN: 'a tag no entity declared',
  X_CACHE_TOO_LARGE: "one entry exceeds the tier's byte budget",
  X_CACHE_TTL_INVALID: 'a cache TTL that is not a positive number of milliseconds',
};

// One unconditional call, so a second package claiming one of cache's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(CACHE_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: CacheErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** A tier's backing store is missing at runtime (no Redis binding, no CDN token). */
export class CacheDriverUnavailableError extends UltimateError {
  constructor(input: { driver: string; cause: string; fix: string }) {
    super({
      code: 'X_CACHE_DRIVER_UNAVAILABLE',
      cause: `cache tier "${input.driver}" is unavailable: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_CACHE_DRIVER_UNAVAILABLE'),
    });
  }
}

/**
 * A tag was used that no entity declared. Caught here rather than at read time because a
 * typo in `invalidates: [tag.pots]` is otherwise a silent stale-forever bug.
 */
export class CacheTagUnknownError extends UltimateError {
  constructor(input: { tag: string; known: readonly string[] }) {
    super({
      code: 'X_CACHE_TAG_UNKNOWN',
      cause: `tag "${input.tag}" is not declared by any entity (declared: ${
        input.known.length > 0 ? input.known.join(', ') : 'none'
      })`,
      fix: 'x manifest',
      docs: docsFor('X_CACHE_TAG_UNKNOWN'),
    });
  }
}

/** A single entry cannot fit the tier's byte budget, so caching it would evict everything. */
export class CacheTooLargeError extends UltimateError {
  constructor(input: { key: string; bytes: number; maxBytes: number; tier: string }) {
    super({
      code: 'X_CACHE_TOO_LARGE',
      cause: `entry "${input.key}" is ${input.bytes}B, over the ${input.tier} budget of ${input.maxBytes}B`,
      fix: `raise cache.${input.tier}.maxBytes in app.config.ts, or cache a projection instead of the row`,
      docs: docsFor('X_CACHE_TOO_LARGE'),
    });
  }
}

/**
 * A `ttlMs` that is not a positive, finite number of milliseconds.
 *
 * `0` used to mean two things: "never expires" in the LRU tier and `EX 1` — one second — in the
 * Redis tier, so a stack holding both answered differently depending on which one hit. Neither is
 * what a caller writing `0` intends, and the third reading ("do not cache") has its own spelling:
 * do not call the cache. Refused rather than resolved, so the miswiring is a failure and not a
 * behaviour that varies by deployment.
 */
export class CacheTtlInvalidError extends UltimateError {
  constructor(input: { key: string; ttlMs: number; tier: string }) {
    super({
      code: 'X_CACHE_TTL_INVALID',
      cause: `entry "${input.key}" was written to the ${input.tier} tier with ttlMs=${String(
        input.ttlMs,
      )}; a TTL is a positive, finite number of milliseconds`,
      fix: `cache.write('${input.key}', value, { ttlMs: 60_000 })   # or drop the option for the tier default; a value you do not want held is one you do not write`,
      docs: docsFor('X_CACHE_TTL_INVALID'),
      meta: { key: input.key, ttlMs: input.ttlMs, tier: input.tier },
    });
  }
}

/**
 * A jitter fraction a tier cannot spread a TTL with.
 *
 * Jitter exists because 40,000 keys warmed by one rolling restart share one TTL and therefore one
 * expiry instant; spreading them is the only thing that stops the herd. A fraction of `1` or more
 * would shave a whole lease away and a negative one would EXTEND it past what the caller asked
 * for, so both are miswiring rather than a preference — refused where the TTL rule already lives,
 * for the same reason `0` is not silently reinterpreted as "never expires".
 */
export class CacheJitterInvalidError extends UltimateError {
  constructor(input: { tier: string; jitterFraction: number }) {
    super({
      code: 'X_CACHE_JITTER_INVALID',
      cause: `the ${input.tier} tier was configured with jitterFraction=${String(
        input.jitterFraction,
      )}; a jitter fraction is a finite number in [0, 1)`,
      fix: `set cache.${input.tier}.jitterFraction in app.config.ts to a value in [0, 1) — 0.05 is the default, 0 disables jitter`,
      docs: docsFor('X_CACHE_JITTER_INVALID'),
      meta: { tier: input.tier, jitterFraction: input.jitterFraction },
    });
  }
}

/**
 * A remote purge did not happen. Never fatal on its own — `invalidateTags` collects it into
 * `report.errors` so a dead CDN cannot fail the write that triggered the bust — which is exactly
 * why `retryable` is carried rather than guessed: the caller decides whether the same purge,
 * unchanged, is worth sending again, and a stale edge until TTL is the cost of getting it wrong.
 */
export class CachePurgeFailedError extends UltimateError {
  constructor(input: {
    driver: string;
    detail: string;
    status?: number | undefined;
    retryable: boolean;
    fix: string;
  }) {
    const status = input.status === undefined ? '' : ` (HTTP ${input.status})`;
    super({
      code: 'X_CACHE_PURGE_FAILED',
      cause: `${input.driver} refused the purge${status}: ${input.detail}`,
      fix: input.fix,
      docs: docsFor('X_CACHE_PURGE_FAILED'),
      meta: {
        driver: input.driver,
        retryable: input.retryable,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });
  }
}
