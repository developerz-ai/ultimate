// Single responsibility: the production disk over Bun's native S3 client. One driver covers
// MinIO, Cloudflare R2 and AWS — the difference is `endpoint` + `forcePathStyle`, nothing else.
// The client is built lazily on first use so importing this module never opens a socket, and
// credentials arrive as env var NAMES: a literal key in app.config.ts is a key in git.

import { ConfigInvalidError, EnvMissingError, finiteCount, stringField } from '@ultimat3/core';
import {
  DEFAULT_CONTENT_TYPE,
  type ListOptions,
  type ListPage,
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
import {
  checksumMismatch,
  deleteFailed,
  listFailed,
  objectNotFound,
  storageNotImplemented,
} from './errors';
import { assertSafeKey } from './path';
import { assertFiniteSignedUrlBound } from './signed-url';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

const DRIVER_NAME = 's3';

/** Structural view of `Bun.S3Client` — typing it here keeps `bun-types` out of the contract. */
export interface S3FileLike {
  /** `S3FileLike` is in the union because Bun's own `write` takes an `S3File` — that is `copy`. */
  write(data: Uint8Array | Blob | S3FileLike, options?: { type?: string }): Promise<number>;
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
  delete(): Promise<void>;
  stream(): ReadableStream<Uint8Array>;
  stat(): Promise<S3StatLike>;
  presign(options: { method?: string; expiresIn?: number; type?: string }): string;
}

export interface S3StatLike {
  readonly size: number;
  readonly type?: string | undefined;
  readonly etag?: string | undefined;
  readonly lastModified?: string | Date | undefined;
}

export interface S3ListEntryLike {
  readonly key?: string | undefined;
  readonly size?: number | undefined;
  readonly eTag?: string | undefined;
  readonly lastModified?: string | Date | undefined;
}

export interface S3ListResultLike {
  readonly contents?: readonly S3ListEntryLike[] | undefined;
  readonly isTruncated?: boolean | undefined;
  readonly nextContinuationToken?: string | undefined;
}

export interface S3ClientLike {
  file(key: string): S3FileLike;
  list(input: {
    prefix?: string;
    maxKeys?: number;
    continuationToken?: string;
  }): Promise<S3ListResultLike>;
}

export interface S3DriverOptions {
  readonly bucket: string;
  readonly region?: string | undefined;
  /** MinIO: `http://localhost:9000`. R2: `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint?: string | undefined;
  /** MinIO needs `true`; AWS and R2 do not. */
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
   * Ceiling on ONE server-side `put()`, because `put()` buffers the whole body. Defaults to the
   * upload policy's ceiling — the same number for the same fact. Raise it for a disk that really
   * does write large objects from the server; a user upload belongs on `grantUpload` instead,
   * and S3's single-PUT limit is 5GB regardless of what this says.
   */
  readonly maxPutBytes?: number | undefined;
}

interface S3ClientConstructor {
  new (options: Record<string, unknown>): S3ClientLike;
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  partner: string,
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new EnvMissingError({
      cause: `${name} is not set, so the s3 disk cannot authenticate`,
      fix: `set ${name} and ${partner} in .env (or the container's secret store), then re-run`,
      meta: { missing: name },
    });
  }
  return value;
}

function buildClient(options: S3DriverOptions): S3ClientLike {
  if (options.client !== undefined) return options.client;
  if (options.bucket === '') {
    throw new ConfigInvalidError({
      cause: 's3 disk was defined without a bucket',
      fix: 'set storage.disks.<name>.bucket in app.config.ts',
    });
  }
  const env = options.env ?? process.env;
  const idVar = options.accessKeyIdEnv ?? 'S3_ACCESS_KEY_ID';
  const secretVar = options.secretAccessKeyEnv ?? 'S3_SECRET_ACCESS_KEY';
  const Client = (Bun as unknown as { S3Client?: S3ClientConstructor }).S3Client;
  if (Client === undefined) {
    throw new ConfigInvalidError({
      cause: 'Bun.S3Client is unavailable in this runtime',
      fix: 'upgrade the runtime: bun upgrade   # the s3 disk needs bun >= 1.3',
    });
  }
  const tokenVar = options.sessionTokenEnv;
  const sessionToken = tokenVar === undefined ? undefined : env[tokenVar];
  // Bun's flag is the inverse: MinIO's path style means "not virtual hosted".
  const pathStyle = options.forcePathStyle;
  return new Client({
    bucket: options.bucket,
    accessKeyId: requireEnv(env, idVar, secretVar),
    secretAccessKey: requireEnv(env, secretVar, idVar),
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(pathStyle === undefined ? {} : { virtualHostedStyle: !pathStyle }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  });
}

const toDate = (value: string | Date | undefined): Date =>
  value === undefined ? new Date(0) : value instanceof Date ? value : new Date(value);

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
function isAbsentObject(error: unknown): boolean {
  const code = stringField(error, 'code');
  if (code !== undefined && ABSENT_OBJECT_CODES.has(code)) return true;
  return numberField(error, 'statusCode') === 404 || numberField(error, 'status') === 404;
}

/**
 * Everything `put()` may be handed that this driver cannot honour, refused before a byte moves.
 * A typed refusal at the call site is the whole point: `serverSideEncryption` exists on
 * `PutOptions` so that "this disk cannot prove per-object encryption" is something an engineer
 * meets while writing the call, not while answering a security review.
 */
function refuseUnsupportedPut(bucket: string, key: string, putOptions?: PutOptions): void {
  if (putOptions?.metadata !== undefined || putOptions?.cacheControl !== undefined) {
    const uri = `s3://${bucket}/${key}`;
    throw storageNotImplemented(
      'user metadata and cache-control on the s3 driver (Bun exposes no header hook yet)',
      `drop metadata/cacheControl from put(), or set them out of band: ` +
        `aws s3 cp ${uri} ${uri} --metadata-directive REPLACE`,
    );
  }
  const sse = putOptions?.serverSideEncryption;
  if (sse === undefined) return;
  const rule =
    sse.algorithm === 'aws:kms'
      ? `{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"${sse.kmsKeyId ?? '<key-arn>'}"}`
      : '{"SSEAlgorithm":"AES256"}';
  throw storageNotImplemented(
    'per-object server-side encryption on the s3 driver (Bun.S3Client exposes acl, storageClass and type, and nothing for x-amz-server-side-encryption)',
    `set it bucket-wide, then drop serverSideEncryption from put(): aws s3api put-bucket-encryption --bucket ${bucket} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":${rule},"BucketKeyEnabled":true}]}'`,
  );
}

export function s3Driver(options: S3DriverOptions): StorageDriver {
  const maxPutBytes = finiteCount(
    'the s3 driver',
    'maxPutBytes',
    options.maxPutBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    1,
  );
  let client: S3ClientLike | undefined;
  const conn = (): S3ClientLike => {
    client ??= buildClient(options);
    return client;
  };

  const statObject = async (key: string): Promise<StorageObject> => {
    const stat = await conn().file(key).stat();
    return {
      key,
      size: stat.size,
      contentType: stat.type ?? DEFAULT_CONTENT_TYPE,
      etag: stat.etag ?? '',
      lastModified: toDate(stat.lastModified),
    };
  };

  return {
    name: DRIVER_NAME,

    async put(key: string, body: StorageBody, putOptions?: PutOptions): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      refuseUnsupportedPut(options.bucket, safe, putOptions);
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
      await conn()
        .file(safe)
        .write(bytes, { type: putOptions?.contentType ?? DEFAULT_CONTENT_TYPE });
      return statObject(safe);
    },

    async get(key: string): Promise<StorageRead> {
      const safe = assertSafeKey(key);
      const file = conn().file(safe);
      if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, safe);
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { object: await statObject(safe), bytes };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const safe = assertSafeKey(key);
      const file = conn().file(safe);
      if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, safe);
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
      if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, source);
      const stat = await file.stat();
      await conn()
        .file(destination)
        .write(file, { type: stat.type ?? DEFAULT_CONTENT_TYPE });
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
        throw deleteFailed(
          DRIVER_NAME,
          safe,
          error,
          `grant s3:DeleteObject on this prefix to the app's role, then reproduce with the provider's own words: aws s3api delete-object --bucket ${options.bucket} --key ${safe}`,
        );
      }
    },

    async exists(key: string): Promise<boolean> {
      return conn().file(assertSafeKey(key)).exists();
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const prefix = listOptions?.prefix ?? '';
      // Refused at the seam both drivers share, before the provider is asked: `maxKeys: 0` used to
      // go straight through, while the local disk answered a complete-looking empty page.
      const maxKeys = resolveListLimit(listOptions?.limit);
      // `conn()` OUTSIDE the try: a missing credential or an absent `Bun.S3Client` is this disk
      // misconfigured, and it already answers with its own code and its own fix.
      const client = conn();
      let result: S3ListResultLike;
      try {
        result = await client.list({
          maxKeys,
          ...(listOptions?.prefix === undefined ? {} : { prefix: listOptions.prefix }),
          ...(listOptions?.cursor === undefined ? {} : { continuationToken: listOptions.cursor }),
        });
      } catch (error) {
        // A bare `S3Error` used to escape here, uncoded: no `X_*`, no `fix`, no `--json` shape, and
        // `@ultimat3/http`'s error map has nothing to turn it into but a 500. A denied
        // `s3:ListBucket` is the commonest one and reads to an operator as an app crash.
        throw listFailed(
          DRIVER_NAME,
          prefix,
          error,
          `grant s3:ListBucket on this bucket to the app's role, then reproduce with the provider's own words: aws s3api list-objects-v2 --bucket ${options.bucket}${prefix === '' ? '' : ` --prefix ${prefix}`}`,
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
          lastModified: toDate(entry.lastModified),
        });
      }
      const cursor = result.nextContinuationToken;
      return result.isTruncated === true && cursor !== undefined
        ? { objects, truncated: true, cursor }
        : { objects, truncated: false };
    },

    /**
     * Provider presigning. The signature covers method, expiry and content type but NOT
     * `maxBytes` — S3 has no header for it, so size stays a server-side policy check.
     */
    async signedUrl(key: string, urlOptions?: SignedUrlOptions): Promise<string> {
      // Screened with the SAME rule `buildSignedUrl` applies on the local disk: `Math.ceil(NaN /
      // 1000)` is `NaN`, so `X-Amz-Expires=NaN` went to AWS and the app got a 403 on a link it
      // believed it had just minted.
      const expiresInMs = assertFiniteSignedUrlBound(
        'expiresInMs',
        urlOptions?.expiresInMs ?? 900_000,
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
