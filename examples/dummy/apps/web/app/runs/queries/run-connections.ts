// `runConnections`, the runs slice's query — one primitive per file, the layout `x g` writes.
//
// The runs feature's reads. `liveRunEvents` is `live: true`: a row the job writes reaches every
// open console over the page's one socket, with the policy evaluated per subscriber.
//
// Ordered by `seq` and bounded, with `id` last so the order is total — the live matcher places a
// row by this list alone.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { CONNECTION_PAGE, type ConnectionView } from '../entity';
import { canRunRead } from '../policy';
import * as repo from '../repo';

/** The connections the console can start a run on. Not live: a refetch after a write is enough. */
export const runConnections = query({
  input: t.object({ orgId: t.uuid }),
  policy: canRunRead,
  sql: ({ orgId }) =>
    from<ConnectionView & { readonly orgId: string }>('connections', async () =>
      (await repo.listConnections(CONNECTION_PAGE)).map((row) => ({
        id: row.id,
        orgId: row.orgId,
        label: row.label,
        createdAt: row.createdAt,
      })),
    )
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(CONNECTION_PAGE),
});
