// Single responsibility: an upload in parts on a disk that signs its own URLs (`local`, `memory`):
// the session rules over a `PartStore` the disk supplies. Same contract as s3's, so dev and tests
// behave as production: a part URL is signed, a part lands only in an open session, a Complete
// assembles exactly the parts named and drops the session, and an abort leaves nothing.

import type { Clock } from '@ultimat3/core';
import { etagOf, type StorageDriver, type StorageObject } from './driver';
import { uploadUnknown } from './errors-multipart';
import type { MultipartCapability, MultipartSession, UploadedPart } from './multipart';
import { assertSafeKey } from './path';

/** What a staged session records at `create`. `initiated` is ISO, so a file store can hold it. */
export interface StagedSession {
  readonly key: string;
  readonly contentType: string;
  readonly initiated: string;
}

/** Where a disk keeps open sessions and their parts: a directory, or a `Map`. */
export interface PartStore {
  open(uploadId: string, session: StagedSession): Promise<void>;
  session(uploadId: string): Promise<StagedSession | undefined>;
  writePart(uploadId: string, part: UploadedPart, bytes: Uint8Array): Promise<void>;
  /** Ascending by part number. */
  parts(uploadId: string): Promise<readonly UploadedPart[]>;
  /** The named parts' bytes, end to end, read as the stream is pulled. */
  read(uploadId: string, parts: readonly UploadedPart[]): ReadableStream<Uint8Array>;
  drop(uploadId: string): Promise<void>;
  sessions(): Promise<readonly (readonly [string, StagedSession])[]>;
}

export interface StagedMultipartOptions {
  readonly store: PartStore;
  readonly clock: Clock;
  /** The disk the parts belong to: it signs their URLs and takes the Complete's stream. */
  readonly driver: StorageDriver;
}

/**
 * The disk with `multipart` attached IN PLACE, never spread: a spread reads `signedUrlBase` once,
 * and `registerAs` re-points it after construction.
 */
export function withStagedMultipart<D extends StorageDriver>(
  driver: D,
  store: PartStore,
  clock: Clock,
): D {
  return Object.assign(driver, { multipart: stagedMultipart({ store, clock, driver }) });
}

export function stagedMultipart(options: StagedMultipartOptions): MultipartCapability {
  const { store } = options;
  /** The session, held to the key it was opened for: an id is never a capability on its own. */
  const openSession = async (key: string, uploadId: string): Promise<StagedSession> => {
    const session = await store.session(uploadId);
    if (session === undefined || session.key !== key) {
      throw uploadUnknown(options.driver.name, key, uploadId);
    }
    return session;
  };

  return {
    async create(key, { contentType }): Promise<string> {
      const safe = assertSafeKey(key);
      const uploadId = crypto.randomUUID();
      await store.open(uploadId, {
        key: safe,
        contentType,
        initiated: options.clock.now().toISOString(),
      });
      return uploadId;
    },

    signPart: (key, uploadId, partNumber, { contentLength, expiresInMs }) =>
      options.driver.signedUrl(key, {
        method: 'PUT',
        contentLength,
        maxBytes: contentLength,
        expiresInMs,
        part: { uploadId, partNumber },
      }),

    async listParts(key, uploadId): Promise<readonly UploadedPart[]> {
      await openSession(assertSafeKey(key), uploadId);
      return store.parts(uploadId);
    },

    async receivePart(key, uploadId, partNumber, bytes): Promise<UploadedPart> {
      await openSession(assertSafeKey(key), uploadId);
      const part = { partNumber, etag: etagOf(bytes), size: bytes.byteLength };
      await store.writePart(uploadId, part, bytes);
      return part;
    },

    async complete(key, uploadId, parts): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      const session = await openSession(safe, uploadId);
      const total = parts.reduce((sum, part) => sum + part.size, 0);
      const object = await options.driver.putStream(safe, store.read(uploadId, parts), {
        maxBytes: Math.max(total, 1),
        contentType: session.contentType,
      });
      await store.drop(uploadId);
      return object;
    },

    async abort(key, uploadId): Promise<void> {
      const safe = assertSafeKey(key);
      const session = await store.session(uploadId);
      if (session?.key === safe) await store.drop(uploadId);
    },

    async listUploads(prefix): Promise<readonly MultipartSession[]> {
      const open = await store.sessions();
      return open
        .filter(([, session]) => prefix === undefined || session.key.startsWith(prefix))
        .map(([uploadId, session]) => {
          const initiated = new Date(session.initiated);
          return {
            key: session.key,
            uploadId,
            ...(Number.isNaN(initiated.getTime()) ? {} : { initiated }),
          };
        });
    },
  };
}
