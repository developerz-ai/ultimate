// The `uploadScanner` port (`ADAPTER_PORTS`): what a content scanner is asked, what it answers, and
// the one slot the boot installs `runtime.ts`'s scanner into. `promoteAttachment` asks it; the
// framework ships the seam and a memory reference, never a vendor (axiom 8 — ClamAV is the app's).

import { adapterSlot } from '@ultimat3/core/adapter';

/** One stored object, handed over as a stream: a scanner never forces the whole file into a heap. */
export interface ScanInput {
  /** Where the scanned bytes live: this confirm's own copy under `pending/scan/`, no URL rewrites. */
  readonly key: string;
  readonly size: number;
  /** The type the object is stored under, already sniffed against its bytes. */
  readonly contentType: string;
  /** Every byte of the object. Read it to the end or cancel it; it is not reused. */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * A verdict about the bytes, never about the scanner. A scanner that cannot decide — its daemon is
 * down, it timed out, the file is past its own limit — REJECTS instead: `promoteAttachment` turns
 * that into `X_STORAGE_SCAN_UNAVAILABLE` (or a pass, under `onScanUnavailable: 'accept'`), and an
 * infected verdict is never something a policy can wave through.
 */
export type ScanVerdict =
  | { readonly verdict: 'clean' }
  | { readonly verdict: 'infected'; readonly signature: string };

export interface UploadScanner {
  /** Named in every refusal's `meta.scanner` — `clamd`, `memory`. */
  readonly name: string;
  scan(input: ScanInput): Promise<ScanVerdict>;
}

const ambient = /* @__PURE__ */ adapterSlot<UploadScanner | undefined>(() => undefined);

/**
 * The boot's install, from `uploadScanner` in `apps/<app>/runtime.ts` — exported from
 * `@ultimat3/storage/adapter` only, so that file is the one place an app chooses a scanner. Answers
 * the release that removes THIS install and no other.
 */
export function installUploadScanner(scanner: UploadScanner): () => void {
  return ambient.install(scanner);
}

/** The installed scanner, or `undefined`: no scanner installed means promotion scans nothing. */
export function uploadScanner(): UploadScanner | undefined {
  return ambient.current();
}

export function resetUploadScanner(): void {
  ambient.reset();
}
