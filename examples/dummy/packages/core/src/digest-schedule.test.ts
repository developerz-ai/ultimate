/**
 * unit — no DB, no I/O. The DST transitions are the specification: each case below is a bug that
 * shipped in some other product because someone added 24 hours to a timestamp.
 */

import { expect, test } from 'bun:test';
import { localDateIn, nextDigestAt, scheduleByZone } from './digest-schedule';

const at = (iso: string) => new Date(iso);

test('Madrid: the digest slot after spring-forward is 23 hours later, not 24', () => {
  // 2026-03-28 10:30 CET — today's 09:00 slot (08:00Z) has passed.
  const before = nextDigestAt(at('2026-03-28T09:30:00.000Z'), 'Europe/Madrid');
  expect(before.toISOString()).toBe('2026-03-29T07:00:00.000Z'); // 09:00 CEST, not 08:00Z

  const previousSlot = at('2026-03-28T08:00:00.000Z');
  const hours = (before.getTime() - previousSlot.getTime()) / 3_600_000;
  expect(hours).toBe(23);
});

test('Auckland: autumn-back moves the slot the other way — 20:00Z becomes 21:00Z', () => {
  expect(nextDigestAt(at('2026-04-03T19:00:00.000Z'), 'Pacific/Auckland').toISOString()).toBe(
    '2026-04-03T20:00:00.000Z', // 2026-04-04 09:00 NZDT (+13)
  );
  expect(nextDigestAt(at('2026-04-05T20:00:00.000Z'), 'Pacific/Auckland').toISOString()).toBe(
    '2026-04-05T21:00:00.000Z', // 2026-04-06 09:00 NZST (+12)
  );
});

test('Tokyo has no DST: the slot is 00:00Z in January and in July', () => {
  expect(nextDigestAt(at('2026-01-14T22:00:00.000Z'), 'Asia/Tokyo').toISOString()).toBe(
    '2026-01-15T00:00:00.000Z',
  );
  expect(nextDigestAt(at('2026-07-14T22:00:00.000Z'), 'Asia/Tokyo').toISOString()).toBe(
    '2026-07-15T00:00:00.000Z',
  );
});

test('the slot is strictly in the future, so a retried tick cannot double-send', () => {
  const slot = at('2026-07-01T00:00:00.000Z'); // exactly 09:00 in Tokyo
  expect(nextDigestAt(slot, 'Asia/Tokyo').toISOString()).toBe('2026-07-02T00:00:00.000Z');
});

test('the local date is the member’s date, not the server’s', () => {
  // One instant, two members, two different "today"s — which is why the digest's idempotency
  // key is keyed on the member's local date and never on a UTC day.
  expect(localDateIn(at('2026-03-09T02:00:00.000Z'), 'America/New_York')).toBe('2026-03-08');
  expect(localDateIn(at('2026-03-09T01:00:00.000Z'), 'Asia/Tokyo')).toBe('2026-03-09');
});

test('members are grouped by zone, one slot per zone', () => {
  const grouped = scheduleByZone(
    [
      { tz: 'Europe/Madrid', id: 'bruno' },
      { tz: 'Asia/Tokyo', id: 'kenji' },
      { tz: 'Europe/Madrid', id: 'ada' },
    ],
    at('2026-03-28T09:30:00.000Z'),
  );

  expect(grouped.size).toBe(2);
  expect(grouped.get('Europe/Madrid')?.members).toHaveLength(2);
  expect(grouped.get('Asia/Tokyo')?.at.toISOString()).toBe('2026-03-29T00:00:00.000Z');
});
