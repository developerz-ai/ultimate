// `hourlyLikes`, the posts slice's task — one primitive per file, the layout `x g` writes.
//
// A task only enqueues. Both jobs carry a fixed idempotency key, so a tick that fires while the
// last run is still going is that same run, and a late tick recomputes the same window.

import { task } from '@ultimat3/jobs';
import { dailyLikesRollup } from '../jobs/daily-likes';
import { likeTotalsRefresh } from '../jobs/like-totals';

/** Hourly, off the top of the hour the purge and the digest share. `tz` is named, never implied. */
export const hourlyLikes = task({
  cron: '20 * * * *',
  tz: 'UTC',
  enqueue: () => [
    [dailyLikesRollup, {}],
    [likeTotalsRefresh, {}],
  ],
});
