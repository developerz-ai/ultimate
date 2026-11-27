// `postsExportStatus`, the posts slice's query — one primitive per file, the layout `x g` writes.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import { exportJobStatus } from '../export-job';
import { postExport } from '../policy';

/**
 * Where an export `requestPostsExport` started has got to: its state, attempt and progress —
 * never its input, its error or its stack. No row for an id the org does not own: another org's
 * export and an unknown id are the same empty answer. Not cached: a status is read to watch it move.
 */
export const postsExportStatus = query({
  input: t.object({ orgId: t.uuid, jobId: t.uuid }),
  policy: postExport,
  mcp: { expose: true, description: 'Read how far a posts export of the actor’s org has got' },
  sql: ({ orgId, jobId }) =>
    from('jobs', async () => {
      const status = await exportJobStatus(orgId, jobId);
      return status === undefined ? [] : [{ ...status, orgId }];
    })
      .where({ orgId, id: jobId })
      .orderBy('id')
      .limit(1),
});
