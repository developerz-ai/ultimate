// Single responsibility: business-day arithmetic on CALENDAR DAYS — epoch day numbers, no zone and
// no `Intl`. A weekday is `day mod 7`, a run of whole weeks is multiplication, and a holiday is a
// sorted number searched in O(log n): what lets a 30-year span cost what a week did.

import { holidaySet } from './holidays';

export const DAY_MS = 86_400_000;

/** 1970-01-01, epoch day 0, was a Thursday: ISO weekday 4. */
const EPOCH_WEEKDAY = 4;

/** ISO weekday (1 = Monday … 7 = Sunday) of an epoch day, for any sign. */
export function weekdayOfDay(day: number): number {
  return ((((day + EPOCH_WEEKDAY - 1) % 7) + 7) % 7) + 1;
}

/** The epoch day a UTC midnight epoch names. */
export function dayOfEpoch(epochMs: number): number {
  return Math.round(epochMs / DAY_MS);
}

/**
 * `isWorkday[weekday]` for ISO weekdays 1–7, from the weekend list exactly as `includes` reads it:
 * a stray entry (`0`, `8`) matches no weekday, as it never did.
 */
export function workdayTable(weekend: readonly number[]): readonly boolean[] {
  const table = [false];
  for (let weekday = 1; weekday <= 7; weekday += 1) table.push(!weekend.includes(weekday));
  return table;
}

/** Workdays among the epoch days `[from, to)`: whole weeks multiplied, the remainder walked. */
export function workdaysIn(from: number, to: number, isWorkday: readonly boolean[]): number {
  if (to <= from) return 0;
  const perWeek = isWorkday.filter(Boolean).length;
  const weeks = Math.floor((to - from) / 7);
  let count = weeks * perWeek;
  for (let day = from + weeks * 7; day < to; day += 1) {
    if (isWorkday[weekdayOfDay(day)]) count += 1;
  }
  return count;
}

/**
 * The distance `t >= 1` from `origin` (in `step`'s direction) of its `k`th workday, `k >= 1`.
 * The table holds at least one workday — the caller refused an all-weekend calendar first.
 */
export function nthWorkday(
  origin: number,
  k: number,
  step: 1 | -1,
  isWorkday: readonly boolean[],
): number {
  const perWeek = isWorkday.filter(Boolean).length;
  const weeks = Math.floor((k - 1) / perWeek);
  let remaining = k - weeks * perWeek;
  let distance = weeks * 7;
  while (remaining > 0) {
    distance += 1;
    if (isWorkday[weekdayOfDay(origin + step * distance)]) remaining -= 1;
  }
  return distance;
}

/** `isoDateInZone`'s spelling of an epoch day: the form a calendar's holidays are written in. */
export function isoOfDay(day: number): string {
  const at = new Date(day * DAY_MS);
  const pad2 = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`;
}

const ISO_DAY = /^(\d{4,})-(\d{2})-(\d{2})$/;

/** Holiday epoch days, sorted, per holiday SET — `holidaySet` returns one set per list. */
const holidayDayMemo = new WeakMap<ReadonlySet<string>, readonly number[]>();

/**
 * A calendar's holidays as sorted epoch days. A string is kept only when it round-trips through
 * `isoOfDay` — exactly the strings the per-day walk could ever have matched, so `2026-02-30` and
 * `2026-3-1` stay the no-ops they always were rather than rolling onto a real day.
 */
export function holidayDays(holidays: readonly string[] | undefined): readonly number[] {
  const set = holidaySet(holidays);
  const hit = holidayDayMemo.get(set);
  if (hit !== undefined) return hit;
  const days: number[] = [];
  for (const iso of set) {
    const match = typeof iso === 'string' ? ISO_DAY.exec(iso) : null;
    if (match === null) continue;
    const at = new Date(0);
    at.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const day = dayOfEpoch(at.getTime());
    if (isoOfDay(day) === iso) days.push(day);
  }
  days.sort((left, right) => left - right);
  holidayDayMemo.set(set, days);
  return days;
}

/** The first index in a sorted list whose value is `>= value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** How many values of a sorted list lie in `[from, to)`. */
export function countIn(sorted: readonly number[], from: number, to: number): number {
  return to <= from ? 0 : lowerBound(sorted, to) - lowerBound(sorted, from);
}
