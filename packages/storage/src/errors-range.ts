// The two refusals of a ranged `get(key, { range })`: a first byte past the end (HTTP's 416) and a
// window over the disk's get ceiling. Their codes are registered with the rest of the package's in
// `errors.ts`; each `fix:` is the call to make next, with the numbers this object allows.

import { renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

const keyArg = (key: string): string => renderFixLiteral(key, "'<key>'");

/**
 * A first byte at or past the end. The last byte is CLAMPED (`range.ts`), so only the first can
 * miss; an empty object has no first byte at all, so its fix is the plain read.
 */
export const rangeUnsatisfiable = (
  disk: string,
  key: string,
  range: readonly [number, number],
  size: number,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_RANGE_UNSATISFIABLE',
    cause: `get() asked "${key}" for bytes ${range[0]}-${range[1]}, and the object on the ${disk} disk is ${size}B — its first byte is past the end`,
    fix:
      size === 0
        ? `await disk.get(${keyArg(key)})   # the object is empty: no range has a first byte`
        : `await disk.get(${keyArg(key)}, { range: [0, ${size - 1}] })   # the whole ${size}B object; any first byte below ${size}`,
    meta: { disk, key, first: range[0], last: range[1], size },
  });

/**
 * A window over `maxGetBytes` — the ceiling bounds the RANGE, so the repair is a smaller window
 * from the same first byte, or a higher ceiling on the disk.
 */
export const rangeTooLarge = (
  disk: string,
  key: string,
  range: readonly [number, number],
  maxBytes: number,
): StorageError => {
  const bytes = range[1] - range[0] + 1;
  return new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `the range asked of "${key}" is ${bytes}B against the ${disk} disk's get ceiling of ${maxBytes}B, and get() buffers the range`,
    fix: `await disk.get(${keyArg(key)}, { range: [${range[0]}, ${range[0] + maxBytes - 1}] })   # one window within the ceiling; or raise maxGetBytes to ${bytes} on the disk`,
    meta: { disk, key, bytes, maxBytes, first: range[0], last: range[1] },
  });
};
