/**
 * Where an org's export file comes back in: the CSV `posts.export` wrote, uploaded IN PARTS — an
 * org's whole history is the one file in Postly big enough that a phone on a train must resume it
 * from the last part, not from byte 0, and past 5 GiB a single PUT is refused by S3 outright.
 *
 * Two keys, both `@ultimat3/storage`'s construction under the ACTOR's org. The session's is
 * `org/<orgId>/pending/<importId>.csv`: no target, because the app's `uploadScanner` refuses one
 * (`X_STORAGE_TARGET_UNSCANNED`). `completePostsImport` then promotes the assembled file — scanned —
 * to `org/<orgId>/imports/posts/<importId>/<importId>.csv`, the prefix `posts.import` holds its
 * `key` to, so the import job reads exactly what was scanned and nothing another org owns.
 */

import { t } from '@ultimat3/action';
import { assert } from '@ultimat3/core';
import type { AttachmentTarget } from '@ultimat3/storage';
import { uploadPolicy } from '@ultimat3/storage';

/** CSV only, and generous: a decade of an org's writing, with room to spare. */
export const postsImportPolicy = uploadPolicy({
  maxBytes: 8 * 1024 * 1024 * 1024,
  allowedContentTypes: ['text/csv'],
});

/** `org/<orgId>/imports/posts/<importId>/…`: the import job's own prefix. */
export const postsImportTarget = (importId: string): AttachmentTarget => ({
  entity: 'imports',
  id: 'posts',
  field: importId,
});

/** One open session, as every call after the grant names it. Held to the org by the policy. */
export const ImportSession = t.object({
  orgId: t.uuid,
  key: t.string.max(512),
  uploadId: t.string.min(1).max(1024),
});

/** A session's key: the import id IS the upload's opaque name (`grantPostsImport`'s `uploadId`). */
const SESSION_KEY = /^org\/([0-9a-f-]{36})\/pending\/([0-9a-f-]{36})\.csv$/;

/** A posts import still in flight: an open session, or an assembled file the scanner holds. */
export const isPostsImportUpload = (key: string): boolean =>
  /^org\/[^/]+\/pending\/[0-9a-f-]{36}\.csv$/.test(key);

/**
 * Any org's posts-import file, session or held upload: what `purgeImports` may sweep, and nothing
 * beside it — an avatar waiting under `pending/` is an image, never a `.csv`.
 */
export const isPostsImportKey = (key: string): boolean =>
  /^org\/[^/]+\/imports\/posts\//.test(key) || isPostsImportUpload(key);

/**
 * The import id a session's key was minted with. A key of another shape never reaches the queue:
 * `grantPostsImport` is the only thing that mints one, so another shape is a forged call.
 */
export function importIdOf(orgId: string, key: string): string {
  const match = SESSION_KEY.exec(key);
  const importId = match?.[2];
  assert(
    match?.[1] === orgId && importId !== undefined,
    'the session key is not one grantPostsImport minted for this org',
    'grantPostsImport({ orgId, filename, contentType, size })   # and complete the key it answers',
  );
  return importId;
}
