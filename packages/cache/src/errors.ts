// The X_* codes owned by @ultimat3/cache. Each one names the exact config change or
// command that resolves it, so an agent reading the failure can act without a doc lookup.
import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const CACHE_ERROR_CODES = [
  'X_CACHE_DRIVER_UNAVAILABLE',
  'X_CACHE_TAG_UNKNOWN',
  'X_CACHE_TOO_LARGE',
  'X_NOT_IMPLEMENTED',
] as const;

export type CacheErrorCode = (typeof CACHE_ERROR_CODES)[number];

export const CACHE_ERROR_TITLES: Readonly<Record<CacheErrorCode, string>> = {
  X_CACHE_DRIVER_UNAVAILABLE: "a tier's backing store is missing",
  X_CACHE_TAG_UNKNOWN: 'a tag no entity declared',
  X_CACHE_TOO_LARGE: "one entry exceeds the tier's byte budget",
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
};

// X_NOT_IMPLEMENTED is core's; registering it twice would throw X_ERROR_CODE_DUPLICATE.
for (const [code, title] of Object.entries(CACHE_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

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

/** An interface-complete driver whose remote half is not written yet. */
export class CacheNotImplementedError extends UltimateError {
  constructor(input: { feature: string; fix: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `${input.feature} is declared but not implemented in @ultimat3/cache`,
      fix: input.fix,
      docs: docsFor('X_NOT_IMPLEMENTED'),
    });
  }
}
