// Single responsibility: does a provider failure mean "there is nothing at that key"? Split from
// `driver-s3.ts` at its line ceiling; the one reader is that driver's delete and read paths.

import { stringField } from '@ultimat3/core';

/** One numeric field off a value that may fight being read — `stringField`'s missing twin. */
function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const held = (value as Record<string, unknown>)[key];
    return typeof held === 'number' ? held : undefined;
  } catch {
    return undefined;
  }
}

/** The provider codes that mean "there is nothing at that key", and nothing wider. */
const ABSENT_OBJECT_CODES: ReadonlySet<string> = new Set(['NoSuchKey', 'NotFound', 'ENOENT']);

/**
 * The ONE delete failure the contract calls success. `AccessDenied`, `SlowDown`, an expired
 * credential and a reset connection are none of them, and the previous `.catch(() => undefined)`
 * reported all four as deleted — which is how an erasure sweep certifies data it never removed.
 *
 * Read structurally: an `S3Error` is `name: 'S3Error'` with a `code` the service returned, and
 * every field of a value this process did not build is a getter that can throw.
 */
export function isAbsentObject(error: unknown): boolean {
  const code = stringField(error, 'code');
  if (code !== undefined && ABSENT_OBJECT_CODES.has(code)) return true;
  return numberField(error, 'statusCode') === 404 || numberField(error, 'status') === 404;
}
