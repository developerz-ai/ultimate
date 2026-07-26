import { describe, expect, test } from 'bun:test';
import { fromIso, toIso } from './instant';
import { nextLocalSlot, nextLocalSlots } from './schedule';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';

describe('nextLocalSlot', () => {
  test('sends at 09:00 local, whatever that is in UTC', () => {
    const now = fromIso('2026-03-14T08:00:00Z'); // 09:00 Berlin, 04:00 New York
    expect(toIso(nextLocalSlot({ zone: BERLIN, hour: 9 }, now))).toBe('2026-03-15T08:00:00.000Z');
    expect(toIso(nextLocalSlot({ zone: NEW_YORK, hour: 9 }, now))).toBe('2026-03-14T13:00:00.000Z');
  });

  test('09:00 stays 09:00 local across spring forward', () => {
    const before = fromIso('2026-03-28T09:00:00Z'); // 10:00 Berlin, day before the change
    const slots = nextLocalSlots({ zone: BERLIN, hour: 9 }, before, 2);
    expect(slots.map((slot) => toZoned(slot, BERLIN).hour)).toEqual([9, 9]);
    expect(slots.map(toIso)).toEqual([
      '2026-03-29T07:00:00.000Z', // CEST: 09:00 local is 07:00Z
      '2026-03-30T07:00:00.000Z',
    ]);
  });

  test('a slot inside the DST gap resolves forward instead of vanishing', () => {
    // 02:30 local does not exist on 2026-03-29 in Berlin.
    const at = nextLocalSlot(
      { zone: BERLIN, hour: 2, minute: 30 },
      fromIso('2026-03-29T00:00:00Z'),
    );
    expect(toIso(at)).toBe('2026-03-29T01:30:00.000Z');
    expect(toZoned(at, BERLIN).hour).toBe(3);
  });

  test('is always strictly in the future', () => {
    const now = fromIso('2026-03-14T08:00:00Z');
    const next = nextLocalSlot({ zone: BERLIN, hour: 9 }, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});
