// Single responsibility: what `get(key, { range })` may ask for and what it is answered with — the
// screen of the tuple for every disk, and for memory and local the clamp, the 416 and the ceiling
// (which bounds the BYTES ASKED FOR, not the object). s3 learns the size from its one GET's answer
// and applies the same three rules there (`driver-s3-range.ts`), with the same refusals.

import { assert } from '@ultimat3/core';
import { rangeTooLarge, rangeUnsatisfiable } from './errors-range';

/**
 * The first and the last byte, BOTH INCLUSIVE — HTTP's `Range: bytes=first-last` and S3's, so a
 * route copies a parsed header straight in and a `Content-Range` is read straight back out.
 * `[0, 99]` is the first hundred bytes; `[0, 0]` is one.
 */
export type ByteRange = readonly [first: number, last: number];

export interface GetOptions {
  /**
   * Read only these bytes. The last byte is clamped to the object (`[0, 1e12]` on a 10-byte object
   * answers `[0, 9]`), as HTTP clamps it; a first byte at or past the end is
   * `X_STORAGE_RANGE_UNSATISFIABLE`, which is a 416. `maxGetBytes` bounds the RANGE'S length, so a
   * page of a large object is readable where `get()` of the whole would be refused.
   *
   * Meaningless on a SEALED object: `seal()`'s `x1` envelope is one AES-GCM ciphertext whose tag
   * authenticates every byte, so a slice of it neither opens nor means anything. Range-read plain
   * objects; page a sealed one by sealing each page as its own object.
   */
  readonly range?: ByteRange | undefined;
}

const isOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The tuple's SHAPE, before the disk is asked anything: two whole, non-negative offsets in order.
 * Core's `assert` (`X_INVARIANT`), because a backwards or fractional range is the calling code's
 * defect — no object makes it valid — while a first byte past the end depends on the object and
 * is the coded, caller-facing refusal below.
 */
export function assertGetOptions(driver: string, options: GetOptions | undefined): void {
  const range = options?.range;
  if (range === undefined) return;
  const [first, last] = Array.isArray(range) ? range : [];
  assert(
    Array.isArray(range) && range.length === 2 && isOffset(first) && isOffset(last),
    `get() on the ${driver} disk was given a range that is not two whole, non-negative byte offsets`,
    'get(key, { range: [first, last] }) — inclusive offsets: [0, 99] reads the first 100 bytes',
  );
  assert(
    first <= last,
    `get() on the ${driver} disk was given the range [${first}, ${last}], whose first byte is past its last`,
    `get(key, { range: [${last}, ${first}] }) — first before last, both inclusive`,
  );
}

/**
 * The range a disk SERVES for an object of `size` bytes — clamped, refused, or over the ceiling.
 * Called with the object's own measured size, before a byte is read, by every driver.
 */
export function servedRange(
  disk: string,
  key: string,
  range: ByteRange,
  size: number,
  maxGetBytes: number,
): ByteRange {
  const [first, wanted] = range;
  if (first >= size) throw rangeUnsatisfiable(disk, key, range, size);
  const last = Math.min(wanted, size - 1);
  if (last - first + 1 > maxGetBytes) throw rangeTooLarge(disk, key, [first, last], maxGetBytes);
  return [first, last];
}
