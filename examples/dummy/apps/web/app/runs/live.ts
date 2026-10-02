/**
 * The runs feature's reads. `liveRunEvents` is `live: true`: a row the job writes reaches every
 * open console over the page's one socket, with the policy evaluated per subscriber.
 *
 * Ordered by `seq` and bounded, with `id` last so the order is total — the live matcher places a
 * row by this list alone.
 *
 * `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.
 */

import type { RunEvent } from '@postly/db';
import { from, query, t } from '@ultimat3/query';
import { CONNECTION_PAGE, type ConnectionView } from './entity';
import { canRunRead } from './policy';
import * as repo from './repo';

/** More events than one run writes; the bound a live read is required to state. */
const EVENT_LIMIT = 200;

export const liveRunEvents = query({
  input: t.object({
    orgId: t.uuid,
    runId: t.uuid,
    limit: t.number.int().min(1).max(EVENT_LIMIT).default(EVENT_LIMIT),
  }),
  policy: canRunRead,
  live: true,
  // The relation this read is patched from: `x db gen` reads it to emit the replica identity a
  // live query needs, and the first subscribe checks it against the resolved shape.
  subscribes: ['run_events'],
  mcp: { expose: true, description: 'One run’s events in order: what it did and what it waits on' },
  sql: ({ orgId, runId, limit }) =>
    from<RunEvent>('run_events', () => repo.eventsOf(runId, limit))
      .where({ orgId, runId })
      .orderBy('seq')
      .orderBy('id')
      .limit(limit),
});

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
