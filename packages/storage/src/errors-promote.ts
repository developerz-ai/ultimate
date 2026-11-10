// The refusals of the pending → attached move (`promoteAttachment`): a key that is not a pending
// upload, one an earlier call already moved, and one that changed while it was moved. A scanner's
// refusals are `errors-scan.ts`'s.
// Their codes are registered with the rest of the package's in `errors.ts`.

import { renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

/**
 * A key inside the org and outside its `pending/` prefix — most often another row's attached key
 * a client sent back. Promotion copies then deletes, so accepting it moved the victim's file onto
 * this row and removed it from theirs.
 */
export const notPending = (key: string, orgId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_NOT_PENDING',
    cause: `"${key}" is not under org "${orgId}"'s pending/ prefix, so it is not an upload waiting for a row — it may already belong to one`,
    fix: 'promote the key grantUpload returned with no target: promoteAttachment({ disk, key: pendingKey(orgId, name), orgId, target })',
    meta: { key, orgId },
  });

/**
 * The pending key is gone and the attached one is there: an earlier call moved these bytes. Never
 * answered as a success — only the call that moved them may hand them back, because a caller's
 * cleanup of its own failed write deletes whatever key it was handed, and this one is a row's.
 */
export const alreadyPromoted = (key: string, attachedKey: string, orgId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_ALREADY_PROMOTED',
    cause: `"${key}" was already promoted to "${attachedKey}" by an earlier call (a retried or doubled confirm), so this call moved nothing`,
    fix: `await disk.stat('${attachedKey}') answers the moved object: answer the row that references that key if one exists, write it with that key if none does, and never delete the key on a failure of your own`,
    meta: { key, attachedKey, orgId },
  });

/**
 * The object is no longer the revision that was judged. A presigned PUT stays valid until it
 * expires, so an uploader can overwrite between the sniff and the copy, and what would land on the
 * row's key is bytes nothing looked at.
 */
export const objectChanged = (key: string, expected: string, actual: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_OBJECT_CHANGED',
    cause: `"${key}" changed while it was being promoted: it was judged at ${expected} and is now ${actual}`,
    fix: `promoteAttachment({ disk, key: ${renderFixLiteral(key, "'<pending key>'")}, orgId, target, policy }) once the upload has finished: it reads the object again`,
    meta: { key, expected, actual },
  });
