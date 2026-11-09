// `nextTaskRun` is the scheduler's own resolver, readable without a scheduler: the "next fire" a
// dashboard shows is the instant the leader would dispatch at, in the task's zone.

import { describe, expect, test } from 'bun:test';
import { nextTaskRun, occurrencesIn } from './scheduler-occurrences';
import { task } from './task';

describe('nextTaskRun', () => {
  test('is strictly after `from`, on the task zone’s wall clock', () => {
    const from = new Date('2026-10-01T10:00:00.000Z');
    // 09:00 in Bogotá is 14:00 UTC; in UTC it would already have passed today.
    expect(nextTaskRun({ cron: '0 9 * * *', tz: 'America/Bogota' }, from).toISOString()).toBe(
      '2026-10-01T14:00:00.000Z',
    );
    expect(nextTaskRun({ cron: '0 9 * * *', tz: 'UTC' }, from).toISOString()).toBe(
      '2026-10-02T09:00:00.000Z',
    );
  });
});

describe('occurrencesIn', () => {
  test('a catch-up walk stops AT maxCatchUp, never one over it', () => {
    const everyMinute = task({
      name: 'catchUpCeiling',
      cron: '* * * * *',
      tz: 'UTC',
      maxCatchUp: 3,
      enqueue: () => [],
    });
    const after = Date.parse('2026-10-01T10:00:00.000Z');
    // Ten minutes missed; the walk is truncated to the declared three, the first three.
    const next = (handle: typeof everyMinute, from = new Date(after)): Date =>
      nextTaskRun(handle, from);
    const due = occurrencesIn(next, everyMinute, after, after + 10 * 60_000);
    expect(due.map((ms) => new Date(ms).toISOString())).toEqual([
      '2026-10-01T10:01:00.000Z',
      '2026-10-01T10:02:00.000Z',
      '2026-10-01T10:03:00.000Z',
    ]);
  });
});
