// Single responsibility: what `putStream` may be handed, and the limit it pumps under. The pump itself
// is `byte-pump.ts`, which `put()` reads through too.

import { assert, describeValue, finiteCount } from '@ultimat3/core';
import type { PumpLimit } from './byte-pump';
import { assertPutOptions } from './driver';
import { streamTooLarge } from './errors-stream';

export interface PutStreamOptions {
  /**
   * Required: a stream's length is the sender's until it is counted. Past it the write is abandoned
   * (`X_STORAGE_TOO_LARGE`) and the key is as it was. Replaces the disk's `maxPutBytes`, which bounds
   * what `put()` buffers, and nothing here is buffered past one s3 part.
   */
  readonly maxBytes: number;
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** `put()` options that need the bytes before the object exists. The type omits them too. */
const NEEDS_THE_BYTES = ['checksum', 'retention', 'legalHold', 'serverSideEncryption'] as const;

/** Everything judged before a chunk is read. Answers the screened `maxBytes`. */
export function assertPutStream(
  driver: string,
  body: ReadableStream<Uint8Array>,
  options: PutStreamOptions,
): number {
  assert(
    body instanceof ReadableStream,
    `putStream() on the ${driver} disk was given a body that is not a ReadableStream (${describeValue(body)})`,
    'await disk.putStream(key, request.body, { maxBytes })   # a Uint8Array or a Blob goes through disk.put(key, bytes)',
  );
  const asked = (options ?? {}) as unknown as Readonly<Record<string, unknown>>;
  for (const name of NEEDS_THE_BYTES) {
    assert(
      asked[name] === undefined,
      `putStream() on the ${driver} disk was given ${name}, which needs the whole body before the object exists`,
      `await disk.put(key, bytes, { ${name} })   # buffered, so bounded by the disk's maxPutBytes`,
    );
  }
  assertPutOptions(driver, options);
  return finiteCount(`putStream() on the ${driver} disk`, 'maxBytes', options?.maxBytes, 1);
}

/** The limit `putStream` pumps under: its own `maxBytes`, and the refusal that names it. */
export const streamLimit = (driver: string, key: string, maxBytes: number): PumpLimit => ({
  driver,
  maxBytes,
  refuse: (total) => streamTooLarge(driver, key, total, maxBytes),
});
