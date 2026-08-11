// The app's cron. A task ONLY enqueues — the payload is built here, the work happens on the queue.
//
// `tz: 'UTC'` on both, said out loud rather than inherited. `app.config.ts` has a
// `defaultTimeZone`, and leaning on it is the bug: an unzoned `0 * * * *` runs twice or zero times
// on a DST switch day, and the scheduler's occurrence key would then dedupe two different hours
// onto one. UTC has no transitions, which is the property these two want — neither is a thing a
// reader reads at a local hour.

import { task } from '@ultimat3/jobs';
import { resetDemo, sweepOrphanMedia } from './jobs';

/**
 * How long an upload may sit unclaimed before it counts as abandoned. An hour: long enough that a
 * slow client finishing an upload is never collected mid-flight, short enough that a bucket does
 * not fill with bytes no post will ever reference.
 */
const CLAIM_GRACE_MS = 60 * 60 * 1_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Hourly orphan sweep.
 *
 * `occurrenceMs`, never `Date.now()`. The two differ exactly when it matters: a tick dispatched
 * late, or replayed for an occurrence the scheduler missed, has a wall clock that no longer matches
 * the hour it is firing for — and the payload has to describe the hour, not the dispatch.
 */
export const hourlyMediaSweep = task({
  cron: '0 * * * *',
  tz: 'UTC',
  enqueue: (occurrenceMs) => [[sweepOrphanMedia, { before: iso(occurrenceMs - CLAIM_GRACE_MS) }]],
});

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
