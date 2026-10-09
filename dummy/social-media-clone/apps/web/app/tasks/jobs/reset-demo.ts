// `resetDemo`, the tasks slice's job — one primitive per file, the layout `x g` writes.
//
// The two jobs the schedule enqueues. Work lives HERE and never in a `task`: a task runs on the
// scheduler, which is single-instance and unretried, so anything that can fail belongs on the queue.
//
// Both keys derive from `input` alone. A key that read the clock would make every retry of the same
// occurrence a brand-new job, which is the one bug `idempotencyKey` exists to delete.

import { logger } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';
import { DemoResetUnsafeError } from '../errors';
import { instant } from '../instant';
import { missingDemoMarkers, restoreSeededGraph } from '../repo';

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
    //
    // The store is asked, not the environment. `DATABASE_URL is set` was the old test, and it
    // stopped meaning "not the demo" the day the demo got a database of its own
    // (packages/db/src/client.ts) — it would have dead-lettered this job on every occurrence.
    const missing = await missingDemoMarkers();
    if (missing.length > 0) throw new DemoResetUnsafeError({ missing });

    const purged = await restoreSeededGraph();
    logger.info('tasks.demo.reset', {
      occurrence: input.occurrence,
      purged: Object.fromEntries(purged.map((entry) => [entry.table, entry.removed])),
    });
    return { purged };
  },
});
