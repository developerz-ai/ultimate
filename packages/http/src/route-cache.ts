// Single responsibility: the screen a route's `cache` hint gets where it is DECLARED.
//
// The layered form the rest of the framework uses: refuse where a value is WRITTEN, be total where
// it is USED. `cacheControl` is the total half — it drops a field it cannot emit and warns — and
// this is the half that throws, because at registration the author is standing right there.

import { routeCacheInvalid } from './errors';
import type { CacheHint } from './response';
import { isDeltaSeconds } from './response';

/**
 * The three `CacheHint` fields that reach a `cache-control` directive as a NUMBER. `tags` and
 * `vary` are string lists and `mode` is a closed union the compiler already decides.
 *
 * A tuple of literals rather than `Object.keys(hint)`: the set is the emitter's, not the caller's,
 * so a field added to `CacheHint` and forgotten here is a compile error at the emitter's next edit
 * rather than a silently unscreened age.
 */
const DELTA_SECONDS_FIELDS = [
  'maxAgeSeconds',
  'sMaxAgeSeconds',
  'staleWhileRevalidateSeconds',
] as const;

/**
 * `isDeltaSeconds` is IMPORTED from `response.ts`, never restated: that file owns what may be
 * emitted, this one what may be declared, and a byte-identical predicate in both is how a screen
 * and its emitter come to accept different sets — a route that registers cleanly and then emits no
 * age at all. **Zero stays legal at both ends**: `max-age=0` means "revalidate every time" and the
 * framework's own defaults declare it — `PRIVATE_CACHE`, `defaultCache`'s anonymous hint and the
 * CLI's authorized-object hint all carry `maxAgeSeconds: 0`, so a floor of 1 would refuse the
 * framework at its own boot.
 *
 * Called once per route by `createRouter`, which is the one way a `Route` becomes matchable — so
 * every hint an app can serve has been through here, including the ones `@ultimat3/cli` mints for
 * favicons, dev assets and storage objects.
 */
export const assertRouteCache = (
  hint: CacheHint | undefined,
  route: string,
  path: string,
): void => {
  if (hint === undefined) return;
  for (const field of DELTA_SECONDS_FIELDS) {
    const value = hint[field];
    if (value === undefined || isDeltaSeconds(value)) continue;
    throw routeCacheInvalid(route, path, field, value);
  }
};
