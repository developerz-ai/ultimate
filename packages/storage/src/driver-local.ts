// Single responsibility: the dev-default disk — a real, working driver over `Bun.file` /
// `Bun.write` rooted at one directory, so `x dev` needs no S3 server and no cloud account.
// Content type, etag and user metadata live in a sidecar under `.meta/`: a POSIX file has
// nowhere to keep them, and `get` must round-trip exactly what `put` was handed.

import {
  type Clock,
  finiteCount,
  type Page,
  type ResolveEnvironmentOptions,
  systemClock,
} from '@ultimat3/core';
import {
  assertListOptions,
  assertPutOptions,
  type CopyOptions,
  DEFAULT_CONTENT_TYPE,
  etagOf,
  type ListOptions,
  type PutOptions,
  resolveListLimit,
  type SignedUrlOptions,
  type StorageBody,
  type StorageDriver,
  type StorageListEntry,
  type StorageObject,
  type StorageRead,
  type StreamOptions,
  sha256Base64,
  signedByteBound,
  toBytes,
} from './driver';
import { listLocalPage } from './driver-local-list';
import { localPartStore } from './driver-local-multipart';
import { streamPinned } from './driver-local-open';
import {
  etagOfFile,
  headObject,
  readObjectBytes,
  readObjectRange,
  readSidecar,
} from './driver-local-read';
import { removeIfPresent } from './driver-local-remove';
import { lockOfSidecar, type Sidecar, sidecarLock } from './driver-local-sidecar';
import { putLocalStream } from './driver-local-stream';
import {
  commitObject,
  inTurnOfBoth,
  type KeyedQueue,
  keyedQueue,
  pendingPathOf,
  refuseUnsupportedPut,
  sidecarPathOf,
} from './driver-local-write';
import { checksumMismatch, getTooLarge, objectNotFound } from './errors';
import { objectChanged } from './errors-promote';
import { withStagedMultipart } from './multipart-staged';
import {
  assertObjectLockOptions,
  isLocked,
  type ObjectLock,
  ObjectLockedError,
  requestedLock,
} from './object-lock';
import { assertLocalKey, assertSafeKey } from './path';

import { assertPutStream, type PutStreamOptions } from './put-stream';
import {
  assertGetOptions,
  assertStreamRange,
  type ByteRange,
  type GetOptions,
  servedRange,
  streamedRange,
} from './range';
import {
  assertWithinRequestCeiling,
  type RequestCeiling,
  screenRequestCeiling,
} from './request-ceiling';
import type { SignedUrlVerification } from './signed-url';
import { buildSignedUrl, signedUrlBaseFor, verifySignedUrl } from './signed-url';
import { resolveSigningSecret } from './signing-secret';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

const DRIVER_NAME = 'local';

/** Every key this disk touches: the shared rule, then Windows' own (`assertLocalKey`). */
const safeKey = (key: string): string => assertLocalKey(assertSafeKey(key));

export interface LocalDriverOptions {
  /** Directory the disk owns outright. Created on first write. */
  readonly root: string;
  /** HMAC secret for signed URLs. Production must pass one; dev falls back to a fixed string. */
  readonly signingSecret?: string | undefined;
  /** Route prefix the dev server serves signed URLs from. */
  readonly baseUrl?: string | undefined;
  readonly clock?: Clock | undefined;
  /**
   * The environment table this DISK belongs to — the boot's, which is not always the process's.
   * Core's own slot (`ResolveEnvironmentOptions['env']`), narrowed to that one field because the
   * `fallback` beside it is a question this constructor never asks.
   *
   * It exists because the guard and the thing it guards have to read one table. `x doctor` and
   * `dev-runtime.ts` ask `!isLocal({ env }) && usesDevStorageSecret({ env })` about the boot; the
   * constructor below is what actually decides whether this disk signs with the published
   * development key, and while it read `process.env` an embedding caller (`serveApp({ env })`, a
   * test fixture) got the verdict from one table and the behaviour from another — in the
   * dangerous direction, a production boot signing with a key published in this repo.
   *
   * Defaults to `process.env`, so a bare `localDriver({ root })` is unchanged.
   */
  readonly env?: ResolveEnvironmentOptions['env'];
  /**
   * Ceiling on ONE server-side `put()`, because `put()` buffers the whole body. Defaults to the
   * upload policy's ceiling — the same number for the same fact. The dev disk enforces it for
   * the same reason production does: a limit an app only meets in production is a limit it
   * discovers by being OOM-killed.
   */
  readonly maxPutBytes?: number | undefined;
  /**
   * Ceiling on ONE `get()`, because `get()` buffers the whole object too — and an object's size
   * is the uploader's, not this process's. Defaults to `maxPutBytes`; past it, `stream()`.
   */
  readonly maxGetBytes?: number | undefined;
  /**
   * The most ONE request to this server carries — the app's `http.maxRequestBodyBytes`, which this
   * package cannot import. A signed PUT lands on this process, so a single-request grant past it is
   * refused at signing (`X_STORAGE_TOO_LARGE`, naming `grantMultipart`). Unset, nothing is refused
   * here and the route's own `X_BODY_TOO_LARGE` answers the upload. A function is read at each
   * signing: the CLI's disk is built before the app's `configureHttp` runs.
   */
  readonly maxRequestBytes?: RequestCeiling | undefined;
  /**
   * The per-key queue every read and write of this disk waits in. Defaults to the disk's own
   * `keyedQueue()`; a test passes one it also holds, to park a key deterministically.
   */
  readonly queue?: KeyedQueue | undefined;
}

export function localDriver(options: LocalDriverOptions): StorageDriver {
  const root = options.root.replace(/\/+$/, '');
  // `=== undefined`, never `??`: `??` coalesces on `null` too, so an explicitly blanked key in a
  // decoded JSON config took the default instead of the refusal `finiteCount` is here to raise.
  const maxPutBytes = finiteCount(
    'the local disk driver',
    'maxPutBytes',
    options.maxPutBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : options.maxPutBytes,
    1,
  );
  const maxGetBytes = finiteCount(
    'the local disk driver',
    'maxGetBytes',
    options.maxGetBytes === undefined ? maxPutBytes : options.maxGetBytes,
    1,
  );
  const clock = options.clock ?? systemClock;
  const maxRequestBytes = screenRequestCeiling('local', options.maxRequestBytes);
  const oneAtATime = options.queue ?? keyedQueue();
  // What `defineStorage` registered this driver as — the name a refusal's `disk('…')` must use.
  let registered = DRIVER_NAME;
  // The segment is the disk's REGISTERED name, learned from `defineStorage` at boot — the driver
  // kind is not a mount point, and minting under it made every disk not literally named `local`
  // 404 its own URLs. An explicit `baseUrl` outranks the registration: that is the operator
  // stating where the route is mounted, and inference must not overwrite a decision.
  let baseUrl = options.baseUrl ?? signedUrlBaseFor(DRIVER_NAME);
  const secret = resolveSigningSecret(DRIVER_NAME, options);

  const filePath = (key: string): string => `${root}/${key}`;
  const metaPath = (key: string): string => `${root}/${sidecarPathOf(key)}`;

  // Both QUEUED behind the key's writers, as `get()` is: unqueued, a measurement read the size of
  // one generation before a commit and the sidecar of the next after it.
  /** A listing's view: no bytes read, so a pair in doubt reports no type and no etag. */
  const head = (key: string): Promise<StorageListEntry | undefined> =>
    oneAtATime(key, () => headObject(root, key));
  /** The same, settled against the bytes on disk — streamed through a hasher, never buffered. */
  const measured = (key: string): Promise<StorageListEntry | undefined> =>
    oneAtATime(key, () => headObject(root, key, () => etagOfFile(root, key, registered)));

  /**
   * The lock the sidecar RECORDS, read whole even when the pair is in doubt: a torn write never
   * unlocks an object. `undefined` when nothing on disk locks it now.
   */
  const lockAt = async (key: string): Promise<ObjectLock | undefined> => {
    const lock = lockOfSidecar(await readSidecar(root, key));
    return isLocked(lock, clock.now()) ? lock : undefined;
  };
  /** Called INSIDE the key's queue, so no writer of this process lands between check and commit. */
  const refuseOverwrite = async (key: string, action: 'overwrite' | 'copy onto'): Promise<void> => {
    const lock = await lockAt(key);
    if (lock !== undefined) {
      throw new ObjectLockedError({ disk: registered, key, action, lock, sidecar: metaPath(key) });
    }
  };

  return withStagedMultipart(
    {
      name: DRIVER_NAME,

      /** A getter, not a captured string: `registerAs` runs after the driver is constructed. */
      get signedUrlBase(): string {
        return baseUrl;
      },

      registerAs(diskName: string): void {
        registered = diskName;
        if (options.baseUrl === undefined) baseUrl = signedUrlBaseFor(diskName);
      },

      async put(key: string, body: StorageBody, putOptions?: PutOptions): Promise<StorageObject> {
        const safe = safeKey(key);
        refuseUnsupportedPut(putOptions);
        assertPutOptions(DRIVER_NAME, putOptions);
        assertObjectLockOptions(DRIVER_NAME, putOptions, clock);
        const bytes = await toBytes(body, {
          driver: DRIVER_NAME,
          key: safe,
          maxBytes: maxPutBytes,
        });
        const claimed = putOptions?.checksum;
        if (claimed !== undefined) {
          const actual = sha256Base64(bytes);
          if (claimed !== actual) throw checksumMismatch(safe, claimed, actual);
        }
        const lastModified = clock.now();
        const sidecar: Sidecar = {
          contentType: putOptions?.contentType ?? DEFAULT_CONTENT_TYPE,
          etag: etagOf(bytes),
          cacheControl: putOptions?.cacheControl,
          metadata: putOptions?.metadata,
          // The write's instant, on the injected clock, recorded for every later read to report.
          lastModified: lastModified.toISOString(),
          ...sidecarLock(requestedLock(putOptions)),
        };
        await oneAtATime(safe, async () => {
          await refuseOverwrite(safe, 'overwrite');
          await commitObject({ root, key: safe, disk: registered, body: bytes, sidecar });
        });
        return {
          key: safe,
          size: bytes.byteLength,
          contentType: sidecar.contentType,
          etag: sidecar.etag,
          lastModified,
          ...(sidecar.cacheControl === undefined ? {} : { cacheControl: sidecar.cacheControl }),
          ...(sidecar.metadata === undefined ? {} : { metadata: sidecar.metadata }),
        };
      },

      async putStream(
        key: string,
        body: ReadableStream<Uint8Array>,
        streamOptions: PutStreamOptions,
      ): Promise<StorageObject> {
        const safe = safeKey(key);
        const maxBytes = assertPutStream(DRIVER_NAME, body, streamOptions);
        const input = { root, key: safe, disk: registered, body, maxBytes, clock };
        return putLocalStream(input, streamOptions, (then) =>
          oneAtATime(safe, async () => {
            await refuseOverwrite(safe, 'overwrite');
            await then();
          }),
        );
      },

      async stat(key: string): Promise<StorageObject | undefined> {
        const entry = await measured(safeKey(key));
        return entry && { ...entry, contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE };
      },

      async get(key: string, getOptions?: GetOptions): Promise<StorageRead> {
        const safe = safeKey(key);
        assertGetOptions(DRIVER_NAME, getOptions);
        const range = getOptions?.range;
        // Queued behind this key's writers: an object is two files, and a read between a put()'s
        // renames is a pair in doubt this process has no need to meet.
        return oneAtATime(safe, async () => {
          const file = Bun.file(filePath(safe));
          if (!(await file.exists())) throw objectNotFound(registered, safe);
          if (range !== undefined) {
            const served = servedRange(DRIVER_NAME, safe, range, file.size, maxGetBytes);
            const bytes = await readObjectRange(root, safe, registered, served);
            // A doubt is settled by streaming the WHOLE file through the hash, never by buffering it:
            // the range is the only part of this object the read may hold.
            const entry = await headObject(root, safe, () => etagOfFile(root, safe, registered));
            if (entry === undefined) throw objectNotFound(registered, safe);
            const object = { ...entry, contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE };
            return { object, bytes, range: served };
          }
          if (file.size > maxGetBytes) throw getTooLarge(DRIVER_NAME, safe, file.size, maxGetBytes);
          const bytes = await readObjectBytes(root, safe, registered);
          // Settled against the bytes this read ALREADY holds: hashed only for a sidecar-less object
          // or a pair in doubt, and then exactly once.
          const entry = await headObject(root, safe, () => etagOf(bytes));
          if (entry === undefined) throw objectNotFound(registered, safe);
          return {
            object: { ...entry, contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE },
            bytes,
          };
        });
      },

      async stream(key: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>> {
        const safe = safeKey(key);
        const etag = options?.etag;
        if (etag !== undefined) return streamPinned({ root, key: safe, disk: registered, etag });
        const file = Bun.file(filePath(safe));
        if (!(await file.exists())) throw objectNotFound(registered, safe);
        return file.stream();
      },

      async streamRange(
        key: string,
        range: ByteRange,
        options?: StreamOptions,
      ): Promise<ReadableStream<Uint8Array>> {
        const safe = safeKey(key);
        assertStreamRange(DRIVER_NAME, range);
        const etag = options?.etag;
        if (etag !== undefined) {
          return streamPinned({ root, key: safe, disk: registered, etag, range });
        }
        const file = Bun.file(filePath(safe));
        if (!(await file.exists())) throw objectNotFound(registered, safe);
        const [first, last] = streamedRange(DRIVER_NAME, safe, range, file.size);
        return file.slice(first, last + 1).stream();
      },

      /** A real file copy — `Bun.write` from a `BunFile` never routes the bytes through the heap. */
      async copy(from: string, to: string, options?: CopyOptions): Promise<StorageObject> {
        const source = safeKey(from);
        const destination = safeKey(to);
        // Measured AND read in one turn on both keys. Measured in the source's turn and read in the
        // destination's, a put() of the source in between committed its NEW bytes under the OLD
        // etag and type — a pair no marker flags, so every later `get()` of the copy trusted it.
        return inTurnOfBoth(oneAtATime, source, destination, async () => {
          // Measured, not merely read: a sidecar carrying `etag: ''` or a torn source's borrowed
          // type is the same durable lie. The hash is streamed, and only for a pair in doubt.
          const entry = await headObject(root, source, () => etagOfFile(root, source, registered));
          if (entry === undefined) throw objectNotFound(registered, source);
          if (options?.ifMatch !== undefined && entry.etag !== options.ifMatch) {
            throw objectChanged(source, options.ifMatch, entry.etag);
          }
          const lastModified = clock.now();
          const sidecar: Sidecar = {
            contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE,
            etag: entry.etag,
            cacheControl: entry.cacheControl,
            metadata: entry.metadata,
            lastModified: lastModified.toISOString(),
          };
          await refuseOverwrite(destination, 'copy onto');
          await commitObject({
            root,
            key: destination,
            disk: registered,
            body: Bun.file(filePath(source)),
            sidecar,
          }).catch(async (error: unknown) => {
            // The queue is this process's: another process can still take the source mid-copy.
            if (!(await Bun.file(filePath(source)).exists()))
              throw objectNotFound(registered, source);
            throw error;
          });
          return { ...entry, key: destination, contentType: sidecar.contentType, lastModified };
        });
      },

      async delete(key: string): Promise<void> {
        const safe = safeKey(key);
        // Idempotent by contract: a missing key is already in the desired state. A REFUSED unlink
        // is not — a read-only mount or a root this process cannot write reports the bytes gone
        // when they are still on disk, which is the one lie an erasure sweep must never repeat.
        await oneAtATime(safe, async () => {
          const lock = await lockAt(safe);
          if (lock !== undefined) {
            throw new ObjectLockedError({
              disk: registered,
              key: safe,
              action: 'delete',
              lock,
              sidecar: metaPath(safe),
            });
          }
          await removeIfPresent(root, filePath(safe), safe);
          await removeIfPresent(root, metaPath(safe), safe);
          await removeIfPresent(root, `${root}/${pendingPathOf(safe)}`, safe);
        });
      },

      async exists(key: string): Promise<boolean> {
        return Bun.file(filePath(safeKey(key))).exists();
      },

      /** From the sidecar, as recorded — a lapsed retention is still reported, as S3 reports it. */
      async retentionOf(key: string): Promise<ObjectLock> {
        const safe = safeKey(key);
        return oneAtATime(safe, async () => {
          if (!(await Bun.file(filePath(safe)).exists())) throw objectNotFound(registered, safe);
          return lockOfSidecar(await readSidecar(root, safe));
        });
      },

      async list(listOptions?: ListOptions): Promise<Page<StorageListEntry>> {
        assertListOptions(listOptions);
        return listLocalPage({
          root,
          prefix: listOptions?.prefix ?? '',
          cursor: listOptions?.cursor ?? undefined,
          limit: resolveListLimit(listOptions?.limit),
          head,
        });
      },

      async signedUrl(key: string, urlOptions?: SignedUrlOptions): Promise<string> {
        const bound = signedByteBound(DRIVER_NAME, urlOptions);
        assertWithinRequestCeiling(DRIVER_NAME, maxRequestBytes(), { ...urlOptions, bound });
        return buildSignedUrl({
          secret,
          key: safeKey(key),
          method: urlOptions?.method,
          expiresInMs: urlOptions?.expiresInMs,
          maxBytes: bound,
          contentType: urlOptions?.contentType,
          part: urlOptions?.part,
          baseUrl,
          clock,
        });
      },

      /**
       * The mint above, run backwards, on the same three values from the same closure: `secret`,
       * `baseUrl` and `clock`. That is the whole reason it belongs here rather than in a caller — a
       * route holding this disk can now accept an upload without ever being handed the key, and
       * before this member existed there was no way for one to verify at all, which is why the
       * shipped `PUT` half of `/_storage` was never mounted.
       *
       * Never throws: `verifySignedUrl` returns a reason, and `accept.ts` owns which reason becomes
       * which error. A driver that decided that here would be a second error taxonomy.
       */
      async verifySigned(input: {
        readonly url: string;
        readonly clock?: Clock | undefined;
      }): Promise<SignedUrlVerification> {
        return verifySignedUrl({
          url: input.url,
          secret,
          baseUrl,
          clock: input.clock ?? clock,
        });
      },
    },
    localPartStore(root),
    clock,
  );
}
