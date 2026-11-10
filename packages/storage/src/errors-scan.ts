// The two refusals of a scanned promotion (`upload-scan.ts`): the scanner said infected, or the
// scanner could not say. Their codes are registered with the rest of the package's in `errors.ts`.

import { renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

/** Never retryable with the same bytes, and never overridable by a policy: they are deleted. */
export const uploadInfected = (
  key: string,
  scanner: string,
  signature: string,
  removed: boolean,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_UPLOAD_INFECTED',
    cause: `the ${scanner} upload scanner found "${signature}" in "${key}"; ${
      removed
        ? 'the pending upload and its scan copy were deleted'
        : 'deleting it failed, so sweepOrphans will collect what is left under pending/'
    }`,
    fix: 'grantUpload({ disk, orgId, request }) for a new, clean file — this one is refused for good',
    meta: { key, scanner, signature, removed },
  });

/**
 * The scanner rejected rather than answered. `reason` is already rendered (`renderThrowable`): a
 * daemon's own words are the most useful thing in the cause, and an `unknown` is never interpolated.
 */
export const scanUnavailable = (key: string, scanner: string, reason: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_SCAN_UNAVAILABLE',
    cause: `the ${scanner} upload scanner gave no verdict for "${key}": ${reason}`,
    fix: `promoteAttachment({ disk, key: ${renderFixLiteral(key, "'<pending key>'")}, orgId, target, policy })   # again once the ${scanner} scanner answers — the upload is still pending; or uploadPolicy({ onScanUnavailable: 'accept' }) to promote unscanned files`,
    meta: { key, scanner },
  });
