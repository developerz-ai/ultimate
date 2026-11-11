// The `uploadScanner` port's contract as shared examples: `behavesLike(uploadScannerConformance, ()
// => scanner)`. Structural over `@ultimat3/storage`'s `UploadScanner`, as the storage suite is over
// its driver, so this package takes no dependency on storage. Bodies arrive as streams, cut small.

import { expect, test } from 'bun:test';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

/** `@ultimat3/storage`'s `ScanVerdict`, restated structurally. */
export type ScanVerdictLike =
  | { readonly verdict: 'clean' }
  | { readonly verdict: 'infected'; readonly signature: string }
  | { readonly verdict: 'hold'; readonly reason: string };

/** `@ultimat3/storage`'s `UploadScanner`: a ClamAV adapter, a vendor API, the memory reference. */
export interface UploadScannerLike {
  readonly name: string;
  readonly holds?: boolean | undefined;
  scan(input: {
    readonly key: string;
    readonly pendingKey: string;
    /** Which bytes under `pendingKey`: a held decision is keyed by `(pendingKey, revision)`. */
    readonly revision?: string | undefined;
    readonly size: number;
    readonly contentType: string;
    readonly body: ReadableStream<Uint8Array>;
  }): Promise<ScanVerdictLike>;
}

export interface UploadScannerCheck {
  readonly name: string;
  run(scanner: UploadScannerLike): Promise<void>;
}

/** The EICAR test string, in two halves so this file is no detection itself. */
export const UPLOAD_SCANNER_EICAR = `${'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'}${'-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'}`;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `bytes` as a stream of `size`-byte chunks — EICAR cut by the transport is still EICAR. */
function streamOf(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

/**
 * The revision `promoteAttachment` would hand over for these bytes: one identity per content. A true
 * retry of the same bytes keeps it; different bytes never share it — so a scanner caching by
 * `(pendingKey, revision)`, as a held decision must, is judged on what it was actually sent.
 */
const revisionOf = (bytes: Uint8Array): string =>
  `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

const scan = (scanner: UploadScannerLike, bytes: Uint8Array, chunk = 64 * 1024) => {
  const revision = revisionOf(bytes);
  return scanner.scan({
    key: `org/conformance/pending/scan/${revision.slice(7, 19)}-u-1.txt`,
    pendingKey: 'org/conformance/pending/u-1.txt',
    revision,
    size: bytes.byteLength,
    contentType: 'text/plain',
    body: streamOf(bytes, chunk),
  });
};

const PLAIN = encode('A plain note: nothing in here is a virus.\n');

export const UPLOAD_SCANNER_CHECKS: readonly UploadScannerCheck[] = [
  {
    name: 'has a name, for the refusal it ends up in',
    async run(scanner) {
      expect(scanner.name.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'the EICAR test file is infected, with a non-empty signature',
    async run(scanner) {
      const verdict = await scan(scanner, encode(UPLOAD_SCANNER_EICAR));
      expect(verdict.verdict).toBe('infected');
      expect(verdict.verdict === 'infected' ? verdict.signature.length : 0).toBeGreaterThan(0);
    },
  },
  {
    name: 'the EICAR test file delivered in 7-byte chunks is still infected',
    async run(scanner) {
      expect((await scan(scanner, encode(UPLOAD_SCANNER_EICAR), 7)).verdict).toBe('infected');
    },
  },
  {
    name: 'a plain text file is clean',
    async run(scanner) {
      expect(await scan(scanner, PLAIN)).toEqual({ verdict: 'clean' });
    },
  },
  {
    name: 'an empty file is clean',
    async run(scanner) {
      expect(await scan(scanner, new Uint8Array())).toEqual({ verdict: 'clean' });
    },
  },
  {
    name: 'a verdict is about these bytes only: infected, then clean, from one scanner',
    async run(scanner) {
      expect((await scan(scanner, encode(UPLOAD_SCANNER_EICAR))).verdict).toBe('infected');
      expect(await scan(scanner, PLAIN)).toEqual({ verdict: 'clean' });
    },
  },
  {
    // The upload URL stays valid after the sniff: the bytes under one pending key can be rewritten
    // between two confirms. A scanner (or the review behind it) keyed by `pendingKey` alone clears
    // the rewrite with the original's verdict — EICAR attached unscanned.
    name: 'a new revision of one upload is judged on its own bytes: clean, then EICAR is never clean',
    async run(scanner) {
      const first = await scan(scanner, PLAIN);
      expect(first.verdict === 'infected').toBe(false);
      const second = await scan(scanner, encode(UPLOAD_SCANNER_EICAR));
      expect(second.verdict).not.toBe('clean');
    },
  },
];

export const uploadScannerConformance: SharedExamples<UploadScannerLike> = sharedExamples(
  'an upload scanner',
  (subject) => {
    for (const check of UPLOAD_SCANNER_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
