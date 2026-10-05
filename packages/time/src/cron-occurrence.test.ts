import { describe, expect, test } from 'bun:test';
import {
  firedSince,
  matchesCron,
  nextCronOccurrence,
  nextCronOccurrenceMs,
  nextCronOccurrences,
} from './cron-occurrence';
import { type CronExpression, parseCron } from './cron-parse';
import { fromIso, toIso } from './instant';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const UTC = 'UTC';

describe('nextCronOccurrence', () => {
  test('basic daily schedule in UTC', () => {
    const next = nextCronOccurrence('0 3 * * *', UTC, fromIso('2026-03-14T04:00:00Z'));
    expect(toIso(next)).toBe('2026-03-15T03:00:00.000Z');
  });

  test('*/15 steps within the hour', () => {
    const times = nextCronOccurrences('*/15 * * * *', UTC, fromIso('2026-03-14T09:07:00Z'), 3);
    expect(times.map(toIso)).toEqual([
      '2026-03-14T09:15:00.000Z',
      '2026-03-14T09:30:00.000Z',
      '2026-03-14T09:45:00.000Z',
    ]);
  });

  test('weekday-only schedule skips the weekend', () => {
    // 2026-03-14 is a Saturday.
    const next = nextCronOccurrence('0 9 * * MON-FRI', UTC, fromIso('2026-03-14T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-16T09:00:00.000Z');
  });

  test('a wrapping stepped weekday range fires on the days it names, and no others', () => {
    // 2026-03-14 is a Saturday. `sat-tue/2` is Saturday and Monday; a task on this schedule used
    // to fire on Sunday and Tuesday instead, every week, because the stride walked an 8-day week.
    const times = nextCronOccurrences('0 3 * * sat-tue/2', UTC, fromIso('2026-03-14T00:00:00Z'), 4);
    expect(times.map(toIso)).toEqual([
      '2026-03-14T03:00:00.000Z', // Saturday
      '2026-03-16T03:00:00.000Z', // Monday
      '2026-03-21T03:00:00.000Z', // Saturday
      '2026-03-23T03:00:00.000Z', // Monday
    ]);
  });

  test('day-of-month and day-of-week OR together (Vixie semantics)', () => {
    // "1st of the month OR any Monday" — both restricted means either matches.
    const next = nextCronOccurrence('0 0 1 * MON', UTC, fromIso('2026-03-14T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-16T00:00:00.000Z'); // the Monday comes first
  });

  // T9. This used to be answered by exhausting the 200,000-step budget: ~150 ms of blocking CPU
  // per call, and `firedSince` — the scheduler leader loop's entry point — pays it every tick.
  // The day/month combination is decidable from the parsed fields alone.
  test('an unmatchable date is refused at PARSE time, having walked no steps at all', () => {
    const refused = errorOf(() =>
      nextCronOccurrence('0 0 30 2 *', UTC, fromIso('2026-03-14T00:00:00Z')),
    );
    expect(refused.code).toBe('X_CRON_INVALID');
    // The cause names the combination rather than the budget: a search that ran out of steps says
    // nothing about WHY, and "30" and "february" are the two words a reader needs.
    expect(String(refused.cause)).toContain('february');
    expect(String(refused.cause)).not.toContain('search steps');

    // WHICH refusal arrived is the step count, and that is why nothing here is timed. This used to
    // assert `performance.now()` under 20 ms: measured on this repo, the same call is 3.2 ms at
    // worst idle and 21.3 ms at worst under eight `bun test` workers, so the bound separated a
    // loaded box from an unloaded one and never the walk from the parse. `UNMATCHABLE_PAST_THE_PARSER`
    // is the identical field set handed in already parsed, so `parseCronOnce` has nothing left to
    // check — it walks, and the test below pins that it dies on the budget. Landing on the parse
    // refusal here instead of that one is what says no step was taken.
    expect(String(refused.cause)).toContain('never occurs in');
  });

  test('the search budget still guards the walk it was written for', () => {
    // The backstop, exercised on the one input that can still reach it: fields the parser would
    // have refused, assembled behind it. Untouched by the parse-time check above — MAX_STEPS stays
    // the answer for anything that check cannot see. The count is pinned on purpose: a budget
    // quietly lowered is a far-future schedule that stops resolving, which is the assertion under
    // this one.
    const exhausted = errorOf(() =>
      nextCronOccurrence(UNMATCHABLE_PAST_THE_PARSER, UTC, fromIso('2026-03-14T00:00:00Z')),
    );
    expect(exhausted.code).toBe('X_CRON_INVALID');
    expect(String(exhausted.cause)).toContain('200000 search steps');
    // And a schedule that CAN fire is untouched by either refusal.
    expect(toIso(nextCronOccurrence('0 0 29 2 *', UTC, fromIso('2026-03-14T00:00:00Z')))).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

/**
 * The 30th of February, past the one place that can refuse it. Every field comes from the real
 * parser — only `months` is moved, from a January the day exists in to a February it never does —
 * so this is the same expression the test above hands in as a string, minus the parse.
 */
const UNMATCHABLE_PAST_THE_PARSER: CronExpression = {
  ...parseCron('0 0 30 1 *'),
  source: '0 0 30 2 *',
  months: [2],
};

describe('nextCronOccurrence across a DST boundary', () => {
  // Europe/Berlin springs forward 2026-03-29 at 02:00 local (01:00Z).
  test('0 3 * * * stays at 03:00 local on both sides of the change', () => {
    const times = nextCronOccurrences('0 3 * * *', BERLIN, fromIso('2026-03-28T00:00:00Z'), 3);
    expect(times.map((at) => toZoned(at, BERLIN).hour)).toEqual([3, 3, 3]);
    // The UTC hour moves because the offset did — that is the whole point.
    expect(times.map(toIso)).toEqual([
      '2026-03-28T02:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T01:00:00.000Z',
    ]);
  });

  test('a job scheduled inside the gap still runs that day', () => {
    // 02:00 local does not exist on 2026-03-29; it must not be silently skipped.
    const next = nextCronOccurrence('0 2 * * *', BERLIN, fromIso('2026-03-29T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-29T01:00:00.000Z');
    expect(toZoned(next, BERLIN).hour).toBe(3);
  });

  test('and stays at 03:00 local across the autumn fall-back too', () => {
    // Berlin falls back 2026-10-25 at 03:00 local (01:00Z).
    const times = nextCronOccurrences('0 3 * * *', BERLIN, fromIso('2026-10-24T00:00:00Z'), 3);
    expect(times.map((at) => toZoned(at, BERLIN).hour)).toEqual([3, 3, 3]);
    expect(times.map(toIso)).toEqual([
      '2026-10-24T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-26T02:00:00.000Z',
    ]);
  });
});

describe('matchesCron', () => {
  test('matches on the zone wall clock, not UTC', () => {
    const at = fromIso('2026-03-14T02:00:00Z'); // 03:00 in Berlin
    expect(matchesCron('0 3 * * *', at, BERLIN)).toBe(true);
    expect(matchesCron('0 3 * * *', at, UTC)).toBe(false);
  });
});

describe('firedSince', () => {
  test('is true only when an occurrence falls inside the half-open window', () => {
    const since = fromIso('2026-03-14T02:30:00Z');
    expect(firedSince('0 3 * * *', UTC, since, fromIso('2026-03-14T03:00:00Z'))).toBe(true);
    expect(firedSince('0 3 * * *', UTC, since, fromIso('2026-03-14T02:59:00Z'))).toBe(false);
    // An empty or reversed window never fires, whatever the expression.
    expect(firedSince('* * * * *', UTC, since, since)).toBe(false);
    expect(firedSince('* * * * *', UTC, since, fromIso('2026-03-14T02:00:00Z'))).toBe(false);
  });
});

describe('nextCronOccurrenceMs', () => {
  test('takes and returns epoch milliseconds for callers that only have a number', () => {
    const afterMs = Date.UTC(2026, 2, 14, 4, 0, 0);
    expect(nextCronOccurrenceMs('0 3 * * *', UTC, afterMs)).toBe(Date.UTC(2026, 2, 15, 3, 0, 0));
  });
});

function errorOf(run: () => unknown): { code?: unknown; cause?: unknown } {
  try {
    run();
  } catch (error) {
    return error as { code?: unknown; cause?: unknown };
  }
  return { code: 'no-throw', cause: 'no-throw' };
}

describe('the repeated hour of a fall-back night', () => {
  // Berlin, 2026-10-25: 03:00 CEST becomes 02:00 CET at 01:00Z, so 02:00–02:59 local happens twice
  // — 00:00Z–00:59Z and again 01:00Z–01:59Z.
  test('an interval schedule fires through BOTH passes — twelve times in 01:00Z–02:00Z', () => {
    const times = nextCronOccurrences('*/5 * * * *', BERLIN, fromIso('2026-10-25T00:50:00Z'), 14);
    expect(times.map(toIso)).toEqual([
      '2026-10-25T00:55:00.000Z',
      ...Array.from(
        { length: 12 },
        (_, index) => `2026-10-25T01:${String(index * 5).padStart(2, '0')}:00.000Z`,
      ),
      '2026-10-25T02:00:00.000Z',
    ]);
    const second = times.filter(
      (at) => toIso(at) >= '2026-10-25T01:00:00.000Z' && toIso(at) < '2026-10-25T02:00:00.000Z',
    );
    expect(second).toHaveLength(12);
    for (const at of times) expect(matchesCron('*/5 * * * *', at, BERLIN)).toBe(true);
  });

  test('every instant matchesCron accepts in that night is one the walk returns', () => {
    const from = fromIso('2026-10-24T23:00:00Z').getTime();
    const matched: string[] = [];
    for (let ms = from + 60_000; ms <= from + 4 * 3_600_000; ms += 60_000) {
      const at = fromIso(new Date(ms).toISOString());
      if (matchesCron('*/5 * * * *', at, BERLIN)) matched.push(toIso(at));
    }
    const walked = nextCronOccurrences('*/5 * * * *', BERLIN, fromIso('2026-10-24T23:00:00Z'), 48);
    expect(walked.map(toIso)).toEqual(matched);
  });

  test('asked from INSIDE the second pass, the answer is the next instant of that pass', () => {
    const next = nextCronOccurrence('*/5 * * * *', BERLIN, fromIso('2026-10-25T01:32:00Z'));
    expect(toIso(next)).toBe('2026-10-25T01:35:00.000Z');
  });

  test('an hourly schedule runs every real hour', () => {
    const times = nextCronOccurrences('0 * * * *', BERLIN, fromIso('2026-10-24T22:30:00Z'), 4);
    expect(times.map(toIso)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
  });

  test('a fixed-time schedule still fires ONCE, whichever instant it is asked from', () => {
    // `30 2 * * *` names one moment a day. The second 02:30 (01:30Z) is never an occurrence — not
    // walking from the first, and not when asked from inside the second pass, which is what the
    // scheduler's bisection does.
    for (const from of ['2026-10-25T00:30:00Z', '2026-10-25T00:45:00Z', '2026-10-25T01:10:00Z']) {
      const next = nextCronOccurrence('30 2 * * *', BERLIN, fromIso(from));
      expect(toIso(next)).toBe('2026-10-26T01:30:00.000Z');
    }
  });

  test('the answer never moves backwards as the instant asked from moves forwards', () => {
    for (const cron of ['*/5 * * * *', '30 2 * * *', '*/20 2 * * *', '0 */2 * * *']) {
      let previous = 0;
      const start = fromIso('2026-10-24T23:30:00Z').getTime();
      for (let ms = start; ms <= start + 4 * 3_600_000; ms += 7 * 60_000) {
        const at = fromIso(new Date(ms).toISOString());
        const next = nextCronOccurrence(cron, BERLIN, at).getTime();
        expect(next).toBeGreaterThan(ms);
        expect(next).toBeGreaterThanOrEqual(previous);
        previous = next;
      }
    }
  });

  test('a half-hour fall-back repeats its half hour too', () => {
    // Lord Howe falls back 30 minutes: 2026-04-05 02:00 LHDT (+11) becomes 01:30 LHST (+10:30) at
    // 2026-04-04T15:00Z, so 01:30–01:59 local happens twice.
    const times = nextCronOccurrences(
      '*/10 * * * *',
      'Australia/Lord_Howe',
      fromIso('2026-04-04T14:45:00Z'),
      5,
    );
    expect(times.map(toIso)).toEqual([
      '2026-04-04T14:50:00.000Z',
      '2026-04-04T15:00:00.000Z',
      '2026-04-04T15:10:00.000Z',
      '2026-04-04T15:20:00.000Z',
      '2026-04-04T15:30:00.000Z',
    ]);
  });
});

// `count` bounds a loop. Unscreened, `NaN` failed `index < count` at once and answered `[]` — "no
// occurrences" — `2.5` ran three times, and `Infinity` never stopped pushing.
describe('nextCronOccurrences refuses a count that is not a whole number', () => {
  const after = fromIso('2026-03-14T00:00:00Z');
  const codeOf = (count: number): string => {
    try {
      nextCronOccurrences('0 3 * * *', UTC, after, count);
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
    return 'no-throw';
  };

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1])('%p is refused', (count) => {
    expect(codeOf(count)).toBe('X_INVARIANT');
  });

  test('zero is an empty answer, a whole count is that many', () => {
    expect(nextCronOccurrences('0 3 * * *', UTC, after, 0)).toEqual([]);
    expect(nextCronOccurrences('0 3 * * *', UTC, after, 2)).toHaveLength(2);
  });
});
