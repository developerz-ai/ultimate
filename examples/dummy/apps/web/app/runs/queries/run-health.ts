// `runHealth`, the runs slice's query for `/runs/health` — one primitive per file, the layout
// `x g` writes. Not live: the page is a server-rendered snapshot, and a refresh is the update.
// `since`/`until` are the window the page's `TimeRangePicker` holds in the URL, half-open.
//
// Ordered by `startedAt` and bounded, with `id` last so the order is total; `(orgId, startedAt)`
// is the index the plan sweep reads it through.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { RUN_HEALTH_PAGE, type RunHealthView } from '../entity';
import { canRunRead } from '../policy';
import * as repo from '../repo';

/** The org's newest runs in a window: what ended how, when, and how much each one did. */
export const runHealth = query({
  input: t.object({ orgId: t.uuid, since: t.date, until: t.date }),
  policy: canRunRead,
  sql: ({ orgId, since, until }) =>
    from<RunHealthView & { readonly orgId: string }>('runs', async () =>
      (await repo.runsBetween(since, until, RUN_HEALTH_PAGE)).map((row) => ({
        id: row.id,
        orgId: row.orgId,
        connectionId: row.connectionId,
        status: row.status,
        startedAt: row.startedAt,
        eventCount: row.eventCount,
      })),
    )
      .where({ orgId })
      .orderBy('startedAt', 'desc')
      .orderBy('id')
      .limit(RUN_HEALTH_PAGE),
});
