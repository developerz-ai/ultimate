/**
 * Scheduled triggers. A task only enqueues — if it does work, it is a job. The `scheduler` role
 * is a single instance elected by a Postgres advisory lock; a missed tick fires late rather than
 * being skipped, and the job's idempotency key absorbs a double fire during handover.
 */

import { localDateIn } from '@postly/core';
import { task } from '@ultimat3/jobs';
import { sendDigest } from '../app/digest/jobs';

/**
 * Fires once, in UTC, before any member's 09:00 — the fan-out then schedules each member for
 * their own local morning. The cron `tz` is explicit because "server time" is not a timezone.
 *
 * `runDate` is the UTC date of the OCCURRENCE the scheduler handed in, never the wall clock:
 * "fires late rather than skipped" is exactly the case where the two disagree, and reading the
 * clock there would date the 03:00 digest to the following day. `sendDigest` keys off `input`
 * alone, so that wrong date becomes a wrong idempotency key that nothing downstream catches.
 */
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: (occurrenceMs) => [
    [sendDigest, { runDate: localDateIn(new Date(occurrenceMs), 'UTC') }],
  ],
});
