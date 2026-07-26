// Single responsibility: the production disk over Bun's native S3 client. One driver covers
// MinIO, Cloudflare R2 and AWS — the difference is `endpoint` + `forcePathStyle`, nothing else.
// The client is built lazily on first use so importing this module never opens a socket, and
// credentials arrive as env var NAMES: a literal key in app.config.ts is a key in git.

import { ConfigInvalidError, EnvMissingError } from '@ultimat3/core';
import {
  DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  type ListPage,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBody,
  type StorageDriver,
  type StorageObject,
  type StorageRead,
  sha256Base64,
  toBytes,
} from './driver';
import { checksumMismatch, objectNotFound, storageNotImplemented } from './errors';
import { assertSafeKey } from './path';

const DRIVER_NAME = 's3';

/** Structural view of `Bun.S3Client` — typing it here keeps `bun-types` out of the contract. */
export interface S3FileLike {
  write(data: Uint8Array | Blob, options?: { type?: string }): Promise<number>;
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

export function s3Driver(options: S3DriverOptions): StorageDriver {
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
      if (putOptions?.metadata !== undefined || putOptions?.cacheControl !== undefined) {
        const uri = `s3://${options.bucket}/${safe}`;
        throw storageNotImplemented(
          'user metadata and cache-control on the s3 driver (Bun exposes no header hook yet)',
          `drop metadata/cacheControl from put(), or set them out of band: ` +
            `aws s3 cp ${uri} ${uri} --metadata-directive REPLACE`,
        );
      }
      // Buffered on purpose: size and checksum must be known before the object exists.
      // Multipart streaming upload is a later optimisation, not a correctness change.
      const bytes = await toBytes(body);
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

    async delete(key: string): Promise<void> {
      await conn()
        .file(assertSafeKey(key))
        .delete()
        .catch(() => undefined);
    },

    async exists(key: string): Promise<boolean> {
      return conn().file(assertSafeKey(key)).exists();
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const result = await conn().list({
        maxKeys: listOptions?.limit ?? DEFAULT_LIST_LIMIT,
        ...(listOptions?.prefix === undefined ? {} : { prefix: listOptions.prefix }),
        ...(listOptions?.cursor === undefined ? {} : { continuationToken: listOptions.cursor }),
      });
      const objects: StorageObject[] = [];
      for (const entry of result.contents ?? []) {
        if (entry.key === undefined) continue;
        objects.push({
          key: entry.key,
          size: entry.size ?? 0,
          contentType: DEFAULT_CONTENT_TYPE,
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
      const expiresInMs = urlOptions?.expiresInMs ?? 900_000;
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
