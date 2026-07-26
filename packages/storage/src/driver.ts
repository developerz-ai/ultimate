// Single responsibility: the driver contract every disk implements, plus the byte helpers all
// drivers share (body normalisation, SHA-256 etag/checksum). Bytes never travel as strings —
// a base64 round trip through JSON is how a "small" upload becomes a 33%-larger OOM.

export type StorageBody = Uint8Array | ReadableStream<Uint8Array> | Blob;

export interface StorageObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface PutOptions {
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** base64 SHA-256 of the body. Supplied means verified: a mismatch is a rejected write. */
  readonly checksum?: string | undefined;
}

export interface ListOptions {
  readonly prefix?: string | undefined;
  /** Opaque; pass back the `cursor` of the previous page. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListPage {
  readonly objects: readonly StorageObject[];
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
  /** Constrains a `PUT`: the signature covers it, so a client cannot widen it. */
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
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(options?: ListOptions): Promise<ListPage>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_LIST_LIMIT = 1000;

export async function toBytes(body: StorageBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** base64 SHA-256 — the wire form for `PutOptions.checksum` and `ValidatedUpload.checksum`. */
export function sha256Base64(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('base64');
}

/** Local etag. S3 returns the provider's etag instead, so never compare across drivers. */
export function etagOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 32);
}
