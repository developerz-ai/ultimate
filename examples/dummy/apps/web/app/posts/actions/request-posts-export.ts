// `requestPostsExport`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { action, t } from '@ultimat3/action';
import { exportPosts, postsExportPrefix } from '../jobs/export-posts';
import { postExport } from '../policy';

/**
 * Start an export of every post in the org. The work is `exportPosts`, a job, enqueued in this
 * request's transaction; the answer is where the artifact will land — `manifest.json` under
 * `prefix` once the job has written it. The id is minted here, so one request is one artifact and
 * a retried request (same idempotency key) is the same one.
 */
export const requestPostsExport = action({
  input: t.object({ orgId: t.uuid }),
  output: t.object({ exportId: t.uuid, prefix: t.string }),
  policy: postExport,
  idempotent: true,
  mcp: { expose: true, description: 'Export every post of the actor’s org as CSV to storage' },
  async handle({ input }) {
    const target = { orgId: input.orgId, exportId: crypto.randomUUID() };
    await exportPosts.enqueue(target);
    return { exportId: target.exportId, prefix: postsExportPrefix(target) };
  },
});
