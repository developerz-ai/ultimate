// Single responsibility: the part arithmetic of an S3 multipart upload: the protocol's two limits
// and the part size that follows from a ceiling, plus the optional capability a disk declares for
// an upload in parts. No wire and no disk, so any caller may ask.

import type { StorageObject } from './driver';

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

/** S3's ceiling on one part, and so on one part URL's signed length. */
export const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;

/** One part a disk holds for an open upload: what `listParts` answers, and what a resume reads. */
export interface UploadedPart {
  readonly partNumber: number;
  /** The disk's own etag of the part. S3's is quoted MD5; the local disks' is `etagOf`. */
  readonly etag: string;
  readonly size: number;
}

/** A part the caller asks `completeUpload` to assemble. The etag, when given, must be the stored one. */
export interface CompletedPart {
  readonly partNumber: number;
  readonly etag?: string | undefined;
}

/** One upload opened and neither completed nor aborted: what `abortStaleUploads` weighs. */
export interface MultipartSession {
  readonly key: string;
  readonly uploadId: string;
  /** ABSENT when the disk did not say, as `StorageListEntry.lastModified` is — never epoch 0. */
  readonly initiated?: Date | undefined;
}

export interface SignPartOptions {
  /** The part's exact size, signed: the disk stores it at no other length. */
  readonly contentLength: number;
  readonly expiresInMs: number;
}

/**
 * An upload in parts, on one disk. Optional on `StorageDriver`, so a third-party driver still
 * compiles; `grantMultipart` refuses a disk without it (`X_STORAGE_MULTIPART_UNSUPPORTED`). Every
 * method takes a key already held to the tenant by the caller in `grant-multipart.ts`.
 */
export interface MultipartCapability {
  /** Opens a session and answers its id. The object's content type travels here: a part has none. */
  create(key: string, options: { readonly contentType: string }): Promise<string>;
  /** A URL a browser PUTs one part to. Signs nothing about whether the upload is still open. */
  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: SignPartOptions,
  ): Promise<string>;
  /** Ascending by part number. `X_STORAGE_UPLOAD_UNKNOWN` for a session that is not open. */
  listParts(key: string, uploadId: string): Promise<readonly UploadedPart[]>;
  /** Assembles `parts`, already checked against `listParts`; the object exists once it returns. */
  complete(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<StorageObject>;
  /** Drops the session and every part. An unknown session is already in the asked-for state. */
  abort(key: string, uploadId: string): Promise<void>;
  /** Every open session under `prefix`, so a sweep can reclaim what nobody finished. */
  listUploads(prefix?: string): Promise<readonly MultipartSession[]>;
  /**
   * Stores one part's bytes — only on a disk that signs its own part URLs (`local`, `memory`),
   * called by the `/_storage` PUT once the URL verified. On s3 the bytes go to the bucket.
   */
  receivePart?(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<UploadedPart>;
}

/**
 * The parts asked for, held to the parts stored: each asked part is stored, in ascending order,
 * under the stored etag when one is named, and none but the last is under S3's part floor.
 * Answers the stored parts in the asked order, which is what `complete` assembles; `problem` names
 * the first reason it cannot.
 */
export function matchParts(
  asked: readonly CompletedPart[],
  stored: readonly UploadedPart[],
): { readonly parts: readonly UploadedPart[] } | { readonly problem: string } {
  if (asked.length === 0) return { problem: 'no parts were named' };
  const byNumber = new Map(stored.map((part) => [part.partNumber, part]));
  const parts: UploadedPart[] = [];
  let previous = 0;
  for (const { partNumber, etag } of asked) {
    if (!Number.isSafeInteger(partNumber) || partNumber <= previous) {
      return { problem: `part ${String(partNumber)} is not in ascending order after ${previous}` };
    }
    const held = byNumber.get(partNumber);
    if (held === undefined) return { problem: `part ${partNumber} never arrived` };
    if (etag !== undefined && etag !== held.etag) {
      return { problem: `part ${partNumber}'s etag is not the one the disk stored` };
    }
    parts.push(held);
    previous = partNumber;
  }
  // S3's EntityTooSmall, asked on every disk so the local ones cannot complete what s3 refuses.
  const short = parts.slice(0, -1).find((part) => part.size < MIN_PART_BYTES);
  if (short !== undefined) {
    return {
      problem: `part ${short.partNumber} is ${short.size}B, under the ${MIN_PART_BYTES}B every part but the last must reach`,
    };
  }
  return { parts };
}
