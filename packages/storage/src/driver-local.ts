// Single responsibility: the dev-default disk — a real, working driver over `Bun.file` /
// `Bun.write` rooted at one directory, so `x dev` needs no S3 server and no cloud account.
// Content type, etag and user metadata live in a sidecar under `.meta/`: a POSIX file has
// nowhere to keep them, and `get` must round-trip exactly what `put` was handed.

import {
  type Clock,
  finiteCount,
  NotImplementedError,
  type ResolveEnvironmentOptions,
  renderFixShellArg,
  stringField,
  systemClock,
} from '@ultimat3/core';
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
  type StorageListEntry,
  type StorageObject,
  type StorageRead,
  sha256Base64,
  toBytes,
} from './driver';
import { etagOfFile, headObject, readObjectBytes } from './driver-local-read';
import type { Sidecar } from './driver-local-sidecar';
import { commitObject, keyedQueue, pendingPathOf, sidecarPathOf } from './driver-local-write';
import { checksumMismatch, deleteFailed, getTooLarge, listFailed, objectNotFound } from './errors';
import { assertSafeKey, META_DIR } from './path';
import type { SignedUrlVerification } from './signed-url';
import { buildSignedUrl, signedUrlBaseFor, verifySignedUrl } from './signed-url';
import { resolveSigningSecret } from './signing-secret';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

const DRIVER_NAME = 'local';

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
}

/**
 * A POSIX file is not encrypted at rest by this driver, and recording the request in the sidecar
 * would answer a security review with a field the disk never honoured. Refused on the DEV disk
 * too, and deliberately: a `put()` that succeeds locally and throws in production is a gap an app
 * meets on the worst day, and both drivers refusing is one rule instead of two.
 */
function refuseUnsupportedPut(putOptions?: PutOptions): void {
  if (putOptions?.serverSideEncryption === undefined) return;
  throw new NotImplementedError({
    cause:
      'server-side encryption on the local driver (it writes plain files under one root) is not implemented by this driver — drop serverSideEncryption from put() and encrypt the disk itself: an s3Driver over a bucket with a default KMS rule, or a LUKS/FileVault volume under root',
    fix: 'put(key, body)',
  });
}

/** `ENOENT` is the one delete failure that means "already in the desired state". */
const isMissingFile = (error: unknown): boolean => stringField(error, 'code') === 'ENOENT';

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
  const oneAtATime = keyedQueue();
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
    oneAtATime(key, () => headObject(root, key, () => etagOfFile(root, key)));

  /** Removes one path, or reports WHY it could not — a swallowed refusal is a false erasure. */
  const removeIfPresent = async (path: string, key: string): Promise<void> => {
    try {
      await Bun.file(path).delete();
    } catch (error) {
      if (isMissingFile(error)) return;
      throw deleteFailed(
        DRIVER_NAME,
        key,
        error,
        // Screened: a key may carry `$(…)` and a root is configuration, and a fix: is pasted.
        `make the disk root writable by this process, then retry: ls -ld ${renderFixShellArg(root, "'<the disk root>'")} && rm -f ${renderFixShellArg(path, "'<the object file>'")}`,
      );
    }
  };

  return {
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
      const safe = assertSafeKey(key);
      refuseUnsupportedPut(putOptions);
      assertPutOptions(DRIVER_NAME, putOptions);
      const bytes = await toBytes(body, { driver: DRIVER_NAME, key: safe, maxBytes: maxPutBytes });
      const claimed = putOptions?.checksum;
      if (claimed !== undefined) {
        const actual = sha256Base64(bytes);
        if (claimed !== actual) throw checksumMismatch(safe, claimed, actual);
      }
      const sidecar: Sidecar = {
        contentType: putOptions?.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: etagOf(bytes),
        cacheControl: putOptions?.cacheControl,
        metadata: putOptions?.metadata,
      };
      await oneAtATime(safe, () =>
        commitObject({ root, key: safe, disk: registered, body: bytes, sidecar }),
      );
      return {
        key: safe,
        size: bytes.byteLength,
        contentType: sidecar.contentType,
        etag: sidecar.etag,
        lastModified: clock.now(),
        ...(sidecar.cacheControl === undefined ? {} : { cacheControl: sidecar.cacheControl }),
        ...(sidecar.metadata === undefined ? {} : { metadata: sidecar.metadata }),
      };
    },

    async stat(key: string): Promise<StorageObject | undefined> {
      const entry = await measured(assertSafeKey(key));
      return entry && { ...entry, contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE };
    },

    async get(key: string): Promise<StorageRead> {
      const safe = assertSafeKey(key);
      // Queued behind this key's writers: an object is two files, and a read between a put()'s
      // renames is a pair in doubt this process has no need to meet.
      return oneAtATime(safe, async () => {
        const file = Bun.file(filePath(safe));
        if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, safe);
        if (file.size > maxGetBytes) throw getTooLarge(DRIVER_NAME, safe, file.size, maxGetBytes);
        const bytes = await readObjectBytes(root, safe);
        // Settled against the bytes this read ALREADY holds: hashed only for a sidecar-less object
        // or a pair in doubt, and then exactly once.
        const entry = await headObject(root, safe, () => etagOf(bytes));
        if (entry === undefined) throw objectNotFound(DRIVER_NAME, safe);
        return {
          object: { ...entry, contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE },
          bytes,
        };
      });
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const safe = assertSafeKey(key);
      const file = Bun.file(filePath(safe));
      if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, safe);
      return file.stream();
    },

    /** A real file copy — `Bun.write` from a `BunFile` never routes the bytes through the heap. */
    async copy(from: string, to: string): Promise<StorageObject> {
      const source = assertSafeKey(from);
      const destination = assertSafeKey(to);
      // Measured, not merely read: the destination gets a sidecar, and one carrying `etag: ''` or
      // a torn source's borrowed type is a durable lie every later `get()` of the copy would
      // trust. The hash is streamed, and only for a sidecar-less source or a pair in doubt.
      const entry = await measured(source);
      if (entry === undefined) throw objectNotFound(DRIVER_NAME, source);
      const sidecar: Sidecar = {
        contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: entry.etag,
        cacheControl: entry.cacheControl,
        metadata: entry.metadata,
      };
      await oneAtATime(destination, () =>
        commitObject({
          root,
          key: destination,
          disk: registered,
          body: Bun.file(filePath(source)),
          sidecar,
        }),
      ).catch(async (error: unknown) => {
        // The source was deleted while this copy waited its turn on the destination.
        if (!(await Bun.file(filePath(source)).exists())) throw objectNotFound(DRIVER_NAME, source);
        throw error;
      });
      return {
        ...entry,
        key: destination,
        contentType: sidecar.contentType,
        lastModified: clock.now(),
      };
    },

    async delete(key: string): Promise<void> {
      const safe = assertSafeKey(key);
      // Idempotent by contract: a missing key is already in the desired state. A REFUSED unlink
      // is not — a read-only mount or a root this process cannot write reports the bytes gone
      // when they are still on disk, which is the one lie an erasure sweep must never repeat.
      await oneAtATime(safe, async () => {
        await removeIfPresent(filePath(safe), safe);
        await removeIfPresent(metaPath(safe), safe);
        await removeIfPresent(`${root}/${pendingPathOf(safe)}`, safe);
      });
    },

    async exists(key: string): Promise<boolean> {
      return Bun.file(filePath(assertSafeKey(key))).exists();
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const prefix = listOptions?.prefix ?? '';
      assertListOptions(listOptions);
      const limit = resolveListLimit(listOptions?.limit);
      const cursor = listOptions?.cursor;
      const keys: string[] = [];
      try {
        // `dot: true`, and it is load-bearing: without it a glob matches no dot-prefixed entry, so
        // every object whose key has one — `.hidden.txt`, `org/o1/pending/.x.png`, the
        // `.metadata/a.json` `path.test.ts` pins as legal — was absent from the listing while
        // `put`/`get`/`exists` handled it normally and the s3 listing returned it. `sweepOrphans`
        // pages through `list()`, so those objects were swept as if they did not exist: a false
        // erasure report by omission, which is what the classification below exists to prevent.
        for await (const entry of new Bun.Glob('**/*').scan({
          cwd: root,
          onlyFiles: true,
          dot: true,
        })) {
          const key = entry.replaceAll('\\', '/');
          // The real filter now, not a second line of defence: the glob above yields the sidecar
          // tree, and this is the one thing keeping `.meta/<key>.json` out of the object
          // namespace. Folded like `assertSafeKey`'s reservation — `.META/` and `.meta/` are one
          // directory on APFS and NTFS, and listing a key `get()` would refuse is the worse half.
          if (key.toLowerCase().startsWith(`${META_DIR}/`)) continue;
          if (!key.startsWith(prefix)) continue;
          // The cursor IS the last key of the previous page — lexicographic order keeps it stable.
          if (cursor !== undefined && key <= cursor) continue;
          keys.push(key);
        }
      } catch (error) {
        // A disk nobody has written to yet has no directory: an empty listing, not an error.
        if (isMissingFile(error)) return { objects: [], truncated: false };
        // Everything else is a refusal, and a bare `catch` reported all of them as "this disk is
        // empty" — `EACCES` on the root, `ENOTDIR` on a root that is a file, an I/O error on the
        // mount. `sweepOrphans` walks `list()`, so that swallow certified an unreadable prefix as
        // having no orphans: the same false report `delete()`'s `.catch(() => undefined)` used to
        // make, one call to the left.
        throw listFailed(
          DRIVER_NAME,
          prefix,
          error,
          `make the disk root readable by this process, then retry: ls -ld ${renderFixShellArg(root, "'<the disk root>'")}`,
        );
      }
      keys.sort();
      const page = keys.slice(0, limit);
      const objects: StorageListEntry[] = [];
      for (const key of page) {
        const object = await head(key);
        if (object !== undefined) objects.push(object);
      }
      const truncated = keys.length > page.length;
      // `limit` is a positive integer, so a truncated page always HAS a last key: the guard is the
      // type's and not a second condition. It used to be one, and `limit: 0` fell through it —
      // an empty page reported as complete over a disk that was not.
      const last = page.at(-1);
      return truncated && last !== undefined
        ? { objects, truncated, cursor: last }
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
  };
}
