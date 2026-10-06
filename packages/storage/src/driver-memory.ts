// Single responsibility: the disk a TEST holds — a `StorageDriver` over one `Map`, answering every
// question `localDriver` answers and refusing what it refuses (a key that is another key's path
// included), with nothing on a filesystem to create or clean up. Not a deployment's disk: a
// restart is every object gone.
//
// It exists because the alternative was written by hand in every suite that needed a bucket: a
// fake with three methods and five `unsupported()` stubs, each a slightly different contract.

import { type Clock, finiteCount, NotImplementedError, systemClock } from '@ultimat3/core';
import {
  assertListOptions,
  assertPutOptions,
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
import { keyInTheWay } from './driver-memory-conflict';
import { checksumMismatch, getTooLarge, keyConflict, objectNotFound } from './errors';
import {
  assertObjectLockOptions,
  isLocked,
  type ObjectLock,
  ObjectLockedError,
  requestedLock,
} from './object-lock';
import { assertSafeKey } from './path';
import type { SignedUrlVerification } from './signed-url';
import { buildSignedUrl, signedUrlBaseFor, verifySignedUrl } from './signed-url';
import { resolveSigningSecret } from './signing-secret';
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
  /** The local disk's sidecar lock, held here instead. */
  readonly lock?: ObjectLock | undefined;
}

/**
 * An object no caller shares with the store. `metadata` and `lastModified` are mutable by anyone
 * holding a reference, and the local disk's sidecar is a copy by construction — a test that
 * mutated what `put()` was handed must not see a different object on the next `get()`.
 */
const snapshot = (object: StorageObject): StorageObject => ({
  ...object,
  ...(object.lastModified === undefined
    ? {}
    : { lastModified: new Date(object.lastModified.getTime()) }),
  ...(object.metadata === undefined ? {} : { metadata: { ...object.metadata } }),
});

export function memoryDriver(options: MemoryDriverOptions = {}): MemoryStorageDriver {
  const maxPutBytes = finiteCount(
    'the memory disk driver',
    'maxPutBytes',
    options.maxPutBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : options.maxPutBytes,
    1,
  );
  const maxGetBytes = finiteCount(
    'the memory disk driver',
    'maxGetBytes',
    options.maxGetBytes === undefined ? maxPutBytes : options.maxGetBytes,
    1,
  );
  const clock = options.clock ?? systemClock;
  let baseUrl = options.baseUrl ?? signedUrlBaseFor(DRIVER_NAME);
  const secret = resolveSigningSecret(DRIVER_NAME, options);
  const stored = new Map<string, Stored>();
  // The name a registry gave this disk, so a miss names `disk('<it>')` — the call the author wrote.
  let registered: string = DRIVER_NAME;

  /** The lock that holds NOW, or `undefined` — the local disk's rule, read off the map. */
  const lockAt = (key: string): ObjectLock | undefined => {
    const lock = stored.get(key)?.lock;
    return isLocked(lock, clock.now()) ? lock : undefined;
  };
  const refuseOverwrite = (key: string, action: 'overwrite' | 'copy onto'): void => {
    const lock = lockAt(key);
    if (lock !== undefined) throw new ObjectLockedError({ disk: registered, key, action, lock });
  };

  /**
   * The local disk's path rule: a key cannot be another key's directory (`X_STORAGE_KEY_CONFLICT`).
   * Emulated, not inherited — a `Map` holds both — because a suite on this disk stands in for the
   * dev disk, and a key layout that passes here and fails in `x dev` is a gap found late.
   */
  const refuseConflict = (key: string): void => {
    const blocking = keyInTheWay(stored, key);
    if (blocking !== undefined) throw keyConflict(registered, key, blocking);
  };

  const found = (key: string): Stored => {
    const hit = stored.get(key);
    if (hit === undefined) throw objectNotFound(registered, key);
    return hit;
  };

  return {
    name: DRIVER_NAME,

    get signedUrlBase(): string {
      return baseUrl;
    },

    registerAs(diskName: string): void {
      registered = diskName;
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
        throw new NotImplementedError({
          cause:
            'server-side encryption on the memory driver (it holds bytes in a Map) is not implemented by this driver — drop serverSideEncryption from put() and encrypt the disk itself: an s3Driver over a bucket with a default KMS rule',
          fix: 'put(key, body)',
        });
      }
      assertPutOptions(DRIVER_NAME, putOptions);
      assertObjectLockOptions(DRIVER_NAME, putOptions, clock);
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
      // Checked AFTER the body is read, with no await between check and write: the map is the
      // queue the local disk needs a `keyedQueue` for.
      refuseConflict(safe);
      refuseOverwrite(safe, 'overwrite');
      // A copy in, as a file write is: the caller's buffer and metadata are the caller's to reuse.
      stored.set(safe, {
        bytes: bytes.slice(),
        object: snapshot(object),
        lock: requestedLock(putOptions),
      });
      return snapshot(object);
    },

    async stat(key: string): Promise<StorageObject | undefined> {
      const hit = stored.get(assertSafeKey(key));
      return hit && snapshot(hit.object);
    },

    async get(key: string): Promise<StorageRead> {
      const safe = assertSafeKey(key);
      const hit = found(safe);
      // The local disk's refusal, so a suite on this disk meets the ceiling production has.
      if (hit.bytes.byteLength > maxGetBytes) {
        throw getTooLarge(DRIVER_NAME, safe, hit.bytes.byteLength, maxGetBytes);
      }
      return { object: snapshot(hit.object), bytes: hit.bytes.slice() };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const hit = found(assertSafeKey(key));
      return new Blob([hit.bytes.slice()]).stream();
    },

    async copy(from: string, to: string): Promise<StorageObject> {
      // Both keys before either lookup, as the other two disks do: an unsafe destination is the
      // refusal whether or not the source exists.
      const [from_, destination] = [assertSafeKey(from), assertSafeKey(to)];
      const source = found(from_);
      refuseConflict(destination);
      refuseOverwrite(destination, 'copy onto');
      const object: StorageObject = {
        ...source.object,
        key: destination,
        lastModified: clock.now(),
      };
      stored.set(destination, { bytes: source.bytes.slice(), object: snapshot(object) });
      return snapshot(object);
    },

    async delete(key: string): Promise<void> {
      const safe = assertSafeKey(key);
      const lock = lockAt(safe);
      if (lock !== undefined) {
        throw new ObjectLockedError({ disk: registered, key: safe, action: 'delete', lock });
      }
      stored.delete(safe);
    },

    async retentionOf(key: string): Promise<ObjectLock> {
      const lock = found(assertSafeKey(key)).lock;
      return lock === undefined ? { legalHold: false } : structuredClone(lock);
    },

    async exists(key: string): Promise<boolean> {
      return stored.has(assertSafeKey(key));
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const prefix = listOptions?.prefix ?? '';
      assertListOptions(listOptions);
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
