// The in-memory `Bun.S3Client` stand-in the s3 driver's tests drive, and the helpers that read
// its answers. Shared rather than copied because `driver-s3.test.ts` (reads, copies, listings,
// credentials) and `driver-s3-put.test.ts` (everything `put()` refuses) must exercise the SAME
// fake — two fakes drifting apart would be two providers, agreeing only by construction.

import type { S3ClientLike, S3FileLike, S3ListResultLike, S3StatLike } from './driver-s3';
import { isStorageError, objectNotFound } from './errors';

/** The driver's private `DRIVER_NAME`; the fake reports failures against the same disk. */
export const FAKE_DISK = 's3';

export interface FakeObject {
  bytes: Uint8Array;
  type?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | Date | undefined;
}

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
        const entry = store.get(key);
        // Reads the way the provider does: a GET on a key that is not there is a 404, and the
        // driver is expected to have gated it behind exists() before ever getting here.
        if (entry === undefined) throw objectNotFound(FAKE_DISK, key);
        return new Uint8Array(entry.bytes).buffer;
      },
      async exists() {
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
