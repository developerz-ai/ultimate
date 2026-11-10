// The three refusals of a scanned promotion (`upload-scan.ts`): the scanner said infected, said
// hold, or could not say. Their codes are registered with the rest of the package's in `errors.ts`.

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

/**
 * The scanner answered `hold`: a decision made outside this call (a review, an async vendor scan)
 * has not cleared the upload yet. It keeps the code the retired `quarantine: true` flow raised —
 * the same state, a 409 — now reached through the one scan path. `reason` is the scanner's string.
 */
export const uploadHeld = (key: string, scanner: string, reason: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_QUARANTINED',
    cause: `the ${scanner} upload scanner is holding "${key}" (${reason}); the upload stays pending and nothing was attached`,
    fix: `promoteAttachment({ disk, key: ${renderFixLiteral(key, "'<pending key>'")}, orgId, target, policy })   # again once your ${scanner} scanner answers clean for this pendingKey — sweepOrphans collects it if it never does`,
    meta: { key, scanner, reason },
  });

/**
 * A grant aimed straight at a row's key while a scanner is installed. That key never passes through
 * `promoteAttachment`, the one place a scan runs, so signing it would land bytes nothing scanned
 * exactly where a row reads them.
 */
export const targetUnscanned = (caller: string, key: string, scanner: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TARGET_UNSCANNED',
    cause: `${caller} was given a target ("${key}") while the ${scanner} upload scanner is installed; a targeted key never passes through promoteAttachment, so its bytes would reach the row unscanned`,
    fix: `${caller}({ disk, orgId, request, policy })   # no target — then promoteAttachment({ disk, key, orgId, target, policy }) once the upload lands`,
    meta: { key, scanner },
  });
