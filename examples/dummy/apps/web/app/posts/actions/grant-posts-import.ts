// `grantPostsImport`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The first of the five calls `@ultimat3/storage`'s `uploadFile({ multipart })` makes for a large
// file: open the session. The bytes then go straight to the disk, part by part — never through here.

import { action, t } from '@ultimat3/action';
import { disk, grantMultipart } from '@ultimat3/storage';
import { postsImportPolicy } from '../import-upload';
import { postImport } from '../policy';

/**
 * An upload session for one org's export file: refused before it opens for a type or a size the
 * policy refuses, the key built from the org the policy just held to the actor. Not an MCP tool —
 * an agent cannot hold the bytes a session is for, as `grantAvatarUpload` says.
 */
export const grantPostsImport = action({
  input: t.object({
    orgId: t.uuid,
    /** Used for its extension and nothing else — the stored name is opaque. */
    filename: t.string.max(255),
    contentType: t.string.max(255),
    size: t.number.int().min(1),
  }),
  output: t.object({
    importId: t.uuid,
    key: t.string,
    uploadId: t.string,
    partBytes: t.number.int(),
    maxParts: t.number.int(),
    contentType: t.string,
    size: t.number.int(),
    expiresAt: t.number.int(),
  }),
  policy: postImport,
  async handle({ input, ctx }) {
    const importId = crypto.randomUUID();
    const grant = await grantMultipart({
      disk: disk(),
      orgId: input.orgId,
      // `.csv` whatever the browser named it — the policy admits `text/csv` alone — so the session
      // key is `org/<orgId>/pending/<importId>.csv`, the shape `importIdOf` reads the id back from.
      request: { filename: 'posts.csv', contentType: input.contentType, size: input.size },
      policy: postsImportPolicy,
      // No `target`: the app's `uploadScanner` refuses one. `completePostsImport` promotes it.
      uploadId: () => importId,
      clock: ctx.clock,
    });
    return { importId, ...grant };
  },
});
