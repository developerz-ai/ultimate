// The two jobs the schedule enqueues. Work lives HERE and never in a `task`: a task runs on the
// scheduler, which is single-instance and unretried, so anything that can fail belongs on the queue.
//
// Both keys derive from `input` alone. A key that read the clock would make every retry of the same
// occurrence a brand-new job, which is the one bug `idempotencyKey` exists to delete.

import { logger } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';
import { DemoResetUnsafeError } from './errors';
import { markOrphan, pendingMediaBefore, restoreSeededGraph, SWEEP_PAGE } from './repo';

/**
 * An instant on the wire is an ISO-8601 string, not a `Date`. The queue round-trips input through
 * JSON, so a `Date` input would reach `idempotencyKeyFor` as a `Date` on the enqueue side and as a
 * string on the replay side — two spellings of one key, which is no key at all.
 */
const instant = t.string;

/**
 * The cutoff is INPUT, computed by the task from the occurrence it is firing for — never read from
 * the clock in here. A catch-up dispatch runs long after the instant it fires for, and a job that
 * asked `Date.now()` would sweep the wrong hour and dedupe against the wrong key.
 */
export const sweepOrphanMedia = job({
  input: t.object({ before: instant }),
  idempotencyKey: (input) => `media-sweep:${input.before}`,
  /**
   * There is no tenant to declare: visibility here is relational (friendships and blocks), so no
   * entity in this app carries a tenant column and the guard that `'none'` fails closed against
   * never fires. `crossTenant()` would be a lie about a sweep that crosses nothing — and it refuses
   * an actor without `tenancy:cross`, which no worker context in the framework mints.
   */
  tenant: 'none',
  retry: { attempts: 5, backoff: 'exponential', delay: '10s' },
  async run({ input }) {
    const stale = await pendingMediaBefore(new Date(input.before), SWEEP_PAGE);
    // Convergent: `markOrphan` SETS the state, so a replay over rows it already collected writes
    // the same value rather than transitioning them a second time.
    for (const row of stale) await markOrphan(row.id);
    logger.info('tasks.media.sweep', {
      before: input.before,
      collected: stale.length,
      // Truthful when the page filled up: the next occurrence takes the next page.
      bounded: stale.length === SWEEP_PAGE,
    });
    return { collected: stale.length, keys: stale.map((row) => row.key) };
  },
});

/**
 * Restore the public demo. `occurrence` is in the input for one reason: it is what makes the key
 * distinguish one hour's reset from the next while a retry of THIS hour deduplicates.
 */
export const resetDemo = job({
  input: t.object({ occurrence: instant }),
  idempotencyKey: (input) => `demo-reset:${input.occurrence}`,
  /** Same reason as the sweep above: this app has no tenant column, and a reset owns every row. */
  tenant: 'none',
  // One attempt more than a transient blip needs, and no more: a reset that keeps failing should
  // dead-letter loudly rather than delete the demo four more times.
  retry: { attempts: 3, backoff: 'exponential', delay: '30s' },
  async run({ input }) {
    // Checked in the job, not in the task: a task only enqueues, and the guard has to hold for a
    // manual `resetDemo.enqueue(...)` and a backfill exactly as it does for the cron.
    const boundTo = 'DATABASE_URL';
    if ((Bun.env[boundTo] ?? '') !== '') throw new DemoResetUnsafeError({ boundTo });

    const purged = await restoreSeededGraph();
    logger.info('tasks.demo.reset', {
      occurrence: input.occurrence,
      purged: Object.fromEntries(purged.map((entry) => [entry.table, entry.removed])),
    });
    return { purged };
  },
});
