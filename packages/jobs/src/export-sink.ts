// Where an export's bytes land, and what the artifact says about itself when it is finished.
//
// A SEAM and not a `@ultimat3/storage` import, for the reason `PurgeTarget` is one: this package
// holds no storage dependency, and taking one so a queue could name a disk would put the object
// store on tier 3's import graph. A `StorageDriver` satisfies this by having the method it already
// has — `put(key, body, options?)` with a `Uint8Array` as a legal `StorageBody`
// (`packages/storage/src/driver.ts:117`) — so `disk('exports')` IS an `ExportSink`.

import { assert } from '@ultimat3/core';
import type { ExportFormat } from './export-format';
import { EXPORT_EXTENSION } from './export-format';

/**
 * One object, written whole.
 *
 * ONE OBJECT PER PAGE is the design, not a simplification. `put()` buffers by construction — its
 * own header says the server-side path "is for objects that FIT IN MEMORY" — so an export that
 * wrote one object would hold the entire dataset, which is the exact failure this factory exists
 * to prevent. A page is bounded, so a page-sized object is bounded, and the artifact is the parts
 * concatenated: both formats end every line in a newline so that concatenation is a valid file.
 *
 * It is also what makes at-least-once SAFE here. The key is derived from the page INDEX, so a
 * replayed page rewrites the same key with the same bytes — an overwrite, never an append. No
 * idempotency argument is needed about the app's rows, because a duplicate part is impossible to
 * express.
 */
export interface ExportSink {
  /**
   * `Promise<unknown>`, never `Promise<void>`. `StorageDriver.put` answers
   * `Promise<StorageObject>` (`packages/storage/src/driver.ts:117`), and a `Promise<void>` return
   * makes it **not assignable** — so this file's own header, `export.ts` and the README all claimed
   * `disk('exports')` IS an `ExportSink` while the type refused the assignment. Measured:
   * `TS2322: Type 'Promise<StorageObject>' is not assignable to type 'Promise<void>'`.
   *
   * The pass discards the answer either way; `unknown` is what says so without forbidding a driver
   * from returning one. `scripts/export-sink.test.ts` compiles the assignment, because three
   * comments asserting it and nothing checking it is what let this ship.
   */
  put(key: string, body: Uint8Array): Promise<unknown>;
}

/** Zero-padded so a lexical listing of the parts is their order. */
export const EXPORT_PART_DIGITS = 5;

export const exportPartKey = (prefix: string, index: number, format: ExportFormat): string =>
  `${prefix}/part-${String(index).padStart(EXPORT_PART_DIGITS, '0')}.${EXPORT_EXTENSION[format]}`;

export const exportManifestKey = (prefix: string): string => `${prefix}/manifest.json`;

/**
 * What the artifact says about itself. A COUNT of parts and never a list of them: the keys are
 * derived from the index, so `exportPartKey(prefix, i, format)` rebuilds every one — and a list
 * would be the one thing in this whole pass that grows with the size of the export.
 */
export interface ExportManifest {
  readonly export: string;
  readonly runId: string;
  readonly prefix: string;
  readonly format: ExportFormat;
  readonly columns: readonly string[];
  readonly parts: number;
  readonly rows: number;
  readonly bytes: number;
  /** ISO 8601, UTC. The one instant an export has, and it is not a date anybody formats. */
  readonly completedAt: string;
}

export interface MemoryExportSink extends ExportSink {
  /** Key -> the bytes last written under it. A rewritten part replaces, exactly as S3 would. */
  objects(): ReadonlyMap<string, Uint8Array>;
  /** Every `put` in order, key and length — a rewrite appears twice, which is what proves replay. */
  writes(): readonly { readonly key: string; readonly bytes: number }[];
  reset(): void;
}

/**
 * The dev and test sink, and honest about being one: one heap, nothing survives a restart. It is
 * deliberately UNBOUNDED, unlike `memoryWebhookLedger`'s ring — a sink that silently dropped parts
 * would make a test of "the artifact is complete" pass over an artifact that is not.
 */
export function memoryExportSink(
  options: { readonly onPut?: (key: string, body: Uint8Array) => void } = {},
): MemoryExportSink {
  const objects = new Map<string, Uint8Array>();
  const writes: { key: string; bytes: number }[] = [];
  return {
    put(key: string, body: Uint8Array): Promise<void> {
      assert(
        key.length > 0,
        'an export sink was handed an empty key',
        'return a non-empty prefix from prefix() on the exportRows() declaration',
      );
      options.onPut?.(key, body);
      objects.set(key, body);
      writes.push({ key, bytes: body.byteLength });
      return Promise.resolve();
    },
    objects: (): ReadonlyMap<string, Uint8Array> => new Map(objects),
    writes: (): readonly { readonly key: string; readonly bytes: number }[] => [...writes],
    reset(): void {
      objects.clear();
      writes.length = 0;
    },
  };
}
