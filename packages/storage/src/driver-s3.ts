// Single responsibility: the production disk over Bun's native S3 client. One driver covers AWS,
// Cloudflare R2 and any S3-compatible gateway — the difference is `endpoint`, `region` and
// `forcePathStyle`, nothing else.
// The client is built lazily on first use so importing this module never opens a socket, and
// credentials arrive as env var NAMES: a literal key in app.config.ts is a key in git.

import {
  type Clock,
  finiteCount,
  isUltimateError,
  NotImplementedError,
  type Page,
  pageOf,
  renderFixLiteral,
  renderFixShellArg,
  systemClock,
} from '@ultimat3/core';
import {
  assertListOptions,
  assertPutOptions,
  DEFAULT_CONTENT_TYPE,
  type ListOptions,
  type PutOptions,
  resolveListLimit,
  type SignedUrlOptions,
  type StorageBody,
  type StorageDriver,
  type StorageListEntry,
  type StorageObject,
  type StorageRead,
  sha256Base64,
  toBytes,
} from './driver';
import { isAbsentObject } from './driver-s3-absent';
import { buildClient, type S3ClientLike, type S3ListResultLike } from './driver-s3-client';
import { needsSignedPut, readObjectLock, signedPut } from './driver-s3-lock';
import { regionMismatch } from './driver-s3-region';
import type { S3FetchLike } from './driver-s3-signed';
import {
  checksumMismatch,
  deleteFailed,
  getTooLarge,
  isStorageError,
  listFailed,
  objectNotFound,
  putFailed,
  readFailed,
} from './errors';
import { assertObjectLockOptions, type ObjectLock } from './object-lock';
import { assertSafeKey } from './path';
import { DEFAULT_SIGNED_URL_TTL_MS } from './signed-url';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

const DRIVER_NAME = 's3';

export interface S3DriverOptions {
  readonly bucket: string;
  /**
   * The region requests are signed for. Unset, `Bun.S3Client` signs for `auto` — which R2 wants,
   * and which AWS and a gateway that checks the scope refuse (`X_CONFIG_INVALID`, naming theirs).
   */
  readonly region?: string | undefined;
  /** A self-hosted gateway: `http://localhost:9000`. R2: `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint?: string | undefined;
  /** A gateway addressed by host and port needs `true`; AWS and R2 do not. */
  readonly forcePathStyle?: boolean | undefined;
  /** Env var NAME holding the key id. Default `S3_ACCESS_KEY_ID`. */
  readonly accessKeyIdEnv?: string | undefined;
  /** Env var NAME holding the secret. Default `S3_SECRET_ACCESS_KEY`. */
  readonly secretAccessKeyEnv?: string | undefined;
  readonly sessionTokenEnv?: string | undefined;
  /** Injected in tests; production reads `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Injected in tests; production constructs `Bun.S3Client`. */
  readonly client?: S3ClientLike | undefined;
  /**
   * Injected in tests; production uses the global `fetch`. Carries the SIGNED requests the Bun
   * client has no option for — a `put()` with `metadata`, `cacheControl`, `retention` or
   * `legalHold`, and `retentionOf()` — signed by core's `signAwsRequest` against the same
   * endpoint, region and credentials.
   */
  readonly fetch?: S3FetchLike | undefined;
  /** Signs the signed requests and screens a `retainUntil`. Default `systemClock`. */
  readonly clock?: Clock | undefined;
  /**
   * Ceiling on ONE server-side `put()`, because `put()` buffers the whole body. Defaults to the
   * upload policy's ceiling — the same number for the same fact. Raise it for a disk that really
   * does write large objects from the server; a user upload belongs on `grantUpload` instead,
   * and S3's single-PUT limit is 5GB regardless of what this says.
   */
  readonly maxPutBytes?: number | undefined;
  /**
   * Ceiling on ONE `get()`, because `get()` buffers the whole object — and on this disk nothing
   * bounds what a presigned PUT stored (`SignedUrlOptions.maxBytes`). Defaults to `maxPutBytes`;
   * an object past it is read with `stream()`.
   */
  readonly maxGetBytes?: number | undefined;
}

/**
 * A missing `LastModified` is ABSENT, never `new Date(0)`: epoch 0 is older than every window, so
 * `sweepOrphans` deleted an upload on the strength of a field the provider never sent.
 */
const dated = (value: string | Date | undefined): { readonly lastModified?: Date } =>
  value === undefined ? {} : { lastModified: value instanceof Date ? value : new Date(value) };

/**
 * Everything `put()` may be handed that this driver cannot honour, refused before a byte moves.
 * A typed refusal at the call site is the whole point: `serverSideEncryption` exists on
 * `PutOptions` so that "this disk cannot prove per-object encryption" is something an engineer
 * meets while writing the call, not while answering a security review.
 */
function refuseUnsupportedPut(bucket: string, putOptions?: PutOptions): void {
  const sse = putOptions?.serverSideEncryption;
  if (sse === undefined) return;
  // The key id is the caller's own option, spliced into single-quoted JSON: `renderFixLiteral`
  // escapes the `"` and `\` JSON needs, and a `'` — the one byte live inside single quotes — makes
  // it the placeholder rather than ending the argument (plan 101 row S12).
  const keyId = sse.kmsKeyId?.includes("'") === false ? sse.kmsKeyId : undefined;
  const bucketArg = renderFixShellArg(bucket, "'<bucket>'");
  throw new NotImplementedError({
    cause:
      'per-object server-side encryption on the s3 driver (Bun.S3Client exposes acl, storageClass and type, and nothing for x-amz-server-side-encryption) is not implemented by this driver — set it bucket-wide with the command in fix, then drop serverSideEncryption from put()',
    fix:
      sse.algorithm === 'aws:kms'
        ? `aws s3api put-bucket-encryption --bucket ${bucketArg} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":${renderFixLiteral(keyId, '"<key-arn>"')}},"BucketKeyEnabled":true}]}'`
        : `aws s3api put-bucket-encryption --bucket ${bucketArg} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'`,
  });
}

export function s3Driver(options: S3DriverOptions): StorageDriver {
  // `=== undefined`, never `??`: `??` coalesces on `null` too, so an explicitly blanked key in a
  // decoded JSON config took the default instead of the refusal `finiteCount` is here to raise.
  const maxPutBytes = finiteCount(
    'the s3 driver',
    'maxPutBytes',
    options.maxPutBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : options.maxPutBytes,
    1,
  );
  const maxGetBytes = finiteCount(
    'the s3 driver',
    'maxGetBytes',
    options.maxGetBytes === undefined ? maxPutBytes : options.maxGetBytes,
    1,
  );
  // The key `defineStorage` registered this disk under: a not-found `fix:` is `disk('<it>')…`,
  // and the driver kind there is `X_STORAGE_DISK_UNKNOWN` on any app that named its disk.
  let diskName = DRIVER_NAME;
  const clock = options.clock ?? systemClock;
  let client: S3ClientLike | undefined;
  const conn = (): S3ClientLike => {
    client ??= buildClient(options);
    return client;
  };

  /**
   * A refused request as the disk-misconfigured error, when the provider named its own repair (a
   * wrong region). Asked before any call's own verdict, so the fix an operator reads is the one
   * that works rather than one about a grant they already have. `misconfigured` is the same
   * question for a call with no verdict of its own: it rethrows whatever arrived.
   */
  const throwIfMisconfigured = (error: unknown): void => {
    const mismatch = regionMismatch(options.bucket, error);
    if (mismatch !== undefined) throw mismatch;
  };
  /**
   * A write the provider refused, coded: a denied `s3:PutObject`, a throttle, an expired
   * credential. The bare `S3Error` used to escape `put()` and `copy()` exactly as it once escaped
   * `list()` — no code, no fix, an anonymous 500.
   */
  const refusedWrite =
    (key: string) =>
    (error: unknown): never => {
      // A refusal this process already coded — a screened header, a missing credential — is its
      // own answer, never re-read as the provider refusing the write.
      if (isUltimateError(error)) throw error;
      throwIfMisconfigured(error);
      throw putFailed(
        DRIVER_NAME,
        key,
        error,
        `aws s3api get-bucket-policy --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")}`,
      );
    };

  /**
   * A read the provider refused, coded — `refusedWrite`'s twin. A 404 is "not found" wherever it
   * arrives: an object deleted between `exists()` and the read is absent, not unreadable.
   */
  const refusedRead =
    (key: string) =>
    (error: unknown): never => {
      if (isStorageError(error)) throw error;
      if (isAbsentObject(error)) throw objectNotFound(diskName, key);
      throwIfMisconfigured(error);
      throw readFailed(
        DRIVER_NAME,
        key,
        error,
        `aws s3api head-object --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")} --key ${renderFixShellArg(key, "'<key>'")}`,
      );
    };
  const present = (key: string): Promise<boolean> =>
    conn().file(key).exists().catch(refusedRead(key));

  const statObject = async (key: string): Promise<StorageObject> => {
    const stat = await conn().file(key).stat().catch(refusedRead(key));
    return {
      key,
      size: stat.size,
      contentType: stat.type ?? DEFAULT_CONTENT_TYPE,
      etag: stat.etag ?? '',
      ...dated(stat.lastModified),
    };
  };

  return {
    name: DRIVER_NAME,
    registerAs(name: string): void {
      diskName = name;
    },

    async put(key: string, body: StorageBody, putOptions?: PutOptions): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      refuseUnsupportedPut(options.bucket, putOptions);
      assertPutOptions(DRIVER_NAME, putOptions);
      assertObjectLockOptions(DRIVER_NAME, putOptions, clock);
      // Buffered on purpose: size and checksum must be known before the object exists — so this
      // path is for objects that FIT IN MEMORY, and `maxPutBytes` is what makes that a contract
      // rather than a hope. User uploads never come through here: they go direct to the bucket
      // via `grantUpload`, which is the architecture, not a later optimisation.
      const bytes = await toBytes(body, { driver: DRIVER_NAME, key: safe, maxBytes: maxPutBytes });
      const claimed = putOptions?.checksum;
      if (claimed !== undefined) {
        const actual = sha256Base64(bytes);
        if (claimed !== actual) throw checksumMismatch(safe, claimed, actual);
      }
      if (putOptions !== undefined && needsSignedPut(putOptions)) {
        // Off the Bun client only for what it cannot send: `S3File.write` takes a type, an ACL and
        // a storage class and no header. One request either way — never a PUT then a second call.
        const refusal = await signedPut(options, safe, bytes, putOptions).catch(refusedWrite(safe));
        if (refusal !== undefined) refusedWrite(safe)(refusal);
        // Stored — the PUT succeeded with them — so reported, as the local disk reports its own.
        return {
          ...(await statObject(safe)),
          ...(putOptions.cacheControl === undefined
            ? {}
            : { cacheControl: putOptions.cacheControl }),
          ...(putOptions.metadata === undefined ? {} : { metadata: { ...putOptions.metadata } }),
        };
      }
      await conn()
        .file(safe)
        .write(bytes, { type: putOptions?.contentType ?? DEFAULT_CONTENT_TYPE })
        .catch(refusedWrite(safe));
      return statObject(safe);
    },

    async stat(key: string): Promise<StorageObject | undefined> {
      const safe = assertSafeKey(key);
      return (await present(safe)) ? statObject(safe) : undefined;
    },

    async get(key: string): Promise<StorageRead> {
      const safe = assertSafeKey(key);
      const file = conn().file(safe);
      if (!(await present(safe))) throw objectNotFound(diskName, safe);
      // The HEAD comes FIRST, and it is the whole point: a client PUT straight into the bucket is
      // bounded by nothing on this disk, so `arrayBuffer()` on whatever is there was heap growth
      // the uploader chose. Refused on the provider's own size before a byte is read.
      const object = await statObject(safe);
      if (object.size > maxGetBytes) throw getTooLarge(DRIVER_NAME, safe, object.size, maxGetBytes);
      const bytes = new Uint8Array(await file.arrayBuffer().catch(refusedRead(safe)));
      return { object, bytes };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const safe = assertSafeKey(key);
      const file = conn().file(safe);
      if (!(await present(safe))) throw objectNotFound(diskName, safe);
      return file.stream();
    },

    /**
     * Bytes from one key to another without a round trip through this process. Bun exposes no
     * `CopyObject`, so the source `S3File` is handed to `write()` — Bun's own union accepts one —
     * and the bytes move inside Bun rather than through the app's heap. That is the half of the
     * win available today: promoting a 500MB attachment used to be `get()` + `put()`, a full GB
     * resident in the pod. A true server-side copy needs a Bun API that does not exist in 1.3.
     */
    async copy(from: string, to: string): Promise<StorageObject> {
      const source = assertSafeKey(from);
      const destination = assertSafeKey(to);
      const file = conn().file(source);
      if (!(await present(source))) throw objectNotFound(diskName, source);
      const stat = await file.stat().catch(refusedRead(source));
      await conn()
        .file(destination)
        .write(file, { type: stat.type ?? DEFAULT_CONTENT_TYPE })
        .catch(refusedWrite(destination));
      return statObject(destination);
    },

    async delete(key: string): Promise<void> {
      const safe = assertSafeKey(key);
      try {
        await conn().file(safe).delete();
      } catch (error) {
        // Idempotent means an ABSENT key, and nothing else. AWS answers DELETE on a missing key
        // with 204, so this branch is for the providers that do not.
        if (isAbsentObject(error)) return;
        throwIfMisconfigured(error);
        throw deleteFailed(
          DRIVER_NAME,
          safe,
          error,
          // `isSafeKey` admits `$(…)`, a backtick and `;` — legal key bytes, live shell syntax.
          `grant s3:DeleteObject on this prefix to the app's role, then reproduce with the provider's own words: aws s3api delete-object --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")} --key ${renderFixShellArg(safe, "'<key>'")}`,
        );
      }
    },

    async exists(key: string): Promise<boolean> {
      return present(assertSafeKey(key));
    },

    /** Signed `GET ?retention` and `?legal-hold`, in parallel. A bucket with no lock reports none. */
    async retentionOf(key: string): Promise<ObjectLock> {
      const safe = assertSafeKey(key);
      const read = await readObjectLock(options, safe).catch(refusedRead(safe));
      if (read.kind === 'lock') return read.lock;
      if (isAbsentObject(read.refusal)) throw objectNotFound(diskName, safe);
      throwIfMisconfigured(read.refusal);
      throw readFailed(
        DRIVER_NAME,
        safe,
        read.refusal,
        `aws s3api get-object-retention --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")} --key ${renderFixShellArg(safe, "'<key>'")}   # reproduces the refusal; grant s3:GetObjectRetention and s3:GetObjectLegalHold to the app's role`,
      );
    },

    async list(listOptions?: ListOptions): Promise<Page<StorageListEntry>> {
      const prefix = listOptions?.prefix ?? '';
      // Refused at the seam both drivers share, before the provider is asked: `maxKeys: 0` used to
      // go straight through, while the local disk answered a complete-looking empty page.
      assertListOptions(listOptions);
      const maxKeys = resolveListLimit(listOptions?.limit);
      // `conn()` OUTSIDE the try: a missing credential or an absent `Bun.S3Client` is this disk
      // misconfigured, and it already answers with its own code and its own fix.
      const client = conn();
      let result: S3ListResultLike;
      try {
        result = await client.list({
          maxKeys,
          ...(listOptions?.prefix === undefined ? {} : { prefix: listOptions.prefix }),
          ...(typeof listOptions?.cursor === 'string'
            ? { continuationToken: listOptions.cursor }
            : {}),
        });
      } catch (error) {
        // A bare `S3Error` used to escape here, uncoded: no `X_*`, no `fix`, no `--json` shape, and
        // `@ultimat3/http`'s error map has nothing to turn it into but a 500. A denied
        // `s3:ListBucket` is the commonest one and reads to an operator as an app crash.
        throwIfMisconfigured(error);
        throw listFailed(
          DRIVER_NAME,
          prefix,
          error,
          // Two whole lines rather than a ternary INSIDE one: each substitution is then a screen
          // the fix-shell-arg guard can read as one.
          prefix === ''
            ? `grant s3:ListBucket on this bucket to the app's role, then reproduce with the provider's own words: aws s3api list-objects-v2 --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")}`
            : `grant s3:ListBucket on this bucket to the app's role, then reproduce with the provider's own words: aws s3api list-objects-v2 --bucket ${renderFixShellArg(options.bucket, "'<bucket>'")} --prefix ${renderFixShellArg(prefix, "'<prefix>'")}`,
        );
      }
      const objects: StorageListEntry[] = [];
      for (const entry of result.contents ?? []) {
        if (entry.key === undefined) continue;
        // No `contentType`. ListObjectsV2 does not return one, and reading it for real would
        // cost one HeadObject per listed row — which is what `list()` exists to avoid. It used
        // to report `application/octet-stream`, indistinguishable from an object that really is
        // one, while the local driver reported the truth from its sidecar: a caller filtering a
        // listing by content type got everything on `local` and nothing on `s3`. Absent now.
        objects.push({
          key: entry.key,
          size: entry.size ?? 0,
          etag: entry.eTag ?? '',
          ...dated(entry.lastModified),
        });
      }
      // `IsTruncated` decides and `NextContinuationToken` is the cursor: a token beside
      // `IsTruncated: false` is not a next page, and a truncated answer with no token has none to
      // offer — both are the last page, never a cursor that fetches an empty one.
      return pageOf(
        objects,
        result.isTruncated === true ? (result.nextContinuationToken ?? null) : null,
      );
    },

    /**
     * Provider presigning. The signature covers method, expiry and content type but NOT
     * `maxBytes` — S3 has no header for it, so size stays a server-side policy check.
     */
    async signedUrl(key: string, urlOptions?: SignedUrlOptions): Promise<string> {
      // Screened with the SAME function `buildSignedUrl` applies on the local disk — one
      // finite-bound path for both presigners, never a private copy per package: `Math.ceil(NaN /
      // 1000)` is `NaN`, so `X-Amz-Expires=NaN` went to AWS and the app got a 403 on a link it
      // believed it had just minted. `=== undefined` rather than `??`, so an explicit `null` is
      // refused instead of silently taking the default.
      const expiresInMs = finiteCount(
        'the s3 driver',
        'expiresInMs',
        urlOptions?.expiresInMs === undefined ? DEFAULT_SIGNED_URL_TTL_MS : urlOptions.expiresInMs,
        1,
      );
      return conn()
        .file(assertSafeKey(key))
        .presign({
          method: urlOptions?.method ?? 'GET',
          expiresIn: Math.ceil(expiresInMs / 1000),
          ...(urlOptions?.contentType === undefined ? {} : { type: urlOptions.contentType }),
        });
    },
  };
}
