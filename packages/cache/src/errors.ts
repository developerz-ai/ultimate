// The X_* codes owned by @ultimat3/cache. Each one names the exact config change or
// command that resolves it, so an agent reading the failure can act without a doc lookup.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const CACHE_OWNED_ERROR_CODES = [
  'X_CACHE_DRIVER_UNAVAILABLE',
  'X_CACHE_PURGE_FAILED',
  'X_CACHE_TAG_UNKNOWN',
  'X_CACHE_TOO_LARGE',
] as const;

/** Every code cache can throw. It borrows none: every remote driver here is implemented. */
export const CACHE_ERROR_CODES = [...CACHE_OWNED_ERROR_CODES] as const;

export type CacheOwnedErrorCode = (typeof CACHE_OWNED_ERROR_CODES)[number];
export type CacheErrorCode = (typeof CACHE_ERROR_CODES)[number];

export const CACHE_ERROR_TITLES: Readonly<Record<CacheOwnedErrorCode, string>> = {
  X_CACHE_DRIVER_UNAVAILABLE: "a tier's backing store is missing",
  X_CACHE_PURGE_FAILED: 'the CDN refused a purge',
  X_CACHE_TAG_UNKNOWN: 'a tag no entity declared',
  X_CACHE_TOO_LARGE: "one entry exceeds the tier's byte budget",
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
