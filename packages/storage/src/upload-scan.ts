// Single responsibility: the scan step of `promoteAttachment` — the installed `UploadScanner` asked
// about a per-ATTEMPT copy of the upload, and its four outcomes: clean (the attempt is what gets
// attached), infected (attempt and upload deleted, refused), hold (attempt deleted, upload kept,
// refused until cleared) and no verdict (as hold, unless the policy accepts unscanned).

import { assert, renderThrowable } from '@ultimat3/core';
import type { StorageDriver, StorageObject } from './driver';
import { scanUnavailable, uploadHeld, uploadInfected } from './errors-scan';
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
  /** The confirmed upload's etag; `''` when its disk keeps none, and the bytes are hashed instead. */
  readonly revision: string;
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

/** `sha256:<hex>` of the attempt, streamed: the revision of an upload whose disk keeps no etag. */
async function digestOf(disk: StorageDriver, attempt: StorageObject): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const body = await disk.stream(attempt.key);
  for await (const chunk of body) hasher.update(chunk);
  return `sha256:${hasher.digest('hex')}`;
}

/** True when a scanner is installed — `promoteAttachment` stages an attempt copy only then. */
export const scanning = (): boolean => uploadScanner() !== undefined;

/**
 * Stream the attempt — pinned to its etag where it has one — to the installed scanner. Returns on
 * clean (or no verdict under `onScanUnavailable: 'accept'`); every refusal deletes the attempt, and
 * infected deletes the upload too; hold keeps it pending. The stream is cancelled however the scanner returns: one that
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
    const revision = input.revision === '' ? await digestOf(disk, attempt) : input.revision;
    body = await disk.stream(attempt.key, attempt.etag === '' ? undefined : { etag: attempt.etag });
    verdict = await scanner.scan({
      key: attempt.key,
      pendingKey: input.pendingKey,
      revision,
      size: attempt.size,
      contentType: attempt.contentType,
      body,
    });
  } catch (error) {
    // A holding scanner's outage is never a pass: it may be the store that knows what is held.
    if (input.policy.onScanUnavailable === 'accept' && scanner.holds !== true) return;
    // The attempt goes, the upload stays: a retry once the scanner is back is a fresh confirm.
    await removeAll(disk, [attempt.key]);
    throw scanUnavailable(input.pendingKey, scanner.name, renderThrowable(error));
  } finally {
    await body?.cancel().catch(() => undefined);
  }
  if (verdict.verdict === 'clean') return;
  if (verdict.verdict === 'hold') {
    // A decision, not an outage: no `onScanUnavailable` reaches here. The upload is what a later
    // confirm promotes; the attempt was this call's.
    await removeAll(disk, [attempt.key]);
    assert(
      scanner.holds === true,
      `the ${scanner.name} upload scanner answered hold without declaring holds: true, so its outages would have been promoted unscanned under onScanUnavailable: 'accept'`,
      'uploadScanner: { ...yourScanner, holds: true }   # in apps/<app>/runtime.ts',
    );
    throw uploadHeld(input.pendingKey, scanner.name, verdict.reason);
  }
  const removed = await removeAll(disk, [attempt.key, input.pendingKey]);
  throw uploadInfected(input.pendingKey, scanner.name, verdict.signature, removed);
}
