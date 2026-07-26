/**
 * When to deliver a member's digest. The promise is "09:00, where you are" — so the only correct
 * unit of scheduling is a member, and the only correct input is an IANA zone.
 */

import { DIGEST_LOCAL_HOUR } from '@postly/domain';
import { fromZoned, toZoned } from '@ultimat3/time';

type CalendarDay = { year: number; month: number; day: number };

/**
 * Day arithmetic on the local calendar, then one conversion back to an instant. Adding
 * 86_400_000 ms instead would drift by an hour twice a year — and only for some users, which is
 * how this bug survives to production.
 */
const addDays = (day: CalendarDay, days: number): CalendarDay => {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/** The calendar date it is for this member right now. Used verbatim in digest idempotency keys. */
export const localDateIn = (instant: Date, zone: string): string => {
  const parts = toZoned(instant, zone);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
};

/**
 * The next instant at which the member's wall clock reads `hour:00`, strictly after `after`.
 * Strictly, so a retried scheduler tick lands on the same slot instead of scheduling a second
 * send for today.
 *
 * DST edges are @ultimat3/time's problem: `fromZoned` resolves a local time that does not exist
 * (spring-forward gap) to the first instant after the gap, and an ambiguous one (autumn overlap)
 * to the earlier of the two.
 */
export const nextDigestAt = (after: Date, zone: string, hour: number = DIGEST_LOCAL_HOUR): Date => {
  const today = toZoned(after, zone);
  const candidate = fromZoned({ ...toCalendarDay(today), hour, minute: 0, second: 0 }, zone);
  if (candidate.getTime() > after.getTime()) return candidate;

  return fromZoned(
    {
      ...addDays(toCalendarDay(today), 1),
      hour,
      minute: 0,
      second: 0,
    },
    zone,
  );
};

const toCalendarDay = (parts: { year: number; month: number; day: number }): CalendarDay => ({
  year: parts.year,
  month: parts.month,
  day: parts.day,
});

/**
 * Group members by zone so the digest job enqueues one delivery per member with the right
 * `runAt`, in a single pass, without asking the database for a zone-shaped query.
 */
export const scheduleByZone = <T extends { readonly tz: string }>(
  members: readonly T[],
  after: Date,
): ReadonlyMap<string, { readonly at: Date; readonly members: readonly T[] }> => {
  const grouped = new Map<string, { at: Date; members: T[] }>();
  for (const member of members) {
    const bucket = grouped.get(member.tz);
    if (bucket) {
      bucket.members.push(member);
      continue;
    }
    grouped.set(member.tz, { at: nextDigestAt(after, member.tz), members: [member] });
  }
  return grouped;
};
