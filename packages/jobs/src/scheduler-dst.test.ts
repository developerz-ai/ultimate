// What the framework ANSWERS at a DST transition, pinned against a real IANA zone and the real
// `@ultimat3/time` resolver — the scheduler's other tests use a deterministic stand-in, which by
// construction cannot see this.
//
// `tz` is non-optional and IANA-validated precisely so this question has an answer, and until now
// nothing said which answer. Both cases matter and only one is obvious:
//
//   FALL BACK — 02:00 happens twice in wall-clock terms. If the resolver returned both instants
//   the scheduler would mint two occurrence keys (`dispatch` keys on `occurrenceMs`, which
//   genuinely differs), the idempotency key would NOT collapse them, and the nightly digest would
//   go out twice. That is exactly the failure a required `tz` exists to prevent.
//
//   SPRING FORWARD — 02:00 does not exist. The choice is to skip the day or to shift.

import { describe, expect, test } from 'bun:test';
import { instant, nextCronOccurrence } from '@ultimat3/time';
import { createMemoryDriver } from './driver-memory';
import { createScheduler } from './scheduler';

const TZ = 'Europe/Berlin';

/** The scheduler's own walk: occurrences in `(after, until]`, driven by the real resolver. */
function occurrences(cron: string, fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let cursor = new Date(fromIso);
  const until = new Date(toIso).getTime();
  for (let i = 0; i < 10; i += 1) {
    const next = nextCronOccurrence(cron, TZ, instant(cursor));
    if (next.getTime() <= cursor.getTime() || next.getTime() > until) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

const localTime = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'long',
    hour12: false,
  }).format(new Date(iso));

describe('a daily cron across a DST transition', () => {
  test('FALL BACK: the repeated hour fires ONCE, not twice', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:00 local occurs twice. The framework's
    // answer is ONE occurrence per calendar day — the first valid instant — so the digest goes
    // out once. Two instants here would be two occurrence keys and two dispatches.
    const due = occurrences('0 2 * * *', '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z');

    expect(due).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-26T01:00:00.000Z']);
    expect(localTime(due[0] ?? '')).toContain('25/10/2026, 02:00:00 CEST');
    // The second is the NEXT day, at 02:00 CET — never the repeated 02:00 CET of the 25th.
    expect(localTime(due[1] ?? '')).toContain('26/10/2026, 02:00:00 CET');
  });

  test('SPRING FORWARD: the missing hour SHIFTS, it is not skipped', () => {
    // 2026-03-29: 02:00 local does not exist. The framework fires at the first instant on or
    // after it — 03:00 CEST — rather than dropping the day. A skipped day would be a nightly
    // billing run that silently never happened, which is strictly worse than one an hour late.
    const due = occurrences('0 2 * * *', '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z');

    expect(due).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-30T00:00:00.000Z']);
    expect(localTime(due[0] ?? '')).toContain('29/03/2026, 03:00:00 CEST');
    expect(localTime(due[1] ?? '')).toContain('30/03/2026, 02:00:00 CEST');
  });

  test('the scheduler resolves through the same path, so the answer is not test-only', () => {
    const scheduler = createScheduler({ driver: createMemoryDriver() });
    const next = scheduler.nextRunFor(
      { cron: '0 2 * * *', tz: TZ } as Parameters<typeof scheduler.nextRunFor>[0],
      new Date('2026-03-28T12:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });
});
