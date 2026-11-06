// `completePostsImport`, the posts slice's action — one primitive per file, the layout `x g` writes.

import { memberOf } from '@postly/core';
import { action, t } from '@ultimat3/action';
import { completeUpload, disk } from '@ultimat3/storage';
import { ImportSession, importIdOf, postsImportPolicy } from '../import-upload';
import { importPosts } from '../jobs/import-posts';
import { postImport } from '../policy';

/**
 * Assemble the parts, then queue `posts.import` on the file they made, in this request's
 * transaction: a completed upload nothing imports is a bill, and an import of a file not yet
 * assembled reads nothing. The etags are the disk's own (`completeUpload` lists them), so no
 * bucket CORS has to expose `ETag` to the browser. The restored posts are the caller's drafts.
 */
export const completePostsImport = action({
  input: ImportSession.extend({
    parts: t.array(t.object({ partNumber: t.number.int().min(1), etag: t.string.optional() }), {
      min: 1,
      max: 10_000,
    }),
  }).refine({
    name: 'key-is-a-posts-import',
    message: 'key must be one grantPostsImport minted: org/<orgId>/imports/posts/<importId>/<name>',
    check: ({ orgId, key }) => key.startsWith(`org/${orgId}/imports/posts/`) && !key.includes('..'),
    path: ['key'],
  }),
  output: t.object({ importId: t.uuid, key: t.string, size: t.number.int() }),
  policy: postImport,
  async handle({ input, ctx }) {
    const { orgId, key, uploadId, parts } = input;
    const stored = await completeUpload({
      disk: disk(),
      orgId,
      key,
      uploadId,
      parts,
      policy: postsImportPolicy,
    });
    const importId = importIdOf(orgId, key);
    // `postImport` passed, so the actor is a member of `orgId`: the restored drafts are theirs.
    const authorId = memberOf(ctx.actor)?.memberId ?? ctx.actor.id;
    await importPosts.enqueue({ orgId, importId, authorId, key });
    return { importId, key, size: stored.size };
  },
});
