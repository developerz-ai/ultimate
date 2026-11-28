// `cancelPostsExport`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
import { PostsExportNotFound } from '../errors';
import { cancelExportJob, EXPORT_JOB_STATES } from '../export-job';
import { postExport } from '../policy';

/**
 * Stop an export `requestPostsExport` started, while it is queued or running. Answers the state
 * it now stands in — `cancelled`, or how it had already ended. Who may cancel is `postExport`, the
 * right that started it; an id the org does not own is `X_POSTS_EXPORT_NOT_FOUND`, as a missing one.
 */
export const cancelPostsExport = action({
  input: t.object({ orgId: t.uuid, jobId: t.uuid }),
  output: t.object({ jobId: t.uuid, state: t.enumerated(...EXPORT_JOB_STATES) }),
  policy: postExport,
  // Closed: the one refusal a caller branches on — see `publishPost`.
  errors: [PostsExportNotFound.code],
  mcp: {
    expose: true,
    description: 'Cancel a posts export of the actor’s org that has not finished',
  },
  async handle({ input, ctx }) {
    const status = await cancelExportJob(input.orgId, input.jobId, ctx.actor.id);
    return { jobId: status.id, state: status.state };
  },
});
