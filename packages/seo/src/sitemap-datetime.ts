// Single responsibility: one page's `lastmod`, as the W3C Datetime a sitemap writes — or the
// answer that it is not a date. No ambient zone is ever read: a time without one is refused.

import { isIsoDateTime } from '@ultimat3/schema';

/** What a refusal quotes back, so the fix names the forms that are accepted. */
export const SITEMAP_DATETIME_FORMS =
  'a Date or an ISO 8601 date with an explicit zone (2026-10-01, 2026-10-01T15:04:05Z, 2026-10-01T10:04:05-05:00)';

/**
 * `value` in UTC (`2026-10-01T15:04:05.000Z`), or `undefined` when it names no instant.
 *
 * A string is screened by `@ultimat3/schema`'s `isIsoDateTime`, the rule `t.date` and the feed
 * dates answer with: the zone is REQUIRED on a time (`Date.parse` reads a zoneless one in the
 * process's zone, so one row would be two instants), and the day must exist (`Date.parse` rolls
 * `2026-02-30` into March 2nd, a date nobody wrote).
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
      : typeof value === 'string' && isIsoDateTime(value)
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  return new Date(Math.min(time, now.getTime())).toISOString();
}
