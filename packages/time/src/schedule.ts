/**
 * "Send at 09:00 local" — the scheduling primitive digests, reminders and drip campaigns
 * are built from. Local means the *recipient's* local, and it survives DST.
 */

import { scheduleInvalid, timezoneInvalid } from './errors';
import type { Instant } from './instant';
import { fromZoned, toZoned } from './zoned';
import { assertTimeZone, type TimeZone } from './zones';

export interface LocalSlot {
  zone: TimeZone;
  /** 0–23, wall clock in `zone`. */
  hour: number;
  /** 0–59. */
  minute?: number;
  second?: number;
}

/**
 * Next instant matching the local `HH:mm` in `zone`, strictly after `after`.
 *
 * Walks forward day by day on the *local* calendar rather than adding 86 400 000 ms, so
 * a 23- or 25-hour day does not shift the slot. If the slot falls in a spring-forward
 * gap, `{ gap: 'next' }` picks the first existing local time instead of skipping the day.
 */
/** Wall-clock fields are never wrapped or clamped — a shifted schedule beats no schedule. */
function assertWallField(field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw scheduleInvalid(field, value, `an integer 0-${String(max)}`);
  }
}

export function nextLocalSlot(slot: LocalSlot, after: Instant): Instant {
  assertTimeZone(slot.zone);
  assertWallField('slot.hour', slot.hour, 23);
  const minute = slot.minute ?? 0;
  const second = slot.second ?? 0;
  // Validated too: a minute of 90 would otherwise roll into the next hour and ship a
  // schedule an hour off, which is exactly the class of bug this package exists to prevent.
  assertWallField('slot.minute', minute, 59);
  assertWallField('slot.second', second, 59);
  const start = toZoned(after, slot.zone);

  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    const candidate = fromZoned(
      {
        year: start.year,
        month: start.month,
        day: start.day + dayOffset,
        hour: slot.hour,
        minute,
        second,
      },
      slot.zone,
      { gap: 'next', overlap: 'first' },
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  // Four local days always contain the slot; reaching here means the zone data is broken.
  throw timezoneInvalid(slot.zone);
}

/** The next `count` daily slots — a preview for the schedule screen. */
export function nextLocalSlots(slot: LocalSlot, after: Instant, count: number): Instant[] {
  const slots: Instant[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    cursor = nextLocalSlot(slot, cursor);
    slots.push(cursor);
  }
  return slots;
}

export interface WeeklySlot extends LocalSlot {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

/** Next `weekday` at the local time, strictly after `after`. */
export function nextWeeklySlot(slot: WeeklySlot, after: Instant): Instant {
  let cursor = after;
  for (let index = 0; index < 8; index += 1) {
    const candidate = nextLocalSlot(slot, cursor);
    if (toZoned(candidate, slot.zone).weekday === slot.weekday) return candidate;
    cursor = candidate;
  }
  throw timezoneInvalid(slot.zone);
}
