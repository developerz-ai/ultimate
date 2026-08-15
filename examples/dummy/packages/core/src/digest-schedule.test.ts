/**
 * unit — no DB, no I/O. The DST transitions are the specification: each case below is a bug that
 * shipped in some other product because someone added 24 hours to a timestamp.
 */

import { expect, test } from 'bun:test';
import {
  localDateIn,
  nextDigestAt,
  previousDigestAt,
  scheduleByOrgAndZone,
} from './digest-schedule';

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

test('Madrid: the window before the spring-forward slot is 23 hours, not 24', () => {
  // The slot after the transition, and the slot before it. 24h back from 07:00Z is 07:00Z on the
  // 28th — an hour BEFORE that day's 08:00Z digest, so every post in that hour ships twice.
  const slot = at('2026-03-29T07:00:00.000Z');
  const since = previousDigestAt(slot, 'Europe/Madrid');

  expect(since.toISOString()).toBe('2026-03-28T08:00:00.000Z');
  expect((slot.getTime() - since.getTime()) / 3_600_000).toBe(23);
});

test('Auckland: the window before an autumn-back slot is 25 hours, not 24', () => {
  // The mirror image: 24h back stops an hour SHORT of the previous slot, so that hour of posts
  // reaches no digest at all.
  // 09:00 on 2026-04-05, the day the clocks went back — NZST (+12). The slot before it is NZDT.
  const slot = at('2026-04-04T21:00:00.000Z');
  const since = previousDigestAt(slot, 'Pacific/Auckland');

  expect(since.toISOString()).toBe('2026-04-03T20:00:00.000Z');
  expect((slot.getTime() - since.getTime()) / 3_600_000).toBe(25);
  expect(nextDigestAt(since, 'Pacific/Auckland').toISOString()).toBe(slot.toISOString());
});

test('the window closes exactly where the previous slot opened, in a zone with no DST', () => {
  const slot = at('2026-07-02T00:00:00.000Z'); // 09:00 in Tokyo
  const since = previousDigestAt(slot, 'Asia/Tokyo');

  expect(since.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  // The slot `nextDigestAt` answers FROM that instant is this one: no gap, no overlap.
  expect(nextDigestAt(since, 'Asia/Tokyo').toISOString()).toBe(slot.toISOString());
});

test('the local date is the member’s date, not the server’s', () => {
  // One instant, two members, two different "today"s — which is why the digest's idempotency
  // key is keyed on the member's local date and never on a UTC day.
  expect(localDateIn(at('2026-03-09T02:00:00.000Z'), 'America/New_York')).toBe('2026-03-08');
  expect(localDateIn(at('2026-03-09T01:00:00.000Z'), 'Asia/Tokyo')).toBe('2026-03-09');
});

test('members are grouped by (org, zone), and the slot is the zone’s', () => {
  const groups = scheduleByOrgAndZone(
    [
      { orgId: 'tinta', tz: 'Europe/Madrid', id: 'bruno' },
      { orgId: 'tinta', tz: 'Asia/Tokyo', id: 'kenji' },
      { orgId: 'tinta', tz: 'Europe/Madrid', id: 'ada' },
    ],
    at('2026-03-28T09:30:00.000Z'),
  );

  expect(groups.map((group) => group.zone)).toEqual(['Europe/Madrid', 'Asia/Tokyo']);
  expect(groups[0]?.members).toHaveLength(2);
  expect(groups[1]?.at.toISOString()).toBe('2026-03-29T00:00:00.000Z');
});

test('one zone across two orgs is two groups, because the post window is org-scoped', () => {
  const groups = scheduleByOrgAndZone(
    [
      { orgId: 'tinta', tz: 'Europe/Madrid', id: 'bruno' },
      { orgId: 'nube', tz: 'Europe/Madrid', id: 'ada' },
      { orgId: 'tinta', tz: 'Europe/Madrid', id: 'kenji' },
    ],
    at('2026-03-28T09:30:00.000Z'),
  );

  expect(groups.map((group) => group.orgId)).toEqual(['tinta', 'nube']);
  expect(groups[0]?.members.map((member) => member.id)).toEqual(['bruno', 'kenji']);
  // One zone, so one calculation — and both groups fire at the same instant, DST included.
  expect(groups[0]?.at).toBe(groups[1]?.at as Date);
});
