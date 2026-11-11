/**
 * Postly's `uploadScanner` (installed by `apps/web/runtime.ts`): what `promoteAttachment` asks
 * about every upload before it becomes an avatar or an import. Small files are judged inline,
 * inside the confirm; large ones go to the malware sandbox (`./scan-sandbox.ts`) and are HELD —
 * `X_STORAGE_QUARANTINED`, the upload kept under `pending/` — until it answers.
 *
 * Which engine and where the line sits are Postly's (axiom 8). In production the inline engine is
 * the app's clamd adapter; this one is storage's EICAR reference, so a gate can prove a refusal.
 */

import { memoryUploadScanner } from '@ultimat3/storage';
import type { UploadScanner } from '@ultimat3/storage/adapter';
import { memoryScanSandbox, type ScanSandbox } from './scan-sandbox';

/**
 * Past this an inline scan holds the confirm request open too long: an avatar (2 MB) is always
 * inline, an org's posts export (up to 8 GB, `app/posts/import-upload.ts`) usually is not.
 */
export const INLINE_SCAN_MAX_BYTES = 32 * 1024 * 1024;

export interface PostlyScannerSeams {
  readonly inline?: UploadScanner | undefined;
  readonly sandbox?: ScanSandbox | undefined;
  /** Default `INLINE_SCAN_MAX_BYTES`; a test lowers it to send a small file to the sandbox. */
  readonly inlineMaxBytes?: number | undefined;
}

/**
 * `holds: true` — this scanner answers `hold`, so storage refuses its outage in every policy: a
 * sandbox Postly cannot reach cannot say a held upload was cleared.
 */
export function postlyUploadScanner(seams: PostlyScannerSeams = {}): UploadScanner {
  const inline = seams.inline ?? memoryUploadScanner();
  const sandbox = seams.sandbox ?? memoryScanSandbox();
  const inlineMaxBytes = seams.inlineMaxBytes ?? INLINE_SCAN_MAX_BYTES;
  return {
    name: 'postly',
    holds: true,
    scan: (input) => (input.size <= inlineMaxBytes ? inline.scan(input) : sandbox.check(input)),
  };
}
