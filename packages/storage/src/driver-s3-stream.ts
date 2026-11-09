// Single responsibility: the s3 disk's PINNED streamed read — one signed GET carrying `If-Match`, so
// the provider serves the revision a `stat()` described or answers 412. Bun's `S3File.stream()`
// sends no condition, and an overwrite between the stat and the read served new bytes under the
// old ETag and length.

import { type S3Refusal, type S3WireOptions, sendSigned } from './driver-s3-signed';
import type { ByteRange } from './range';

export interface S3PinnedDeps {
  /** The provider's refusal as the disk's coded read error (404 is not-found there). */
  readonly refused: (refusal: S3Refusal) => never;
  /** Another revision is at the key: the disk's `X_STORAGE_OBJECT_CHANGED`. */
  readonly changed: () => never;
}

/** The bytes of revision `etag`, whole or `[first, last]` already clamped to the object. */
export async function streamS3Pinned(
  wire: S3WireOptions,
  key: string,
  etag: string,
  range: ByteRange | undefined,
  deps: S3PinnedDeps,
): Promise<ReadableStream<Uint8Array>> {
  const result = await sendSigned(wire, {
    method: 'GET',
    key,
    headers: {
      'if-match': etag,
      ...(range === undefined ? {} : { range: `bytes=${range[0]}-${range[1]}` }),
    },
  });
  if (!result.ok) {
    return result.refusal.statusCode === 412 ? deps.changed() : deps.refused(result.refusal);
  }
  return result.response.body ?? new Blob([]).stream();
}
