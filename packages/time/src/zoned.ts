/**
 * The two conversions everything else is built on: instant → wall clock, and wall clock →
 * instant. `fromZoned` is the DST-correct one, and it is the reason this package exists.
 */

import { dstAmbiguous, dstNonexistent } from './errors';
import { addMs, type Instant } from './instant';
import { assertTimeZone, offsetAt, type TimeZone, zonePartsAt } from './zones';

/** A local date and time with no zone attached — meaningless until paired with one. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
}

export interface ZonedDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  zone: TimeZone;
  /** Minutes east of UTC in effect at this instant. */
  offsetMinutes: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

/** What to do with a wall-clock time that does not exist (spring forward). */
export type GapPolicy = 'next' | 'previous' | 'throw';
/** What to do with a wall-clock time that happens twice (fall back). */
export type OverlapPolicy = 'first' | 'second' | 'throw';

export interface FromZonedOptions {
  gap?: GapPolicy;
  overlap?: OverlapPolicy;
}

export type ZonedResolution = 'exact' | 'gap' | 'overlap';

export interface FromZonedResult {
  instant: Instant;
  /** Which case the wall-clock time fell into — log it when scheduling. */
  resolution: ZonedResolution;
  offsetMinutes: number;
}

const DEFAULTS: Required<FromZonedOptions> = { gap: 'next', overlap: 'first' };

/** Instant → the zone's wall clock. */
export function toZoned(at: Instant, zone: TimeZone): ZonedDateTime {
  assertTimeZone(zone);
  const parts = zonePartsAt(zone, at);
  const offsetMinutes = offsetAt(zone, at);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return {
    ...parts,
    millisecond: at.getTime() - Math.floor(at.getTime() / 1000) * 1000,
    zone,
    offsetMinutes,
    // getUTCDay on the as-if-UTC epoch gives the *local* weekday: 0 = Sunday.
    weekday: ((new Date(asIfUtc).getUTCDay() + 6) % 7) + 1,
  };
}

/**
 * Wall clock + zone → instant, DST-correct.
 *
 * Algorithm (search and verify — never `offset * 3600`):
 *  1. Read the wall-clock fields as if they were UTC. Call that `target`.
 *  2. Collect the candidate offsets in force around `target` — 24h before, at, and 24h
 *     after. Any DST transition puts both of its offsets in that set.
 *  3. For each distinct offset `o`, the candidate instant is `target - o`.
 *  4. Verify each candidate by converting it *back* with `toZoned`. A candidate that does
 *     not reproduce the requested wall clock is not a real instant for it.
 *      - two distinct verified candidates → the hour repeats (overlap)
 *      - exactly one                      → normal case
 *      - none                             → the hour was skipped (gap)
 *
 * Milliseconds ride along untouched: every real offset is a whole number of minutes.
 */
export function fromZonedDetailed(
  wall: WallClock,
  zone: TimeZone,
  options: FromZonedOptions = {},
): FromZonedResult {
  assertTimeZone(zone);
  const { gap, overlap } = { ...DEFAULTS, ...options };
  const millisecond = wall.millisecond ?? 0;
  // Normalize overflow first (day 32, hour 24, month 13) so callers can do naive calendar
  // arithmetic — `addDaysInZone` relies on it — and so verification compares real fields.
  const normal = normalizeWall(wall);
  const target = Date.UTC(
    normal.year,
    normal.month - 1,
    normal.day,
    normal.hour,
    normal.minute,
    normal.second,
  );

  const probes = [target - 86_400_000, target, target + 86_400_000];
  const offsets = new Set(probes.map((ms) => offsetAt(zone, new Date(ms) as Instant)));

  const verified: number[] = [];
  for (const offsetMinutes of offsets) {
    const candidate = target - offsetMinutes * 60_000;
    if (matchesWall(candidate, zone, normal)) verified.push(candidate);
  }
  const distinct = [...new Set(verified)].sort((a, b) => a - b);

  if (distinct.length > 1) {
    if (overlap === 'throw') throw dstAmbiguous(describeWall(normal), zone);
    const chosen = overlap === 'first' ? distinct[0] : distinct[distinct.length - 1];
    return finish(chosen ?? target, millisecond, zone, 'overlap');
  }

  const single = distinct[0];
  if (single !== undefined) return finish(single, millisecond, zone, 'exact');

  // Gap: the requested wall clock was skipped. The two unverified candidates bracket it —
  // the smaller lands before the transition, the larger after it.
  if (gap === 'throw') throw dstNonexistent(describeWall(normal), zone);
  const bracket = [...offsets]
    .map((offsetMinutes) => target - offsetMinutes * 60_000)
    .sort((a, b) => a - b);
  const chosen = gap === 'next' ? bracket[bracket.length - 1] : bracket[0];
  return finish(chosen ?? target, millisecond, zone, 'gap');
}

/** The common form: just the instant. */
export function fromZoned(
  wall: WallClock,
  zone: TimeZone,
  options: FromZonedOptions = {},
): Instant {
  return fromZonedDetailed(wall, zone, options).instant;
}

/** Midnight local, as an instant. DST-correct: on a spring-forward day it still exists. */
export function startOfDay(at: Instant, zone: TimeZone): Instant {
  const zoned = toZoned(at, zone);
  return fromZoned(
    { year: zoned.year, month: zoned.month, day: zoned.day, hour: 0, minute: 0 },
    zone,
    { gap: 'next' },
  );
}

/** The last millisecond of the local day. */
export function endOfDay(at: Instant, zone: TimeZone): Instant {
  const zoned = toZoned(at, zone);
  const nextMidnight = fromZoned(
    { year: zoned.year, month: zoned.month, day: zoned.day + 1, hour: 0, minute: 0 },
    zone,
    { gap: 'next' },
  );
  return addMs(nextMidnight, -1);
}

/**
 * Add calendar days in a zone, keeping the wall-clock time. Adding one day is 23, 24 or
 * 25 hours depending on the transition — which is why this is not `+ 86_400_000`.
 */
export function addDaysInZone(at: Instant, days: number, zone: TimeZone): Instant {
  const zoned = toZoned(at, zone);
  return fromZoned(
    {
      year: zoned.year,
      month: zoned.month,
      day: zoned.day + days,
      hour: zoned.hour,
      minute: zoned.minute,
      second: zoned.second,
      millisecond: zoned.millisecond,
    },
    zone,
    { gap: 'next' },
  );
}

/** `2026-03-14` for the given instant in the given zone. */
export function isoDateInZone(at: Instant, zone: TimeZone): string {
  const zoned = toZoned(at, zone);
  return `${String(zoned.year).padStart(4, '0')}-${pad2(zoned.month)}-${pad2(zoned.day)}`;
}

/** True when both instants fall on the same local calendar day. */
export function isSameLocalDay(left: Instant, right: Instant, zone: TimeZone): boolean {
  return isoDateInZone(left, zone) === isoDateInZone(right, zone);
}

/**
 * Whole calendar days from `from` to `to`, counted as local day boundaries crossed in `zone`.
 * Signed, and always integral. Not `differenceMs / 86_400_000`: a 23- or 25-hour DST day is
 * still one day, and 24 real hours inside a 25-hour local day is still zero.
 */
export function daysBetween(from: Instant, to: Instant, zone: TimeZone): number {
  // Both dates are reduced to a UTC midnight, so the subtraction carries no offset at all.
  return (localDayEpoch(to, zone) - localDayEpoch(from, zone)) / 86_400_000;
}

/** The instant's local calendar date, expressed as the UTC midnight of that date. */
function localDayEpoch(at: Instant, zone: TimeZone): number {
  const zoned = toZoned(at, zone);
  return Date.UTC(zoned.year, zoned.month - 1, zoned.day);
}

function finish(
  epochMs: number,
  millisecond: number,
  zone: TimeZone,
  resolution: ZonedResolution,
): FromZonedResult {
  const value = new Date(epochMs + millisecond) as Instant;
  return { instant: value, resolution, offsetMinutes: offsetAt(zone, value) };
}

/** Field-complete wall clock with all overflow carried into the higher fields. */
interface NormalWall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function normalizeWall(wall: WallClock): NormalWall {
  const asUtc = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0),
  );
  return {
    year: asUtc.getUTCFullYear(),
    month: asUtc.getUTCMonth() + 1,
    day: asUtc.getUTCDate(),
    hour: asUtc.getUTCHours(),
    minute: asUtc.getUTCMinutes(),
    second: asUtc.getUTCSeconds(),
  };
}

function matchesWall(epochMs: number, zone: TimeZone, wall: NormalWall): boolean {
  const parts = zonePartsAt(zone, new Date(epochMs) as Instant);
  return (
    parts.year === wall.year &&
    parts.month === wall.month &&
    parts.day === wall.day &&
    parts.hour === wall.hour &&
    parts.minute === wall.minute &&
    parts.second === wall.second
  );
}

function describeWall(wall: NormalWall): string {
  return `${String(wall.year).padStart(4, '0')}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
