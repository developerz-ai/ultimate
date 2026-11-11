// The `uploadScanner` port (`ADAPTER_PORTS`): what a content scanner is asked, what it answers, and
// the one slot the boot installs `runtime.ts`'s scanner into. `promoteAttachment` asks it; the
// framework ships the seam and a memory reference, never a vendor (axiom 8 — ClamAV is the app's).

import { adapterSlot } from '@ultimat3/core/adapter';

/** One stored object, handed over as a stream: a scanner never forces the whole file into a heap. */
export interface ScanInput {
  /** Where the scanned bytes live: this confirm's own copy under `pending/scan/`, no URL rewrites. */
  readonly key: string;
  /**
   * The upload being promoted — the `pending/` key `grantUpload` minted, stable across retries. What
   * an out-of-band decision (a review queue, a vendor's async job) is keyed by; `key` changes per
   * attempt.
   */
  readonly pendingKey: string;
  /**
   * WHICH bytes under `pendingKey` this is: the confirmed upload's etag, or `sha256:<hex>` of the
   * bytes on a disk that keeps none. The upload URL stays valid after the sniff, so the object under
   * `pendingKey` can be rewritten between two confirms — a held verdict, and the decision that
   * clears it, MUST be keyed by `(pendingKey, revision)`: an approval of one revision is no
   * approval of the next. Always set by `promoteAttachment`; optional only so a scanner's own test
   * written before 31.3 still compiles.
   */
  readonly revision?: string | undefined;
  readonly size: number;
  /** The type the object is stored under, already sniffed against its bytes. */
  readonly contentType: string;
  /** Every byte of the object. Read it to the end or cancel it; it is not reused. */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * A verdict about the bytes, never about the scanner. A scanner that cannot decide — its daemon is
 * down, it timed out, the file is past its own limit — REJECTS instead: `promoteAttachment` turns
 * that into `X_STORAGE_SCAN_UNAVAILABLE` (or a pass, under `onScanUnavailable: 'accept'`).
 *
 * `hold` is a decision too: not yet cleared, by something outside this call — a human review, a
 * vendor's asynchronous sandbox. The upload stays pending and promotion answers
 * `X_STORAGE_QUARANTINED` until the scanner answers `clean` for that `pendingKey` AND `revision`. Neither `hold`
 * nor `infected` is something a policy can wave through.
 */
export type ScanVerdict =
  | { readonly verdict: 'clean' }
  | { readonly verdict: 'infected'; readonly signature: string }
  | { readonly verdict: 'hold'; readonly reason: string };

export interface UploadScanner {
  /** Named in every refusal's `meta.scanner` — `clamd`, `memory`. */
  readonly name: string;
  /**
   * `true` for a scanner that answers `hold` (a review queue, an async vendor scan). Its
   * no-verdict then ALWAYS refuses — `onScanUnavailable: 'accept'` never applies — because a
   * scanner that cannot reach its own record of holds cannot say an upload was cleared. A `hold`
   * from a scanner that did not declare this is refused as a bug (`X_INVARIANT`), so the
   * declaration cannot be forgotten past the first held upload.
   */
  readonly holds?: boolean | undefined;
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
