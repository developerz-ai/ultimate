// `hourlyDemoReset`, the tasks slice's task — one primitive per file, the layout `x g` writes.
//
// The app's cron. A task ONLY enqueues — the payload is built here, the work happens on the queue.
//
// `tz: 'UTC'` on both, said out loud: there is no ambient zone to inherit, and an unzoned
// `0 * * * *` runs twice or zero times on a DST switch day, and the scheduler's occurrence key
// would then dedupe two different hours onto one. UTC has no transitions, which is the property these two want — neither is a thing a
// reader reads at a local hour.

import { task } from '@ultimat3/jobs';
import { iso } from '../instant';
import { resetDemo } from '../jobs/reset-demo';

/**
 * Hourly demo reset. `catchUp: 'skip'` (the default, said out loud): after an outage the demo wants
 * ONE restore at the next occurrence, not one per hour the process was down — every missed run
 * would do the identical work, so replaying them is pure deletion.
 */
export const hourlyDemoReset = task({
  cron: '30 * * * *',
  tz: 'UTC',
  catchUp: 'skip',
  enqueue: (occurrenceMs) => [[resetDemo, { occurrence: iso(occurrenceMs) }]],
});
