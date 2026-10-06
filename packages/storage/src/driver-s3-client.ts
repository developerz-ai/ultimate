// Single responsibility: the s3 disk's view of `Bun.S3Client` — the structural types its methods
// are called through (so `bun-types` stays out of the public contract and a test injects a fake),
// and the one place the real client is constructed, lazily, from the disk's options.

import { ConfigInvalidError } from '@ultimat3/core';
import type { S3DriverOptions } from './driver-s3';
import { requireEnv } from './driver-s3-signed';

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

interface S3ClientConstructor {
  new (options: Record<string, unknown>): S3ClientLike;
}

export function buildClient(options: S3DriverOptions): S3ClientLike {
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
  // Bun's flag is the inverse: path style means "not virtual hosted".
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
