// Single responsibility: the disk a TEST holds — a `StorageDriver` over one `Map`, answering every
// question `localDriver` answers and refusing what it refuses, with nothing on a filesystem to
// create or clean up. Not a deployment's disk: a restart is every object gone.
//
// It exists because the alternative was written by hand in every suite that needed a bucket: a
// fake with three methods and five `unsupported()` stubs, each a slightly different contract.

import { type Clock, finiteCount, systemClock } from '@ultimat3/core';
import {
  DEFAULT_CONTENT_TYPE,
  etagOf,
  type ListOptions,
  type ListPage,
  type PutOptions,
  resolveListLimit,
  type SignedUrlOptions,
  type StorageBody,
  type StorageDriver,
  type StorageObject,
  type StorageRead,
  sha256Base64,
  toBytes,
} from './driver';
import type { LocalDriverOptions } from './driver-local';
import { resolveSigningSecret } from './driver-local';
import { checksumMismatch, objectNotFound, storageNotImplemented } from './errors';
import { assertSafeKey } from './path';
import type { SignedUrlVerification } from './signed-url';
import { buildSignedUrl, signedUrlBaseFor, verifySignedUrl } from './signed-url';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

const DRIVER_NAME = 'memory';

/** `localDriver`'s options, minus the directory there is none of. */
export type MemoryDriverOptions = Omit<LocalDriverOptions, 'root'>;

export interface MemoryStorageDriver extends StorageDriver {
  /**
   * Every stored object's bytes by key, COPIED — what an operator holding the bucket could read.
   * For the assertion a test makes about the store itself: "nothing in it is a cookie value".
   */
  objects(): ReadonlyMap<string, Uint8Array>;
}

interface Stored {
  readonly bytes: Uint8Array;
  readonly object: StorageObject;
}

/**
 * An object no caller shares with the store. `metadata` and `lastModified` are mutable by anyone
 * holding a reference, and the local disk's sidecar is a copy by construction — a test that
 * mutated what `put()` was handed must not see a different object on the next `get()`.
 */
const snapshot = (object: StorageObject): StorageObject => ({
  ...object,
  lastModified: new Date(object.lastModified.getTime()),
  ...(object.metadata === undefined ? {} : { metadata: { ...object.metadata } }),
});

export function memoryDriver(options: MemoryDriverOptions = {}): MemoryStorageDriver {
  const maxPutBytes = finiteCount(
    'the memory disk driver',
    'maxPutBytes',
    options.maxPutBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : options.maxPutBytes,
    1,
  );
  const clock = options.clock ?? systemClock;
  let baseUrl = options.baseUrl ?? signedUrlBaseFor(DRIVER_NAME);
  const secret = resolveSigningSecret(DRIVER_NAME, options);
  const stored = new Map<string, Stored>();

  const found = (key: string): Stored => {
    const hit = stored.get(key);
    if (hit === undefined) throw objectNotFound(DRIVER_NAME, key);
    return hit;
  };

  return {
    name: DRIVER_NAME,

    get signedUrlBase(): string {
      return baseUrl;
    },

    registerAs(diskName: string): void {
      if (options.baseUrl === undefined) baseUrl = signedUrlBaseFor(diskName);
    },

    objects(): ReadonlyMap<string, Uint8Array> {
      return new Map([...stored].map(([key, value]) => [key, value.bytes.slice()]));
    },

    async put(key: string, body: StorageBody, putOptions?: PutOptions): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      // The same refusal both shipped disks make: a `put()` that succeeds in a test and throws in
      // production is a gap an app meets on the worst day.
      if (putOptions?.serverSideEncryption !== undefined) {
        throw storageNotImplemented(
          'server-side encryption on the memory driver (it holds bytes in a Map)',
          'drop serverSideEncryption from put(), and encrypt the disk itself — an s3Driver over a bucket with a default KMS rule',
        );
      }
      const bytes = await toBytes(body, { driver: DRIVER_NAME, key: safe, maxBytes: maxPutBytes });
      const claimed = putOptions?.checksum;
      if (claimed !== undefined) {
        const actual = sha256Base64(bytes);
        if (claimed !== actual) throw checksumMismatch(safe, claimed, actual);
      }
      const object: StorageObject = {
        key: safe,
        size: bytes.byteLength,
        contentType: putOptions?.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: etagOf(bytes),
        lastModified: clock.now(),
        ...(putOptions?.cacheControl === undefined
          ? {}
          : { cacheControl: putOptions.cacheControl }),
        ...(putOptions?.metadata === undefined ? {} : { metadata: putOptions.metadata }),
      };
      // A copy in, as a file write is: the caller's buffer and metadata are the caller's to reuse.
      stored.set(safe, { bytes: bytes.slice(), object: snapshot(object) });
      return snapshot(object);
    },

    async get(key: string): Promise<StorageRead> {
      const hit = found(assertSafeKey(key));
      return { object: snapshot(hit.object), bytes: hit.bytes.slice() };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const hit = found(assertSafeKey(key));
      return new Blob([hit.bytes.slice()]).stream();
    },

    async copy(from: string, to: string): Promise<StorageObject> {
      const source = found(assertSafeKey(from));
      const destination = assertSafeKey(to);
      const object: StorageObject = {
        ...source.object,
        key: destination,
        lastModified: clock.now(),
      };
      stored.set(destination, { bytes: source.bytes.slice(), object: snapshot(object) });
      return snapshot(object);
    },

    async delete(key: string): Promise<void> {
      stored.delete(assertSafeKey(key));
    },

    async exists(key: string): Promise<boolean> {
      return stored.has(assertSafeKey(key));
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const prefix = listOptions?.prefix ?? '';
      const limit = resolveListLimit(listOptions?.limit);
      const cursor = listOptions?.cursor;
      // Code-unit order and "the cursor is the last key of the page before" — the local disk's own.
      const keys = [...stored.keys()]
        .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
        .sort();
      const page = keys.slice(0, limit);
      const objects = page.flatMap((key) => {
        const hit = stored.get(key);
        return hit === undefined ? [] : [snapshot(hit.object)];
      });
      const last = page.at(-1);
      return keys.length > page.length && last !== undefined
        ? { objects, truncated: true, cursor: last }
        : { objects, truncated: false };
    },

    async signedUrl(key: string, urlOptions?: SignedUrlOptions): Promise<string> {
      return buildSignedUrl({
        secret,
        key: assertSafeKey(key),
        method: urlOptions?.method,
        expiresInMs: urlOptions?.expiresInMs,
        maxBytes: urlOptions?.maxBytes,
        contentType: urlOptions?.contentType,
        baseUrl,
        clock,
      });
    },

    async verifySigned(input: {
      readonly url: string;
      readonly clock?: Clock | undefined;
    }): Promise<SignedUrlVerification> {
      return verifySignedUrl({ url: input.url, secret, baseUrl, clock: input.clock ?? clock });
    },
  };
}
