// Single responsibility: which local calendar dates a zone never had at a given wall time — Samoa's
// 2011-12-30, or a late-evening gap that pushes the clock past midnight — found by sampling the
// zone's offset, not by asking `Intl` about every day. Each candidate is still settled by `localDayAt`.

import type { Instant } from './instant';
import { fromZoned, toZoned } from './zoned';
import { offsetSecondsAt, type TimeZone } from './zones';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A wall time of day: the part of the origin every candidate date keeps. */
export interface WallTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * The instant `day` (an epoch day) names at `wall` in `zone`, or `null` when the zone never had
 * that date at that time. Built from the calendar date and the ORIGINAL wall time, never from the
 * day before it: chaining a day at a time carried a DST repair (02:30 → 03:30) onto every later day.
 * `{ gap: 'next' }` moves a skipped wall time forward; when that lands on another date, this date
 * did not happen at this time.
 */
export function localDayAt(day: number, wall: WallTime, zone: TimeZone): Instant | null {
  const date = new Date(day * DAY_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const dayOfMonth = date.getUTCDate();
  const { hour, minute, second, millisecond } = wall;
  const candidate = fromZoned(
    { year, month, day: dayOfMonth, hour, minute, second, millisecond },
    zone,
    { gap: 'next' },
  );
  const got = toZoned(candidate, zone);
  return got.year === year && got.month === month && got.day === dayOfMonth ? candidate : null;
}

/**
 * The sampling stride. A transition is found as a change of offset between two samples, so two
 * transitions inside one stride that cancel are invisible. Measured over every zone `Intl` lists,
 * 1900–2050 (2026-11): the closest such pairs are 7.0 days apart (Brazil 2000, Gaza 2040), and
 * every pair under 28 days is a ONE-hour shift. A 1-hour gap moves a date only for a wall time from
 * 23:00 (see `skippedDays`), so 28 days is exact below 23:00 and 6 days above it.
 */
const STRIDE_DAYS = 28;
const LATE_STRIDE_DAYS = 6;
const LATE_WALL_MS = 23 * HOUR_MS;

const offsetMs = (zone: TimeZone, epochMs: number): number =>
  offsetSecondsAt(zone, new Date(epochMs) as Instant) * 1000;

/**
 * The epoch days in `[from, to)` that `localDayAt` answers `null` for, ascending.
 *
 * A gap of `Δ` makes `{ gap: 'next' }` land `Δ` later on the wall clock, so it changes the DATE only
 * when `wall + Δ` reaches midnight: a 1-hour spring-forward never removes a 09:00, and Samoa's
 * 24-hour jump removes every time of day. Only a transition that can do that is located (to the
 * day) and its neighbouring dates checked exactly; everything else is a date that exists.
 */
export function skippedDays(zone: TimeZone, wall: WallTime, from: number, to: number): number[] {
  if (to <= from) return [];
  const wallMs = wall.hour * HOUR_MS + wall.minute * 60_000 + wall.second * 1000 + wall.millisecond;
  const stride = (wallMs >= LATE_WALL_MS ? LATE_STRIDE_DAYS : STRIDE_DAYS) * DAY_MS;
  // Two days of margin each side: a historic offset reaches ±15:56 (Manila's LMT).
  const start = from * DAY_MS - 2 * DAY_MS;
  const end = to * DAY_MS + 2 * DAY_MS;
  const found = new Set<number>();
  let left = start;
  let leftOffset = offsetMs(zone, left);
  while (left < end) {
    const right = Math.min(left + stride, end);
    const rightOffset = offsetMs(zone, right);
    if (rightOffset !== leftOffset) {
      locate(zone, left, leftOffset, right, rightOffset, (low, lowOffset, high, highOffset) => {
        const jump = highOffset - lowOffset;
        if (jump <= 0 || wallMs + jump < DAY_MS - 1000) return;
        const first = Math.floor((low + lowOffset - wallMs) / DAY_MS) - 1;
        const last = Math.floor((high + highOffset - wallMs) / DAY_MS) + 1;
        for (let day = Math.max(first, from); day <= Math.min(last, to - 1); day += 1) {
          if (localDayAt(day, wall, zone) === null) found.add(day);
        }
      });
    }
    left = right;
    leftOffset = rightOffset;
  }
  return [...found].sort((a, b) => a - b);
}

type Leaf = (low: number, lowOffset: number, high: number, highOffset: number) => void;

/** Halve `[low, high]` down to a day around each change of offset; `visit` each such day. */
function locate(
  zone: TimeZone,
  low: number,
  lowOffset: number,
  high: number,
  highOffset: number,
  visit: Leaf,
): void {
  if (high - low <= DAY_MS) {
    visit(low, lowOffset, high, highOffset);
    return;
  }
  const mid = low + Math.floor((high - low) / 2);
  const midOffset = offsetMs(zone, mid);
  if (midOffset !== lowOffset) locate(zone, low, lowOffset, mid, midOffset, visit);
  if (highOffset !== midOffset) locate(zone, mid, midOffset, high, highOffset, visit);
}
