// `nextTaskRun` is the scheduler's own resolver, readable without a scheduler: the "next fire" a
// dashboard shows is the instant the leader would dispatch at, in the task's zone.

import { describe, expect, test } from 'bun:test';
import { nextTaskRun } from './scheduler-occurrences';

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
