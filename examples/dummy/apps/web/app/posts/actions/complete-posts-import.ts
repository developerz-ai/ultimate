// `completePostsImport`, the posts slice's action — one primitive per file, the layout `x g` writes.

import { memberOf } from '@postly/core';
import { action, t } from '@ultimat3/action';
import { completeUpload, disk, promoteAttachment } from '@ultimat3/storage';
import {
  ImportSession,
  importIdOf,
  isPostsImportUpload,
  postsImportPolicy,
  postsImportTarget,
} from '../import-upload';
import { importPosts } from '../jobs/import-posts';
import { postImport } from '../policy';

/**
 * Assemble the parts, promote the file they made — SCANNED by the app's `uploadScanner` — then
 * queue `posts.import` on it, in this request's transaction: a completed upload nothing imports is
 * a bill, and an import of a file not yet assembled reads nothing. The etags are the disk's own
 * (`completeUpload` lists them), so no bucket CORS has to expose `ETag` to the browser. The
 * restored posts are the caller's drafts.
 *
 * A large file goes to the malware sandbox and is HELD: `X_STORAGE_QUARANTINED`, the assembled
 * file kept under `pending/`. The client sends this same call again; the parts are already
 * assembled, so the retry skips straight to the promotion, which answers once the sandbox has.
 */
export const completePostsImport = action({
  input: ImportSession.extend({
    parts: t.array(t.object({ partNumber: t.number.int().min(1), etag: t.string.optional() }), {
      min: 1,
      max: 10_000,
    }),
  }).refine({
    name: 'key-is-a-posts-import',
    message: 'key must be one grantPostsImport minted: org/<orgId>/pending/<importId>.csv',
    check: ({ orgId, key }) => key.startsWith(`org/${orgId}/`) && isPostsImportUpload(key),
    path: ['key'],
  }),
  output: t.object({ importId: t.uuid, key: t.string, size: t.number.int() }),
  policy: postImport,
  async handle({ input, ctx }) {
    const { orgId, key, uploadId, parts } = input;
    const importId = importIdOf(orgId, key);
    // Assembled by an earlier call that the scanner held: the session is gone, the file is not.
    if ((await disk().stat(key)) === undefined) {
      await completeUpload({
        disk: disk(),
        orgId,
        key,
        uploadId,
        parts,
        policy: postsImportPolicy,
      });
    }
    const stored = await promoteAttachment({
      disk: disk(),
      key,
      orgId,
      target: postsImportTarget(importId),
      policy: postsImportPolicy,
    });
    // `postImport` passed, so the actor is a member of `orgId`: the restored drafts are theirs.
    const authorId = memberOf(ctx.actor)?.memberId ?? ctx.actor.id;
    await importPosts.enqueue({ orgId, importId, authorId, key: stored.key });
    return { importId, key: stored.key, size: stored.size };
  },
});
