// `sweepOrphanMedia`, the tasks slice's job — one primitive per file, the layout `x g` writes.
//
// The two jobs the schedule enqueues. Work lives HERE and never in a `task`: a task runs on the
// scheduler, which is single-instance and unretried, so anything that can fail belongs on the queue.
//
// Both keys derive from `input` alone. A key that read the clock would make every retry of the same
// occurrence a brand-new job, which is the one bug `idempotencyKey` exists to delete.

import { logger } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';
import { instant } from '../instant';
import { markOrphan, pendingMediaBefore, SWEEP_PAGE } from '../repo';

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
