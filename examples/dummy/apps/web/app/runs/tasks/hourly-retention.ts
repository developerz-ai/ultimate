// `hourlyRetention`, the runs slice's task — one primitive per file, the layout `x g` writes.
// A task only enqueues; the sweeps are `purgeRetained`'s and `purgeImports`', at the framework's own
// purge minute.

import { DEFAULT_PURGE_CRON, task } from '@ultimat3/jobs';
import { purgeImports } from '../../posts/jobs/purge-imports';
import { purgeRetained } from '../jobs/purge-retained';

export const hourlyRetention = task({
  cron: DEFAULT_PURGE_CRON,
  tz: 'UTC',
  enqueue: () => [
    [purgeRetained, {}],
    [purgeImports, {}],
  ],
});
