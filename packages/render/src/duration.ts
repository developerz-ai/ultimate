/**
 * The one reader of a TTL string. It sits below both `modes.ts` (which asks "is this a TTL at
 * all?" when it refuses an `isr` route with no regeneration trigger) and `render-isr.ts` (which
 * asks "how many ms?"), because a second answer is what let `revalidate: { ttl: '5 minutes' }`
 * pass registration and then parse to `null` — a page generated once and served for the life of
 * the process while the CDN was told `s-maxage=60`.
 */

/** A `Map`, never an object literal: a unit is read by a string key, and a `Map` has no prototype chain to answer for it. */
const DURATION_UNITS: ReadonlyMap<string, number> = new Map([
  ['ms', 1],
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
]);

/** `'5m'` → 300000. Numbers pass through as milliseconds. */
export function parseTtlMs(ttl: string | number | null | undefined): number | null {
  if (ttl === null || ttl === undefined) return null;
  if (typeof ttl === 'number') return positiveMs(ttl);
  // Typed away, reachable from JS: `modes.ts` asks this of an unvalidated `revalidate.ttl`.
  if (typeof ttl !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(ttl.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) return null;
  const factor = DURATION_UNITS.get(unit);
  return factor === undefined ? null : positiveMs(Number(amount) * factor);
}

/**
 * `revalidate.maxStale`'s reader: the one duration that may be ZERO — "never answer a copy past
 * its ttl" is a bound, where a zero-length TTL is no trigger at all. `null` is "not a duration".
 */
export function parseStaleMs(value: string | number | null | undefined): number | null {
  if (
    value === 0 ||
    (typeof value === 'string' && /^0(?:\.0+)?(?:ms|s|m|h|d)$/.test(value.trim()))
  ) {
    return 0;
  }
  return parseTtlMs(value);
}

/**
 * Both arms end here, so `'0s'` and `0` cannot disagree: a zero-length TTL registered, and
 * `entryTtlMs` then read the stored `0` as tag-only — a page declared to expire never did.
 */
const positiveMs = (ms: number): number | null => (Number.isFinite(ms) && ms > 0 ? ms : null);
