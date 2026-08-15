/**
 * When to deliver a member's digest. The promise is "09:00, where you are" — so the only correct
 * input is an IANA zone, and the only correct unit of *timing* is a member. The unit of WORK is
 * one step coarser: members of one org who share a zone share an instant and a post window, and
 * `scheduleByOrgAndZone` is where that pair becomes one group.
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

/**
 * The slot one local day BEFORE `slot` — a digest's window opens at the previous digest and
 * closes at this one, so no post is in two digests and none is in neither.
 *
 * `slot - 86_400_000` is the bug this exists to refuse: consecutive slots are 23 hours apart on
 * spring-forward and 25 on autumn-back, so a fixed day of milliseconds reaches an hour PAST the
 * previous slot in March (those posts ship twice) and stops an hour SHORT of it in October (those
 * ship to nobody). Same calendar math as `nextDigestAt`, in the other direction.
 */
export const previousDigestAt = (
  slot: Date,
  zone: string,
  hour: number = DIGEST_LOCAL_HOUR,
): Date =>
  fromZoned(
    { ...addDays(toCalendarDay(toZoned(slot, zone)), -1), hour, minute: 0, second: 0 },
    zone,
  );

const toCalendarDay = (parts: { year: number; month: number; day: number }): CalendarDay => ({
  year: parts.year,
  month: parts.month,
  day: parts.day,
});

/** One digest: the members of one org who share one zone, and the instant their clock reads 09:00. */
export interface DigestSlot<T> {
  readonly orgId: string;
  readonly zone: string;
  readonly at: Date;
  readonly members: readonly T[];
}

/** Neither half can contain a NUL, so no pair of values can collide on the joined key. */
const slotKey = (orgId: string, zone: string): string => `${orgId}\u0000${zone}`;

/**
 * Group members by (org, zone) so the digest enqueues one delivery per group rather than one per
 * member — which is what lets that delivery read its org's post window once instead of once per
 * reader. The zone half is not an optimisation: the window is org-scoped and its bound is the
 * group's own `at`, so two zones inside one org are two different windows and two different mails.
 *
 * `nextDigestAt` still runs once per ZONE, not once per group: 500 members in Madrid share one
 * calculation whether they sit in one org or fifty. Order follows `members`, so a caller that
 * reads its rows in a stable order gets stable group names to key durable steps on.
 */
export const scheduleByOrgAndZone = <T extends { readonly tz: string; readonly orgId: string }>(
  members: readonly T[],
  after: Date,
): readonly DigestSlot<T>[] => {
  const slots = new Map<string, Date>();
  const grouped = new Map<string, { orgId: string; zone: string; at: Date; members: T[] }>();

  for (const member of members) {
    const bucket = grouped.get(slotKey(member.orgId, member.tz));
    if (bucket) {
      bucket.members.push(member);
      continue;
    }
    let at = slots.get(member.tz);
    if (at === undefined) {
      at = nextDigestAt(after, member.tz);
      slots.set(member.tz, at);
    }
    grouped.set(slotKey(member.orgId, member.tz), {
      orgId: member.orgId,
      zone: member.tz,
      at,
      members: [member],
    });
  }
  return [...grouped.values()];
};
