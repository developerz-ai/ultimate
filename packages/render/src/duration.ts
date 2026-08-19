/**
 * The one reader of a TTL string. It sits below both `modes.ts` (which asks "is this a TTL at
 * all?" when it refuses an `isr` route with no regeneration trigger) and `render-isr.ts` (which
 * asks "how many ms?"), because a second answer is what let `revalidate: { ttl: '5 minutes' }`
 * pass registration and then parse to `null` — a page generated once and served for the life of
 * the process while the CDN was told `s-maxage=60`.
 */

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `'5m'` → 300000. Numbers pass through as milliseconds. */
export function parseTtlMs(ttl: string | number | null | undefined): number | null {
  if (ttl === null || ttl === undefined) return null;
  if (typeof ttl === 'number') return Number.isFinite(ttl) && ttl > 0 ? ttl : null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(ttl.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) return null;
  const factor = DURATION_UNITS[unit];
  return factor === undefined ? null : Number(amount) * factor;
}
