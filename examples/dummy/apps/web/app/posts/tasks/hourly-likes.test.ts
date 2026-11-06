// `hourlyLikes` enqueues the rollup and the view refresh, in that order, on every tick — and
// nothing else: the work is the jobs', and a task that did it would have no retry and no trace.

import { expect, test } from 'bun:test';
import { dailyLikesRollup } from '../jobs/daily-likes';
import { likeTotalsRefresh } from '../jobs/like-totals';
import { hourlyLikes } from './hourly-likes';

test('one tick enqueues the rollup and the refresh, hourly at :20 UTC', () => {
  expect(hourlyLikes.describe()).toMatchObject({ cron: '20 * * * *', tz: 'UTC' });
  expect(hourlyLikes.entries(Date.parse('2026-03-04T06:20:00.000Z'))).toEqual([
    [dailyLikesRollup, {}],
    [likeTotalsRefresh, {}],
  ]);
});
