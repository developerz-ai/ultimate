/**
 * Every `retain` the schema declares, kept: `run_events` past ninety days and `posts_history` past
 * its own window go, one batched, cross-tenant delete per table. `entities: 'declared'` reads the
 * declarations at each pass, so a new `retain` needs no line here — and without this job, `x verify`
 * refuses each one (`X_ENTITY_RETAIN_UNSWEPT`). `runs/tasks/hourly-retention.ts` fires it.
 */

import { purge } from '@ultimat3/jobs';

export const purgeRetained = purge({ name: 'postly.retain.purge', entities: 'declared' });
