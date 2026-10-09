// `hourlyPurge`, the api slice's task — one primitive per file, the layout `x g` writes.
//
// Scheduled triggers. A task only enqueues — if it does work, it is a job. The `scheduler` role
// is a single instance elected by a Postgres advisory lock; a missed tick fires late rather than
// being skipped, and the job's idempotency key absorbs a double fire during handover.

import { DEFAULT_PURGE_CRON, task } from '@ultimat3/jobs';
import { purgeMcpConfirmations } from '../jobs/purge-mcp-confirmations';

/**
 * The retention sweep, hourly at the framework's own minute (`DEFAULT_PURGE_CRON`). The job's key
 * is fixed, so a tick that fires while the last pass is still running is that same pass.
 */
export const hourlyPurge = task({
  cron: DEFAULT_PURGE_CRON,
  tz: 'UTC',
  enqueue: () => [[purgeMcpConfirmations, {}]],
});
