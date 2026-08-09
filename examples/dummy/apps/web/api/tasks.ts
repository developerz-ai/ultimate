/**
 * Scheduled triggers. A task only enqueues — if it does work, it is a job. The `scheduler` role
 * is a single instance elected by a Postgres advisory lock; a missed tick fires late rather than
 * being skipped, and the job's idempotency key absorbs a double fire during handover.
 */

import { localDateIn } from '@postly/core';
import { systemClock } from '@ultimat3/core';
import { task } from '@ultimat3/jobs';
import { sendDigest } from '../app/digest/jobs';

/**
 * Fires once, in UTC, before any member's 09:00 — the fan-out then schedules each member for
 * their own local morning. The cron `tz` is explicit because "server time" is not a timezone.
 *
 * `runDate` is the tick's own UTC calendar date, and it is why `sendDigest` takes a payload at
 * all: an idempotency key derives from `input` alone, so an empty one would make every night
 * collide with the first. Read through a `Clock`, never `Date.now()`, so a test can fire the
 * scheduler on a chosen day.
 */
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, { runDate: localDateIn(systemClock.now(), 'UTC') }]],
});
