// Single responsibility: the driver contract every disk implements, plus the byte helpers all
// drivers share (BOUNDED body normalisation, SHA-256 etag/checksum). Bytes never travel as
// strings — a base64 round trip through JSON is how a "small" upload becomes a 33%-larger OOM —
// and never unbounded, which is the same failure with the sender choosing the size.

import type { Clock, Page } from '@ultimat3/core';
import { assert, describeValue } from '@ultimat3/core';
import { pumpBounded } from './byte-pump';
import { putTooLarge } from './errors';
import type { MultipartCapability } from './multipart';
import type { ObjectLock, ObjectLockOptions } from './object-lock';
import type { PutStreamOptions } from './put-stream';
import type { ByteRange, GetOptions } from './range';
import type { SignedPart, SignedUrlVerification } from './signed-url';

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
  /**
   * ABSENT when the provider did not say — never epoch 0, which every age test reads as "older
   * than any window", and never an invalid `Date`, which is a value a reader has to remember to
   * test. A reader that needs an age handles `undefined`; `sweepOrphans` spares it.
   */
  readonly lastModified?: Date | undefined;
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

/**
 * `retention` and `legalHold` (from `ObjectLockOptions`) are S3 Object Lock, per object: sent as
 * `x-amz-object-lock-*` on s3 — which needs a bucket created with Object Lock — and EMULATED by the
 * local and memory disks, which refuse a delete or an overwrite of a locked object until it lapses.
 */
export interface PutOptions extends ObjectLockOptions {
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
  /**
   * Opaque; pass back the `nextCursor` of the previous page. `null` and absent both mean the
   * first page, so `cursor: page.nextCursor` threads a loop with no conversion — the loop stops
   * on `hasMore: false` before a `null` is ever handed back as "the page after the last".
   */
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

export interface StorageRead {
  /** The WHOLE object's description — `size` is the object's, never the range's. */
  readonly object: StorageObject;
  readonly bytes: Uint8Array;
  /**
   * The bytes served, both inclusive, after the clamp — present exactly when `range` was asked.
   * A third-party driver that ignored the option answers none, and that absence is how a caller
   * tells a slice from the whole object rather than trusting `bytes.byteLength`.
   */
  readonly range?: ByteRange | undefined;
}

export type SignedUrlMethod = 'GET' | 'PUT';

export interface SignedUrlOptions {
  readonly method?: SignedUrlMethod | undefined;
  readonly expiresInMs?: number | undefined;
  /**
   * Ceiling on a `PUT`. `localDriver` signs it into the URL, so `acceptSignedUpload` refuses a client
   * that widens it. A provider's URL has no ceiling to sign, so `s3Driver` refuses it without
   * `contentLength` (`X_STORAGE_UPLOAD_SIZE_UNDECLARED`) rather than mint a URL that ignores it.
   */
  readonly maxBytes?: number | undefined;
  /**
   * The exact size of a `PUT`, inside the signature. On `s3Driver` the URL then signs
   * `content-length`, so the provider refuses any other length, a chunked body with none included
   * (403 `SignatureDoesNotMatch`). The local disks hold it as a ceiling (`x-max`): they count what
   * arrives, so a shorter body passes there and not on s3 (a part URL signs it exactly: `x-len`).
   * `driver-parity.test.ts` pins both.
   */
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
  /**
   * A part of an open upload, inside the signature: the URL then writes that part and nothing else.
   * Only a disk whose `multipart.receivePart` stores parts signs one; `s3Driver` refuses it, since
   * its parts are signed by `multipart.signPart` against the provider.
   */
  readonly part?: SignedPart | undefined;
}

export interface CopyOptions {
  /** The source's `etag` as this disk reported it. */
  readonly ifMatch?: string | undefined;
}

export interface StorageDriver {
  /** Disk-independent driver name (`local`, `s3`) — appears in every error cause. */
  readonly name: string;
  /**
   * The path prefix THIS disk's own signed URLs hang off, read by `accept.ts` so the minting half
   * and the verifying half cannot state it twice. Undefined on a driver whose URLs are the
   * provider's (`s3`), which this package never verifies.
   */
  readonly signedUrlBase?: string | undefined;
  /**
   * `defineStorage` tells the driver the key it was registered under, at boot, once. Two readers:
   * a driver that mints its own URLs hangs them off THAT, never off `name` — the mounted
   * `/_storage/:disk/*key` route resolves the segment through the registry, so a disk registered
   * as `uploads` whose URLs say `local` 404s every signature it just wrote — and every
   * `X_STORAGE_NOT_FOUND`, whose `fix:` is `disk('<name>').list(…)`. `local`, `s3`
   * and `memory` use it for both — their URLs and their not-found errors. Optional: a
   * third-party driver that ignores it keeps minting and refusing under `name`.
   */
  registerAs?(diskName: string): void;
  put(key: string, body: StorageBody, options?: PutOptions): Promise<StorageObject>;
  /**
   * A body of any length, without buffering it: counted against the call's required `maxBytes`, and
   * past it the write is abandoned with the key as it was (`X_STORAGE_TOO_LARGE`). Takes no
   * `checksum`, retention or legal hold, which need the bytes before the object exists.
   */
  putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<StorageObject>;
  /**
   * What a read would say about the object, WITHOUT its bytes — `undefined` when nothing is there.
   * `promoteAttachment` decides on `stat().size`, because a presigned PUT lands on the disk
   * unmeasured and `get()` is the one call that must not be how its size is learned. Required: a
   * driver that cannot measure cannot be promoted from, and that is a compile error, not a refusal.
   */
  stat(key: string): Promise<StorageObject | undefined>;
  /**
   * The whole object, BUFFERED — so bounded: an object over the driver's `maxGetBytes` is
   * `X_STORAGE_TOO_LARGE`, exactly as `put()` refuses a body over `maxPutBytes`. Past it, `stream()`
   * — or `{ range: [first, last] }`, which reads only those bytes (inclusive) and is bounded by
   * the range's length: s3 sends `Range:`, the local disk slices the file, memory slices its copy.
   */
  get(key: string, options?: GetOptions): Promise<StorageRead>;
  /**
   * Bytes without buffering — the only safe path for anything over a few MB. `etag` pins the read
   * to the revision a `stat()` described: another is `X_STORAGE_OBJECT_CHANGED`, never its bytes
   * under the old validator.
   */
  stream(key: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
  /**
   * The bytes `[first, last]` (inclusive, clamped, as `get`'s range) with none before them read, so
   * a seek late in a film costs its window. `X_STORAGE_RANGE_UNSATISFIABLE` past the end. A method and
   * not an option on `stream`, which a third-party driver would ignore and serve the wrong bytes.
   */
  streamRange(
    key: string,
    range: ByteRange,
    options?: StreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  /**
   * Bytes from one key to another without them passing through this process. Idempotent in the
   * destination and non-destructive in the source: the caller deletes the source afterwards if
   * it wanted a move. `X_STORAGE_NOT_FOUND` when `from` is absent. `ifMatch` copies only that
   * revision: any other is `X_STORAGE_OBJECT_CHANGED` and writes nothing.
   */
  copy(from: string, to: string, options?: CopyOptions): Promise<StorageObject>;
  /**
   * Deleting an ABSENT key is not an error. Anything else is: a denied `s3:DeleteObject`, a
   * throttle, an expired credential and a read-only mount all raise `X_STORAGE_DELETE_FAILED`,
   * because a caller that cannot tell "gone" from "refused" reports data erased that is not.
   */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * One page of core's ONE `Page` shape: `nextCursor` exists exactly when another object does,
   * so a full last page answers `hasMore: false` rather than a cursor to an empty page.
   */
  list(options?: ListOptions): Promise<Page<StorageListEntry>>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  /**
   * What locks one object — its Object Lock retention and legal hold — read back from the disk.
   * `{ legalHold: false }` with no `retention` means nothing does, including on a bucket created
   * without Object Lock. `X_STORAGE_NOT_FOUND` when no object is at the key. Optional, like
   * `registerAs`: every shipped disk answers it, and a third-party driver that does not is a
   * driver with no lock to report.
   */
  retentionOf?(key: string): Promise<ObjectLock>;
  /**
   * Verify a URL THIS disk minted — without surrendering the key it minted with.
   *
   * The other half of `signedUrlBase`, and it was missing for the whole life of the package.
   * `signedUrlBase` is on this interface so the minting half and the verifying half cannot state
   * the base twice; the SECRET is the same pair and stayed closed over inside `localDriver`, so
   * `acceptSignedUpload` — whose `secret:` was required — was reachable from no route that held
   * only a `Storage` registry. That is why the shipped upload path has no mounted `PUT`.
   *
   * Verification and not the secret, deliberately. A member that handed the key back would let any
   * holder of a driver MINT a URL for any key, and would put it in every `JSON.stringify(disk)` a
   * log or an error payload performs. A driver can answer "did I sign this?" without that.
   *
   * Optional, like `registerAs`: a disk whose URLs are the provider's (`s3`) verifies at the
   * provider and never reaches this path, and a third-party driver that implements neither is
   * refused by name (`X_STORAGE_URL_UNVERIFIABLE`) rather than reported as a bad signature.
   */
  /**
   * An upload in parts: resumable, and past S3's 5 GiB single-PUT ceiling. Optional, so a
   * third-party driver still compiles; `grantMultipart` refuses a disk without it
   * (`X_STORAGE_MULTIPART_UNSUPPORTED`). Every shipped disk has one.
   */
  readonly multipart?: MultipartCapability | undefined;
  verifySigned?(input: {
    readonly url: string;
    /** Overrides the driver's own, so a test's frozen clock still governs expiry. */
    readonly clock?: Clock | undefined;
  }): Promise<SignedUrlVerification>;
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_LIST_LIMIT = 1000;

/**
 * The page size a `list()` honours — refused rather than clamped when it cannot be one.
 *
 * At the `ListOptions` seam and not inside a driver, because the two answered a non-positive
 * limit differently: the local disk sliced `[0, 0)` and then dropped its own "more" flag, so
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

const isStringRecord = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');

/**
 * What `put()` was told ABOUT the bytes, held to its type before a byte moves. An untyped caller's
 * `metadata: { n: 1n }` reached `JSON.stringify` on the local disk as a bare `TypeError`, and the
 * memory disk stored it — against the `Record<string, string>` every reader is typed on.
 */
/** A streamed read's options: the revision it may serve. */
export interface StreamOptions {
  /** The etag a `stat()` answered; any other revision is refused rather than served. */
  readonly etag?: string | undefined;
}

/** Printable ASCII: what one HTTP header value may carry, on the way in and on the way out. */
export const HEADER_VALUE = /^[\x20-\x7e]*$/;

export function assertPutOptions(driver: string, options: PutOptions | undefined): void {
  if (options === undefined) return;
  for (const name of ['contentType', 'cacheControl'] as const) {
    const value = options[name];
    assert(
      value === undefined || typeof value === 'string',
      `put() on the ${driver} disk was given a ${name} that is not a string`,
      `put(key, body, { ${name}: 'a string' }) — or omit ${name}`,
    );
    // Served back as a header on every disk and SENT as one on s3: a line break is a second
    // header, and on the signed wire a refused one read as a lost answer.
    assert(
      value === undefined || HEADER_VALUE.test(value),
      `put() on the ${driver} disk was given a ${name} that cannot travel as a header (${describeValue(value)})`,
      `put(key, body, { ${name}: 'text/plain' }) — printable ASCII, no line breaks`,
    );
  }
  assert(
    options.metadata === undefined || isStringRecord(options.metadata),
    `put() on the ${driver} disk was given metadata that is not a plain object of string values`,
    "put(key, body, { metadata: { name: 'value' } }) — every value a string: String(n) a number, JSON.stringify anything nested",
  );
}

/**
 * The number a signed URL holds, screened on every disk: `contentLength` when there is one, since it
 * is the tighter fact, and a `contentLength` past `maxBytes` or on anything but a `PUT` is a call
 * that contradicts itself.
 */
export function signedByteBound(
  driver: string,
  options: SignedUrlOptions | undefined,
): number | undefined {
  const length = options?.contentLength;
  if (length === undefined) return options?.maxBytes;
  const maxBytes = options?.maxBytes;
  assert(
    Number.isSafeInteger(length) && length >= 0,
    `signedUrl() on the ${driver} disk was given a contentLength that is not a whole byte count`,
    "signedUrl(key, { method: 'PUT', contentLength: file.size })",
  );
  assert(
    options?.method === 'PUT',
    `signedUrl() on the ${driver} disk was given a contentLength on a read, which has no body to bind`,
    "signedUrl(key, { method: 'PUT', contentLength: file.size })",
  );
  assert(
    maxBytes === undefined || length <= maxBytes,
    `signedUrl() on the ${driver} disk was given a contentLength of ${length}B past its maxBytes of ${String(maxBytes)}B`,
    "signedUrl(key, { method: 'PUT', contentLength: file.size })   # at or under maxBytes",
  );
  return length;
}

/** A `prefix` or a `cursor` that is not a string reached `startsWith` and `<=` as whatever it was. */
export function assertListOptions(options: ListOptions | undefined): void {
  for (const name of ['prefix', 'cursor'] as const) {
    const value = options?.[name];
    assert(
      value === undefined || typeof value === 'string' || (name === 'cursor' && value === null),
      `list() was given a ${name} that is not a string`,
      `disk.list({ ${name}: 'a string' }) — or omit ${name}`,
    );
  }
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
  // The type says so; an untyped caller's `put(key, 'a string')` reached `getReader` as a
  // bare `TypeError`.
  assert(
    body instanceof ReadableStream,
    `put() on the ${limit.driver} disk was given a body that is not a Uint8Array, a Blob or a ReadableStream`,
    "put(key, new TextEncoder().encode(text)) — bytes, never a string: encode it, or pass the request's own body stream",
  );
  return readBounded(body, limit);
}

/** The stream half of `toBytes`: the only shape whose length is unknown until it is read. */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: ByteLimit,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const { driver, key, maxBytes } = limit;
  const refuse = (total: number): Error => putTooLarge(driver, key, total, maxBytes);
  await pumpBounded(body, { driver, maxBytes, refuse }, (chunk) => {
    chunks.push(chunk);
  });
  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}

/** base64 SHA-256 — the wire form for `PutOptions.checksum` and `ValidatedUpload.checksum`. */
export function sha256Base64(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('base64');
}

/** Local etag. S3 returns the provider's etag instead, so never compare across drivers. */
export function etagOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 32);
}
