// Single responsibility: one page's `lastmod`, as the W3C Datetime a sitemap writes — or the
// answer that it is not a date. No ambient zone is ever read: a time without one is refused.

/**
 * ISO 8601 as a sitemap accepts it, with the zone REQUIRED on a time. `Date.parse` alone is not the
 * test: it reads `2026-10-01T10:00:00` and `October 1, 2026` in the process's own zone, so one row
 * would be two instants on a laptop in Bogotá and in a container on UTC.
 */
const ISO_ZONED =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** What a refusal quotes back, so the fix names the forms that are accepted. */
export const SITEMAP_DATETIME_FORMS =
  'a Date or an ISO 8601 date with an explicit zone (2026-10-01, 2026-10-01T15:04:05Z, 2026-10-01T10:04:05-05:00)';

/**
 * `value` in UTC (`2026-10-01T15:04:05.000Z`), or `undefined` when it names no instant.
 *
 * A moment after `now` is CLAMPED to `now`, never refused and never written as it stands. Written,
 * it is a date a crawler learns to distrust for the whole file. Refused, one row stamped by a
 * database a second ahead of this process fails the enumeration for every page. Clamped, it says
 * the one thing that is certainly true of a change that already happened: no later than now.
 */
export function sitemapDatetime(value: unknown, now: Date): string | undefined {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string' && ISO_ZONED.test(value)
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  return new Date(Math.min(time, now.getTime())).toISOString();
}
