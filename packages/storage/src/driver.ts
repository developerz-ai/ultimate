// Single responsibility: the driver contract every disk implements, plus the byte helpers all
// drivers share (BOUNDED body normalisation, SHA-256 etag/checksum). Bytes never travel as
// strings — a base64 round trip through JSON is how a "small" upload becomes a 33%-larger OOM —
// and never unbounded, which is the same failure with the sender choosing the size.

import { assert } from '@ultimat3/core';
import { putTooLarge } from './errors';

export type StorageBody = Uint8Array | ReadableStream<Uint8Array> | Blob;

/**
 * One row of a listing — everything a listing can HONESTLY know. `contentType` is optional here
 * and required on `StorageObject` below, because S3's `ListObjectsV2` does not return one: the
 * s3 driver used to fill in `application/octet-stream`, the local driver read the real value out
 * of its sidecar, and a caller filtering a listing by content type therefore got every object on
 * `local` and none on `s3`. Absent now means "this listing cannot know" — `get()` can.
 */
export interface StorageListEntry {
  readonly key: string;
  readonly size: number;
  /** Absent means the driver's listing does not carry it. Never a fabricated default. */
  readonly contentType?: string | undefined;
  readonly etag: string;
  readonly lastModified: Date;
  /** Present only when the driver actually stored what `put()` was handed — never invented. */
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** A single object the driver has actually looked at, so the content type is known. */
export interface StorageObject extends StorageListEntry {
  readonly contentType: string;
}

/**
 * Encryption at rest, per object. Declared so the gap is visible at the type level: an engineer
 * asked "can you prove which key encrypted this object?" must meet the answer at the call site,
 * not by reading the driver. NO driver honours it yet — `Bun.S3Client` exposes `acl`,
 * `storageClass` and `type` and nothing for `x-amz-server-side-encryption*`, and a POSIX file is
 * not encrypted at all — so both drivers refuse a `put()` carrying one (`X_NOT_IMPLEMENTED`) with
 * the out-of-band bucket-default command in the `fix`. A typed refusal beats a silent absence.
 */
export interface ServerSideEncryption {
  readonly algorithm: 'AES256' | 'aws:kms';
  /** The customer-managed key. Only meaningful with `aws:kms`. */
  readonly kmsKeyId?: string | undefined;
}

export interface PutOptions {
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** base64 SHA-256 of the body. Supplied means verified: a mismatch is a rejected write. */
  readonly checksum?: string | undefined;
  /** Refused by every shipped driver — see `ServerSideEncryption`. */
  readonly serverSideEncryption?: ServerSideEncryption | undefined;
}

export interface ListOptions {
  readonly prefix?: string | undefined;
  /** Opaque; pass back the `cursor` of the previous page. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListPage {
  readonly objects: readonly StorageListEntry[];
  readonly truncated: boolean;
  /** Absent when `truncated` is false. */
  readonly cursor?: string | undefined;
}

export interface StorageRead {
  readonly object: StorageObject;
  readonly bytes: Uint8Array;
}

export type SignedUrlMethod = 'GET' | 'PUT';

export interface SignedUrlOptions {
  readonly method?: SignedUrlMethod | undefined;
  readonly expiresInMs?: number | undefined;
  /**
   * Ceiling on a `PUT`, and **the one option whose enforcement is the driver's, not the caller's**.
   *
   * `localDriver` signs it into the URL, so `acceptSignedUpload` refuses a client that widens it.
   * `s3Driver` CANNOT: S3 has no request header for a size and Bun's `presign` covers method,
   * expiry and content type only — so the client PUTs straight into the bucket and nothing between
   * the grant and the object enforces this number. It is not refused there, because `grantUpload`
   * supplies it on every grant and refusing would break every s3 upload an app mints; the ceiling
   * a bucket-backed disk actually gets is a bucket rule or a post-upload check on `object.size`.
   * `driver-parity.test.ts` pins both halves so neither moves alone.
   */
  readonly maxBytes?: number | undefined;
  readonly contentType?: string | undefined;
}

export interface StorageDriver {
  /** Disk-independent driver name (`local`, `s3`) — appears in every error cause. */
  readonly name: string;
  put(key: string, body: StorageBody, options?: PutOptions): Promise<StorageObject>;
  get(key: string): Promise<StorageRead>;
  /** Bytes without buffering — the only safe path for anything over a few MB. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * Bytes from one key to another without them passing through this process. Idempotent in the
   * destination and non-destructive in the source: the caller deletes the source afterwards if
   * it wanted a move. `X_STORAGE_NOT_FOUND` when `from` is absent.
   */
  copy(from: string, to: string): Promise<StorageObject>;
  /**
   * Deleting an ABSENT key is not an error. Anything else is: a denied `s3:DeleteObject`, a
   * throttle, an expired credential and a read-only mount all raise `X_STORAGE_DELETE_FAILED`,
   * because a caller that cannot tell "gone" from "refused" reports data erased that is not.
   */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(options?: ListOptions): Promise<ListPage>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_LIST_LIMIT = 1000;

/**
 * The page size a `list()` honours — refused rather than clamped when it cannot be one.
 *
 * At the `ListOptions` seam and not inside a driver, because the two answered a non-positive
 * limit differently: the local disk sliced `[0, 0)` and then dropped its own `truncated` flag, so
 * `list({ limit: 0 })` over a full disk reported a COMPLETE empty listing, while the s3 disk
 * handed `maxKeys: 0` straight to the provider. `sweepOrphans` pages through `list()`, so a page
 * that is empty and claims to be complete is a false erasure report — the same lie a swallowed
 * listing error tells, one call to the left. A fraction is refused for `chunk()`'s reason: a
 * `slice` truncates it, so the pages silently stop being the size that was asked for.
 */
export function resolveListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  assert(
    Number.isSafeInteger(limit) && limit > 0,
    `a list limit must be a positive integer, got ${String(limit)}: a page of zero objects cannot be told apart from a disk that has none`,
    `pass a positive limit — disk.list({ limit: ${DEFAULT_LIST_LIMIT} }), or omit it and take DEFAULT_LIST_LIMIT`,
  );
  return limit;
}

/** What `toBytes` needs to refuse a body: the ceiling, and the key to name in the refusal. */
export interface ByteLimit {
  readonly driver: string;
  readonly key: string;
  readonly maxBytes: number;
}

/**
 * Body → bytes, refusing past the ceiling BEFORE the whole body is resident.
 *
 * The bound is not an optimisation. `put()` buffers, so without one the heap grows by whatever a
 * route piped into it: a 4GB request body on a pod with a 768Mi limit is an OOM kill, and the
 * caller sees a dropped connection rather than a refusal. A `Uint8Array` and a `Blob` already
 * know their length, so they are refused without a copy; a stream is read a chunk at a time and
 * cancelled the moment the running total passes the ceiling, so at most one chunk past the limit
 * is ever held. The server-side `put()` path is for objects that FIT IN MEMORY — user uploads go
 * direct to the disk through `grantUpload`, which is the architecture, not the optimisation.
 */
export async function toBytes(body: StorageBody, limit: ByteLimit): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit.maxBytes) {
      throw putTooLarge(limit.driver, limit.key, body.byteLength, limit.maxBytes);
    }
    return body;
  }
  if (body instanceof Blob) {
    if (body.size > limit.maxBytes) {
      throw putTooLarge(limit.driver, limit.key, body.size, limit.maxBytes);
    }
    return new Uint8Array(await body.arrayBuffer());
  }
  return readBounded(body, limit);
}

/** The stream half of `toBytes`: the only shape whose length is unknown until it is read. */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: ByteLimit,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit.maxBytes) {
        throw putTooLarge(limit.driver, limit.key, total, limit.maxBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    // Cancel rather than merely release: a refused body must stop arriving, not keep filling a
    // socket buffer nobody will read. Already-closed streams answer this with a no-op.
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** base64 SHA-256 — the wire form for `PutOptions.checksum` and `ValidatedUpload.checksum`. */
export function sha256Base64(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('base64');
}

/** Local etag. S3 returns the provider's etag instead, so never compare across drivers. */
export function etagOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 32);
}
