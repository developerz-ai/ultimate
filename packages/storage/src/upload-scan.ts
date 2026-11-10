// Single responsibility: the scan step of `promoteAttachment` — the installed `UploadScanner` asked
// about a per-ATTEMPT copy of the upload, and its three outcomes: clean (the attempt is what gets
// attached), infected (attempt and upload deleted, refused) and no verdict (attempt deleted,
// refused and retryable, unless the policy accepts unscanned).

import { renderThrowable } from '@ultimat3/core';
import type { StorageDriver, StorageObject } from './driver';
import { scanUnavailable, uploadInfected } from './errors-scan';
import type { UploadPolicy } from './upload';
import { uploadScanner } from './upload-scanner';

/**
 * `pending/scan/<random>-<name>`: a key of THIS confirm's own (`attachment.ts` builds it).
 * Server-named, so no presigned URL reaches it and one scan of it is final; never the row's key, so
 * a refusal deletes nothing a doubled confirm attached; inside `pending/`, so an attempt a crash
 * left behind is an orphan `sweepOrphans` collects.
 */
export const SCAN_SEGMENT = 'scan';

export interface ScanAttemptInput {
  readonly disk: StorageDriver;
  /** The upload as it was confirmed: what a refusal names and a retry promotes again. */
  readonly pendingKey: string;
  /** The attempt copy under `SCAN_SEGMENT`, already sniffed. */
  readonly attempt: StorageObject;
  readonly policy: UploadPolicy;
}

/** Deleted, or reported as not: a cleanup that fails never replaces the refusal it follows. */
async function removeAll(disk: StorageDriver, keys: readonly string[]): Promise<boolean> {
  let removed = true;
  for (const key of keys) {
    try {
      await disk.delete(key);
    } catch {
      removed = false;
    }
  }
  return removed;
}

/** True when a scanner is installed — `promoteAttachment` stages an attempt copy only then. */
export const scanning = (): boolean => uploadScanner() !== undefined;

/**
 * Stream the attempt — pinned to its etag where it has one — to the installed scanner. Returns on
 * clean (or no verdict under `onScanUnavailable: 'accept'`); every refusal deletes the attempt, and
 * infected deletes the upload too. The stream is cancelled however the scanner returns: one that
 * answers off the first chunk would otherwise hold the disk's connection open.
 */
export async function scanAttempt(input: ScanAttemptInput): Promise<void> {
  const scanner = uploadScanner();
  if (scanner === undefined) return;
  const { disk, attempt } = input;
  let body: ReadableStream<Uint8Array> | undefined;
  let verdict: Awaited<ReturnType<typeof scanner.scan>>;
  try {
    // Inside the `try`: an attempt that cannot be READ for the scanner (an S3 GET reset, an
    // etag-pinned read refused) is no verdict too, never a raw error past the cleanup.
    body = await disk.stream(attempt.key, attempt.etag === '' ? undefined : { etag: attempt.etag });
    verdict = await scanner.scan({
      key: attempt.key,
      size: attempt.size,
      contentType: attempt.contentType,
      body,
    });
  } catch (error) {
    if (input.policy.onScanUnavailable === 'accept') return;
    // The attempt goes, the upload stays: a retry once the scanner is back is a fresh confirm.
    await removeAll(disk, [attempt.key]);
    throw scanUnavailable(input.pendingKey, scanner.name, renderThrowable(error));
  } finally {
    await body?.cancel().catch(() => undefined);
  }
  if (verdict.verdict === 'clean') return;
  const removed = await removeAll(disk, [attempt.key, input.pendingKey]);
  throw uploadInfected(input.pendingKey, scanner.name, verdict.signature, removed);
}
