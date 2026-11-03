// Single responsibility: the part arithmetic of an S3 multipart upload: the protocol's two limits
// and the part size that follows from a ceiling. No wire and no disk, so any caller may ask.

/** S3's floor on every part but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
/** S3's count of parts in one upload. */
export const MAX_PARTS = 10_000;

/**
 * How much is held before a part is sent. The smallest size whose 10,000 parts still cover
 * `maxBytes`, since what is held is what this process pays for the stream.
 */
export const partBytesFor = (maxBytes: number): number =>
  Math.max(MIN_PART_BYTES, Math.ceil(maxBytes / MAX_PARTS));
