// `cache.defaultTtlMs` as the boot hands it to the rungs it builds — refused here under the key
// the app wrote, never by a rung under the name of an option the app never set.

import { ConfigInvalidError } from '@ultimat3/core';

/** `describeValue` answers "a number" for 0 and 2.5 alike; a number is printed as itself. */
const shown = (value: number): string => `${value}`;

/**
 * The lease option for a built rung, or nothing so the rung keeps its own default. A value that is
 * not a whole number of milliseconds above zero is `X_CONFIG_INVALID` naming `cache.defaultTtlMs`:
 * `lruTier` refuses the same value as `X_CACHE_LIMIT_INVALID` about "lru.defaultTtlMs", with a
 * fix that points at `runtime.ts` — the wrong file for a key written in `app.config.ts`.
 */
export function defaultTtlOf(value: number | undefined): { defaultTtlMs?: number } {
  if (value === undefined) return {};
  if (Number.isSafeInteger(value) && value > 0) return { defaultTtlMs: value };
  throw new ConfigInvalidError({
    cause: `cache.defaultTtlMs must be a whole number of milliseconds of at least 1, not ${shown(value)}`,
    fix: 'defineConfig({ cache: { defaultTtlMs: 60_000 } })   // in app.config.ts: the lease of a cached value set with no ttlMs',
    meta: { key: 'cache.defaultTtlMs', value: shown(value) },
  });
}
