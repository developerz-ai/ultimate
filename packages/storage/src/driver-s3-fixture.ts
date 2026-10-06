// The in-memory `Bun.S3Client` stand-in the s3 driver's tests drive, and the helpers that read
// its answers. Shared rather than copied because `driver-s3.test.ts` (reads, copies, listings,
// credentials) and `driver-s3-put.test.ts` (everything `put()` refuses) must exercise the SAME
// fake — two fakes drifting apart would be two providers, agreeing only by construction.

import type { S3ClientLike, S3FileLike, S3ListResultLike, S3StatLike } from './driver-s3-client';
import type { S3FetchLike } from './driver-s3-signed';
import { isStorageError, objectNotFound } from './errors';

/** The driver's private `DRIVER_NAME`; the fake reports failures against the same disk. */
export const FAKE_DISK = 's3';

export interface FakeObject {
  bytes: Uint8Array;
  type?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | Date | undefined;
}

/** One signed request the driver sent past the Bun client, exactly as it went on the wire. */
export interface SignedCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
}

/** The lock the fake provider recorded from a PUT's `x-amz-object-lock-*` headers. */
export interface FakeLock {
  mode?: string | undefined;
  retainUntil?: string | undefined;
  legalHold?: string | undefined;
}

/** Credentials the signed path reads; the Bun client is injected and never asks. */
export const FAKE_ENV = { S3_ACCESS_KEY_ID: 'fake-id', S3_SECRET_ACCESS_KEY: 'fake-secret' };

const xmlError = (code: string, message: string, status: number): Response =>
  new Response(
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: { 'content-type': 'application/xml' },
    },
  );

export interface PresignCall {
  key: string;
  options: {
    method?: string | undefined;
    expiresIn?: number | undefined;
    type?: string | undefined;
  };
}

export interface ListCall {
  prefix?: string | undefined;
  maxKeys?: number | undefined;
  continuationToken?: string | undefined;
}

/**
 * What Bun hands back when the SERVICE refuses: an ordinary `Error` named `S3Error`, carrying the
 * provider's own code and status. The driver must read those structurally, because nothing in the
 * type system says a caught value has them.
 */
export function s3Error(code: string, statusCode: number, key: string): Error {
  return Object.assign(new Error(`${code}: the fake provider refused ${key}`), {
    name: 'S3Error',
    code,
    statusCode,
    path: key,
  });
}

/** In-memory stand-in for `Bun.S3Client`, driven through `S3ClientLike` — no socket, ever. */
export class FakeS3Client implements S3ClientLike {
  readonly store = new Map<string, FakeObject>();
  readonly fileCalls: string[] = [];
  readonly presignCalls: PresignCall[] = [];
  readonly listCalls: ListCall[] = [];
  listResult: S3ListResultLike = { contents: [] };
  /** A provider REFUSAL (403/503/reset) — the failure `delete()` must surface, not swallow. */
  failDeleteFor: string | undefined;
  /** A provider "there is nothing there" — the one failure `delete()` may call success. */
  absentDeleteFor: string | undefined;
  /**
   * A refused LISTING — a denied `s3:ListBucket`, a throttle, an expired credential. There is no
   * "absent" counterpart: a prefix with no keys is an empty page, never a rejection, so every
   * failure `list()` can meet is one it must surface.
   */
  failListWith: Error | undefined;

  /** A refused READ — a denied `s3:GetObject`, a throttle. Raised by `exists`, `stat` and the body read. */
  failReadWith: Error | undefined;
  /** A refused HEAD only, so a test can let the write through and fail the stat that follows it. */
  failStatWith: Error | undefined;
  /** Narrows `failStatWith` to ONE key — a copy's destination, whose source must still stat. */
  failStatFor: string | undefined;
  /** A refused BODY read only: `exists()` and the HEAD succeed, and the GET itself is refused. */
  failBodyWith: Error | undefined;

  /** A refused WRITE — a denied `s3:PutObject`, a throttle. `put()` and `copy()` both write. */
  failWriteWith: Error | undefined;

  /** Every signed request, in order — what `put()` with headers and `retentionOf()` sent. */
  readonly signedCalls: SignedCall[] = [];
  /** Per-key lock, as recorded from the signed PUT's headers. */
  readonly locks = new Map<string, FakeLock>();
  /** Per-key user metadata and cache-control, as recorded from the signed PUT's headers. */
  readonly headersOf = new Map<string, Readonly<Record<string, string>>>();
  /** A bucket created WITHOUT Object Lock: every `?retention` read is `InvalidRequest`. */
  lockDisabled = false;
  /** A refused lock READ — a denied `s3:GetObjectRetention`. */
  failLockReadWith: Error | undefined;

  /**
   * The provider's HTTP face for the signed path, path-style (`/<bucket>/<key>`). Answers with S3's
   * own XML error shapes, so the driver's classification of a refusal is what is under test.
   */
  readonly fetch: S3FetchLike = async (url, init) => {
    const parsed = new URL(url);
    this.signedCalls.push({
      method: init.method,
      url: parsed,
      headers: init.headers,
      body: init.body,
    });
    // Virtual-hosted (`b.<host>/<key>`) or path style (`<host>/b/<key>`) — both are the provider's.
    const virtual = parsed.hostname.startsWith('b.');
    const segments = parsed.pathname.split('/').slice(virtual ? 1 : 2);
    const key = segments.map(decodeURIComponent).join('/');
    const asXml = (error: Error): Response => {
      const fields = error as Error & { code?: string; statusCode?: number };
      return xmlError(fields.code ?? 'InternalError', error.message, fields.statusCode ?? 500);
    };
    if (init.method === 'PUT') {
      if (this.failWriteWith !== undefined) return asXml(this.failWriteWith);
      const headers = init.headers;
      this.store.set(key, { bytes: init.body ?? new Uint8Array(), type: headers['content-type'] });
      this.headersOf.set(key, headers);
      this.locks.set(key, {
        mode: headers['x-amz-object-lock-mode'],
        retainUntil: headers['x-amz-object-lock-retain-until-date'],
        legalHold: headers['x-amz-object-lock-legal-hold'],
      });
      return new Response(null, { status: 200 });
    }
    if (this.failLockReadWith !== undefined) return asXml(this.failLockReadWith);
    if (!this.store.has(key))
      return xmlError('NoSuchKey', 'The specified key does not exist.', 404);
    if (this.lockDisabled) {
      return xmlError('InvalidRequest', 'Bucket is missing Object Lock Configuration', 400);
    }
    const lock = this.locks.get(key);
    const none = xmlError(
      'NoSuchObjectLockConfiguration',
      'The specified object does not have a ObjectLock configuration',
      404,
    );
    if (parsed.search === '?retention=') {
      if (lock?.mode === undefined) return none;
      return new Response(
        `<Retention><Mode>${lock.mode}</Mode><RetainUntilDate>${lock.retainUntil}</RetainUntilDate></Retention>`,
      );
    }
    if (lock?.legalHold === undefined) return none;
    return new Response(`<LegalHold><Status>${lock.legalHold}</Status></LegalHold>`);
  };

  /** Which key each handed-out `S3FileLike` stands for, so `write(sourceFile)` can read it. */
  private readonly fileKeys = new WeakMap<object, string>();

  /** The bytes behind an `S3FileLike` passed as `write`'s data, or `undefined` for raw bytes. */
  sourceOf(data: unknown): Uint8Array | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const sourceKey = this.fileKeys.get(data);
    return sourceKey === undefined ? undefined : this.store.get(sourceKey)?.bytes;
  }

  file(key: string): S3FileLike {
    this.fileCalls.push(key);
    const store = this.store;
    const client = this;
    const handle: S3FileLike = {
      async write(data, options) {
        // `copy()` hands the SOURCE S3File to write(), exactly as Bun's own union allows, so the
        // fake has to read one back out of its store rather than assume bytes.
        if (client.failWriteWith !== undefined) throw client.failWriteWith;
        const source = client.sourceOf(data);
        const bytes =
          source !== undefined
            ? source
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(await (data as Blob).arrayBuffer());
        store.set(key, { bytes, type: options?.type });
        return bytes.byteLength;
      },
      async arrayBuffer() {
        if (client.failReadWith !== undefined) throw client.failReadWith;
        if (client.failBodyWith !== undefined) throw client.failBodyWith;
        const entry = store.get(key);
        // Reads the way the provider does: a GET on a key that is not there is a 404, and the
        // driver is expected to have gated it behind exists() before ever getting here.
        if (entry === undefined) throw objectNotFound(FAKE_DISK, key);
        return new Uint8Array(entry.bytes).buffer;
      },
      async exists() {
        if (client.failReadWith !== undefined) throw client.failReadWith;
        return store.has(key);
      },
      async delete() {
        // Shaped like the real thing: an `S3Error` is a plain Error with `name: 'S3Error'`, a
        // provider `code` and a status. Deliberately NOT a StorageError — the driver has to
        // classify a rejection it never authored, which is the only kind a provider hands back.
        if (client.absentDeleteFor === key) throw s3Error('NoSuchKey', 404, key);
        if (client.failDeleteFor === key) throw s3Error('AccessDenied', 403, key);
        store.delete(key);
      },
      stream() {
        const entry = store.get(key);
        const bytes = entry?.bytes ?? new Uint8Array();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
      async stat(): Promise<S3StatLike> {
        if (client.failReadWith !== undefined) throw client.failReadWith;
        const statRefused = client.failStatFor === undefined || client.failStatFor === key;
        if (client.failStatWith !== undefined && statRefused) throw client.failStatWith;
        const entry = store.get(key);
        if (entry === undefined) throw objectNotFound(FAKE_DISK, key);
        return {
          size: entry.bytes.byteLength,
          type: entry.type,
          etag: entry.etag,
          lastModified: entry.lastModified,
        };
      },
      presign(options) {
        client.presignCalls.push({ key, options });
        return `https://fake.example/${key}?signed`;
      },
    };
    this.fileKeys.set(handle, key);
    return handle;
  }

  async list(input: ListCall): Promise<S3ListResultLike> {
    this.listCalls.push(input);
    if (this.failListWith !== undefined) throw this.failListWith;
    return this.listResult;
  }
}

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The error code a call answered with, or how it failed to answer with one. */
export function codeOf(caught: unknown): string {
  return isStorageError(caught) ? caught.code : `not-a-storage-error: ${String(caught)}`;
}

/** The thrown value itself, where the assertion is about its `cause`/`fix` and not just its code. */
export async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
