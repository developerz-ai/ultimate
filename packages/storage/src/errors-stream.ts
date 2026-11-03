// The refusals of the streaming calls and of a size a grant was not told. Registered with the rest
// of the package's codes in `errors.ts`; each `fix:` names the call that goes next, because these
// calls have their own option where `put()`'s refusal names the disk's ceiling.

import { describeValue, renderFixLiteral, renderThrowable } from '@ultimat3/core';
import { StorageError } from './errors';

const keyArg = (key: string): string => renderFixLiteral(key, "'<key>'");

/** A `putStream` body past the call's own `maxBytes`. Counted, so `bytes` is how far it had got. */
export const streamTooLarge = (
  disk: string,
  key: string,
  bytes: number,
  maxBytes: number,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `the stream for "${key}" passed its maxBytes of ${maxBytes}B at ${bytes}B on the ${disk} disk, so the write was abandoned and nothing was stored`,
    fix: `await disk.putStream(${keyArg(key)}, stream, { maxBytes: ${bytes * 2} })   # a higher maxBytes on the call, if a body this large is meant`,
    meta: { disk, key, bytes, maxBytes },
  });

/** `rangeUnsatisfiable` for a call that holds no size: the next step is learning it. */
export const streamRangeUnsatisfiable = (
  disk: string,
  key: string,
  range: readonly [number, number],
  size: number,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_RANGE_UNSATISFIABLE',
    cause: `streamRange() asked "${key}" for bytes ${range[0]}-${range[1]}, and the object on the ${disk} disk is ${size}B, so its first byte is past the end`,
    fix: `const { size } = await disk.stat(${keyArg(key)})   # the object's size now; any first byte below it is a window`,
    meta: { disk, key, first: range[0], last: range[1], size },
  });

/**
 * A grant with nothing to bind. A presign has one way to hold a size, the exact `Content-Length`
 * inside the signature, so "any size up to the policy" is a URL that bounds nothing.
 */
export const uploadSizeUndeclared = (key: string, size: unknown): StorageError =>
  new StorageError({
    code: 'X_STORAGE_UPLOAD_SIZE_UNDECLARED',
    cause: `the upload for "${key}" declared its size as ${describeValue(size)}, not a whole byte count of at least 1, so the URL could not bind one`,
    fix: 'grantUpload({ disk, orgId, request: { filename, contentType, size: file.size } })',
    meta: { key },
  });

/**
 * A write sent whose answer was lost, and nothing could settle what it did. Never `putFailed`: that
 * says the key is as it was, and the object may be the one sent. `X_DB_COMMIT_UNKNOWN`'s idea.
 */
export const writeOutcomeUnknown = (disk: string, key: string, lost: unknown): StorageError => {
  const reason = renderThrowable(lost);
  return new StorageError({
    code: 'X_STORAGE_WRITE_OUTCOME_UNKNOWN',
    cause: `the write of "${key}" on the ${disk} disk was sent and its answer lost (${reason}), and neither a stat nor an abort could say whether it landed`,
    fix: `await disk.stat(${keyArg(key)})   # the size and etag now at the key; the same as what was sent means it landed`,
    meta: { disk, key, reason },
  });
};
