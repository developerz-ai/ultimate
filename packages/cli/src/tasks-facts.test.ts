// The pure layer behind `x tasks`, driven against `@ultimat3/jobs`'s real registries — a `task()`
// handle enqueuing a real `job()` — so a DST or flag-parsing regression fails here, with no CLI
// parsing, no app load and no rendering in the loop.

import { afterEach, describe, expect, test } from 'bun:test';
import { job, resetJobs, resetTasks, t, task } from '@ultimat3/jobs';
import type { CronPhrases } from '@ultimat3/time';
import {
  findTaskHandle,
  knownTaskNames,
  listTaskFacts,
  parseCountFlag,
  taskShowFacts,
} from './tasks-facts';
import { thrownBy } from './thrown-by';

/** The same words `cmd-tasks.ts` reads out of `cli.cron.*`, spelled out here so this file stays
 * a test of the cron math and not of the catalog — `cmd-tasks.test.ts` covers that wiring. */
const EN: CronPhrases = {
  everyMinute: 'every minute',
  everyNMinutes: 'every {n} minutes',
  everyHour: 'every hour',
  everyNHours: 'every {n} hours',
  at: 'at {time}',
  andMore: 'and {n} more',
  onDaysOfMonth: 'on day {days} of the month',
  onWeekdays: 'on {days}',
  inMonths: 'in {months}',
  everyDay: 'every day',
};

/** A trivial real job — the point is that `task()` enqueues an actual `JobHandle`, not a stub. */
function pingJob(name = 'ping') {
  return job({
    name,
    input: t.object({}),
    idempotencyKey: () => name,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
}

afterEach(() => {
  resetTasks();
  resetJobs();
});

describe('unit · listTaskFacts', () => {
  test("one fact per task, next rendered ISO-8601 in the task's own zone across a DST boundary", () => {
    // Built once and captured by the closure — this test calls `listTaskFacts` (and therefore
    // `describe()`/`entries()`) twice, and `job()` refuses a second registration of one name.
    const notify = pingJob();
    task({
      name: 'nightlyPing',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      enqueue: () => [[notify, {}]],
    });

    // Two days before America/New_York springs forward (2026-03-08T07:00Z / 02:00 local).
    const beforeDst = Date.parse('2026-03-06T00:00:00Z');
    const before = listTaskFacts(beforeDst);
    expect(before).toHaveLength(1);
    const fact = before[0];
    expect(fact?.kind).toBe('task');
    expect(fact?.name).toBe('nightlyPing');
    expect(fact?.cron).toBe('0 3 * * *');
    expect(fact?.tz).toBe('America/New_York');
    expect(fact?.catchUp).toBe('skip');
    expect(fact?.maxCatchUp).toBe(10);
    expect(fact?.jobs).toEqual(['ping']);
    // Still EST (-05:00): 03:00 local on 2026-03-06 is 08:00Z.
    expect(fact?.nextMs).toBe(Date.parse('2026-03-06T08:00:00Z'));
    expect(fact?.next).toBe('2026-03-06T03:00:00-05:00');

    // Asking again from just after the spring-forward instant: the wall-clock target is still
    // 03:00 local, but a correct answer must flip the rendered offset to EDT — an ambient or
    // hardcoded UTC offset would not, and that is exactly the regression this pins.
    const afterDst = Date.parse('2026-03-08T12:00:00Z');
    const after = listTaskFacts(afterDst);
    expect(after[0]?.nextMs).toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(after[0]?.next).toBe('2026-03-09T03:00:00-04:00');
  });

  test('jobs is the empty list, never a placeholder, when a task enqueues nothing', () => {
    task({ name: 'noop', cron: '* * * * *', tz: 'UTC', enqueue: () => [] });
    const facts = listTaskFacts(Date.parse('2026-01-01T00:00:00Z'));
    expect(facts[0]?.jobs).toEqual([]);
  });
});

describe('unit · taskShowFacts', () => {
  test('N upcoming occurrences across the same DST boundary, plus the human cron phrase', () => {
    const notify = pingJob();
    task({
      name: 'nightlyPing',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      enqueue: () => [[notify, {}]],
    });
    const handle = findTaskHandle('nightlyPing');
    expect(handle).toBeDefined();
    if (handle === undefined) return;

    const facts = taskShowFacts(handle, Date.parse('2026-03-06T00:00:00Z'), 5, EN);
    expect(facts.descriptor.name).toBe('nightlyPing');
    expect(facts.upcoming).toHaveLength(5);
    expect(facts.upcoming.map((occurrence) => occurrence.at)).toEqual([
      '2026-03-06T03:00:00-05:00',
      '2026-03-07T03:00:00-05:00',
      '2026-03-08T03:00:00-04:00',
      '2026-03-09T03:00:00-04:00',
      '2026-03-10T03:00:00-04:00',
    ]);
    expect(facts.upcoming.map((occurrence) => occurrence.ms)).toEqual([
      Date.parse('2026-03-06T08:00:00Z'),
      Date.parse('2026-03-07T08:00:00Z'),
      Date.parse('2026-03-08T07:00:00Z'),
      Date.parse('2026-03-09T07:00:00Z'),
      Date.parse('2026-03-10T07:00:00Z'),
    ]);
    expect(facts.describe).toBe('at 03:00 every day');
  });

  test('count clamps the number of occurrences returned', () => {
    task({ name: 'everyMinute', cron: '* * * * *', tz: 'UTC', enqueue: () => [] });
    const handle = findTaskHandle('everyMinute');
    if (handle === undefined) return expect.unreachable('task registered above');
    expect(taskShowFacts(handle, 0, 1, EN).upcoming).toHaveLength(1);
    expect(taskShowFacts(handle, 0, 3, EN).upcoming).toHaveLength(3);
  });

  test('the phrase comes from the vocabulary passed in, never from a table in this module', () => {
    task({ name: 'nightly', cron: '0 3 * * *', tz: 'UTC', enqueue: () => [] });
    const handle = findTaskHandle('nightly');
    if (handle === undefined) return expect.unreachable('task registered above');
    const de: CronPhrases = { ...EN, at: 'um {time}', everyDay: 'täglich' };
    expect(taskShowFacts(handle, 0, 1, de).describe).toBe('um 03:00 täglich');
  });
});

describe('unit · knownTaskNames and findTaskHandle', () => {
  test('names come back sorted, and an unregistered name is undefined', () => {
    task({ name: 'bTask', cron: '* * * * *', tz: 'UTC', enqueue: () => [] });
    task({ name: 'aTask', cron: '* * * * *', tz: 'UTC', enqueue: () => [] });
    expect(knownTaskNames()).toEqual(['aTask', 'bTask']);
    expect(findTaskHandle('aTask')?.name).toBe('aTask');
    expect(findTaskHandle('nope')).toBeUndefined();
  });
});

describe('unit · parseCountFlag', () => {
  test('undefined defaults to 5', () => {
    expect(parseCountFlag(undefined)).toBe(5);
  });

  test('a value above 50 clamps down to 50', () => {
    expect(parseCountFlag('999')).toBe(50);
  });

  test('a value from 1 to 50 passes through unchanged', () => {
    expect(parseCountFlag('7')).toBe(7);
    expect(parseCountFlag('1')).toBe(1);
    expect(parseCountFlag('50')).toBe(50);
  });

  test('anything that is not a positive integer throws X_CLI_BAD_FLAG', () => {
    for (const bad of ['0', '-1', '3.5', 'abc', '', ' ', '1e5']) {
      const thrown = thrownBy(() => parseCountFlag(bad));
      expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    }
  });
});
