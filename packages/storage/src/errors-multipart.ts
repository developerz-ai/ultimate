// The refusals of an upload in parts. Registered with the rest of the package's codes in
// `errors.ts`; each `fix:` names the call that goes next, with the key and upload id screened.

import { renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

const keyArg = (key: string): string => renderFixLiteral(key, "'<key>'");
const idArg = (uploadId: string): string => renderFixLiteral(uploadId, "'<uploadId>'");

/** A disk whose driver declares no `multipart`: a third-party driver, most likely. */
export const multipartUnsupported = (disk: string, key: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_MULTIPART_UNSUPPORTED',
    cause: `the ${disk} disk's driver declares no multipart capability, so "${key}" cannot be uploaded in parts`,
    fix: 'grantUpload({ disk, orgId, request })   # one PUT; or implement StorageDriver.multipart on the driver',
    meta: { disk, key },
  });

/** No open session by that id for that key: never opened, completed, or aborted. */
export const uploadUnknown = (disk: string, key: string, uploadId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_UPLOAD_UNKNOWN',
    cause: `no upload ${idArg(uploadId)} is open for "${key}" on the ${disk} disk: it was never opened there, or it was already completed or aborted`,
    fix: 'grantMultipart({ disk, orgId, request })   # a new session, then send every part under its uploadId',
    meta: { disk, key, uploadId },
  });

/** The parts a Complete named do not match what the disk holds. */
export const partsInvalid = (key: string, uploadId: string, problem: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_PARTS_INVALID',
    cause: `the parts named to complete "${key}" do not match the parts stored: ${problem}`,
    fix: `await listParts({ disk, orgId, key: ${keyArg(key)}, uploadId: ${idArg(uploadId)} })   # what landed; resend the missing part, then completeUpload again`,
    meta: { key, uploadId, problem },
  });
