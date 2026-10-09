// The refusals of the pending → attached move (`promoteAttachment`, `releaseQuarantine`): a key
// still in quarantine, a key that is not a pending upload, and one an earlier call already moved.
// Their codes are registered with the rest of the package's in `errors.ts`.

import { StorageError } from './errors';

/**
 * A key still under the quarantine prefix. The framework never scans bytes — that is the app's
 * job — so the only thing it can enforce is that nothing leaves quarantine without the app
 * saying so, which is what `promoteAttachment` refusing this key means.
 */
export const quarantined = (key: string, orgId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_QUARANTINED',
    cause: `"${key}" is still under the quarantine prefix, so nothing has cleared it for use`,
    fix: `scan the bytes, then releaseQuarantine({ disk, key: '${key}', orgId: '${orgId}' }) — promote the key it returns`,
    meta: { key, orgId },
  });

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
    fix: `const row = await findRowByStorageKey('${attachedKey}') — answer that row instead of inserting one, and never delete '${attachedKey}' on a failure of your own: it belongs to that row`,
    meta: { key, attachedKey, orgId },
  });
