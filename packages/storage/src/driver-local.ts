// Single responsibility: the dev-default disk — a real, working driver over `Bun.file` /
// `Bun.write` rooted at one directory, so `x dev` needs no MinIO and no cloud account.
// Content type, etag and user metadata live in a sidecar under `.meta/`: a POSIX file has
// nowhere to keep them, and `get` must round-trip exactly what `put` was handed.

import { type Clock, isLocal, resolveEnvironment, systemClock } from '@ultimat3/core';
import {
  DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT,
  etagOf,
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
import { checksumMismatch, objectNotFound, signingSecretMissing } from './errors';
import { assertSafeKey, META_DIR } from './path';
import { buildSignedUrl } from './signed-url';

const DRIVER_NAME = 'local';

/**
 * The dev-only fallback signing key. A literal, not a per-process random one, so a restart does
 * not invalidate every URL `x dev` handed out — and published in this repo, which is exactly why
 * `localDriver` refuses to use it outside a development or test environment.
 */
export const DEV_SIGNING_SECRET = 'ultimate-dev-signing-secret';

/** The env key production must set. Named once, read by the driver and by the predicate below. */
export const STORAGE_SIGNING_SECRET_KEY = 'STORAGE_SIGNING_SECRET';

/**
 * True while a local disk built without an explicit `signingSecret` would sign with the shipped
 * development key — `x doctor` reports it, exactly as it reports `usesDevCursorSecret()`.
 *
 * Reads the environment, not a driver instance: this is the same question `x doctor` asks about
 * the cursor secret, and a disk handed an explicit `signingSecret` in `app.config.ts` never
 * consults the variable at all.
 */
export function usesDevStorageSecret(): boolean {
  const configured = process.env[STORAGE_SIGNING_SECRET_KEY];
  return configured === undefined || configured === '' || configured === DEV_SIGNING_SECRET;
}

export interface LocalDriverOptions {
  /** Directory the disk owns outright. Created on first write. */
  readonly root: string;
  /** HMAC secret for signed URLs. Production must pass one; dev falls back to a fixed string. */
  readonly signingSecret?: string | undefined;
  /** Route prefix the dev server serves signed URLs from. */
  readonly baseUrl?: string | undefined;
  readonly clock?: Clock | undefined;
}

interface Sidecar {
  readonly contentType: string;
  readonly etag: string;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');

function parseSidecar(raw: unknown): Sidecar | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const contentType = record['contentType'];
  const etag = record['etag'];
  if (typeof contentType !== 'string' || typeof etag !== 'string') return undefined;
  // `put()` writes cacheControl/metadata into the same sidecar (below) — dropping them here
  // silently truncated what was just written, even though `Sidecar` itself declares both.
  const cacheControl = record['cacheControl'];
  const metadata = record['metadata'];
  return {
    contentType,
    etag,
    ...(typeof cacheControl === 'string' ? { cacheControl } : {}),
    ...(isStringRecord(metadata) ? { metadata } : {}),
  };
}

export function localDriver(options: LocalDriverOptions): StorageDriver {
  const root = options.root.replace(/\/+$/, '');
  const clock = options.clock ?? systemClock;
  const baseUrl = options.baseUrl ?? `/_storage/${DRIVER_NAME}`;
  // A dev disk must work with zero config. Outside development the fallback is refused rather
  // than used: the literal is published, so signing with it hands every reader the power to mint
  // a PUT for any key with any size and type limit — which `acceptSignedUpload` then trusts over
  // the app's own `uploadPolicy`. Refused HERE, at construction, so the boot fails rather than
  // the first upload.
  // The published literal counts as no secret at all, whichever way it arrives: an env var or an
  // `app.config.ts` that pasted it in signs exactly as weakly as the fallback does.
  const supplied = options.signingSecret ?? process.env[STORAGE_SIGNING_SECRET_KEY];
  const configured =
    supplied === undefined || supplied === '' || supplied === DEV_SIGNING_SECRET
      ? undefined
      : supplied;
  if (configured === undefined && !isLocal()) throw signingSecretMissing(resolveEnvironment());
  const secret = configured ?? DEV_SIGNING_SECRET;

  const filePath = (key: string): string => `${root}/${key}`;
  const metaPath = (key: string): string => `${root}/${META_DIR}/${key}.json`;

  const readSidecar = async (key: string): Promise<Sidecar | undefined> => {
    const file = Bun.file(metaPath(key));
    if (!(await file.exists())) return undefined;
    try {
      const raw: unknown = await file.json();
      return parseSidecar(raw);
    } catch {
      return undefined;
    }
  };

  const head = async (key: string): Promise<StorageObject | undefined> => {
    const file = Bun.file(filePath(key));
    if (!(await file.exists())) return undefined;
    const sidecar = await readSidecar(key);
    // Only hash when the sidecar is gone — `list()` must not read every file it lists.
    const etag = sidecar?.etag ?? etagOf(new Uint8Array(await file.arrayBuffer()));
    return {
      key,
      size: file.size,
      contentType: sidecar?.contentType ?? DEFAULT_CONTENT_TYPE,
      etag,
      lastModified: new Date(file.lastModified),
      ...(sidecar?.cacheControl === undefined ? {} : { cacheControl: sidecar.cacheControl }),
      ...(sidecar?.metadata === undefined ? {} : { metadata: sidecar.metadata }),
    };
  };

  return {
    name: DRIVER_NAME,

    async put(key: string, body: StorageBody, putOptions?: PutOptions): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      const bytes = await toBytes(body);
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
      await Bun.write(filePath(safe), bytes);
      await Bun.write(metaPath(safe), JSON.stringify(sidecar));
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

    async get(key: string): Promise<StorageRead> {
      const safe = assertSafeKey(key);
      const object = await head(safe);
      if (object === undefined) throw objectNotFound(DRIVER_NAME, safe);
      const bytes = new Uint8Array(await Bun.file(filePath(safe)).arrayBuffer());
      return { object, bytes };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      const safe = assertSafeKey(key);
      const file = Bun.file(filePath(safe));
      if (!(await file.exists())) throw objectNotFound(DRIVER_NAME, safe);
      return file.stream();
    },

    async delete(key: string): Promise<void> {
      const safe = assertSafeKey(key);
      // Idempotent by contract: a missing key is already in the desired state.
      await Bun.file(filePath(safe))
        .delete()
        .catch(() => undefined);
      await Bun.file(metaPath(safe))
        .delete()
        .catch(() => undefined);
    },

    async exists(key: string): Promise<boolean> {
      return Bun.file(filePath(assertSafeKey(key))).exists();
    },

    async list(listOptions?: ListOptions): Promise<ListPage> {
      const prefix = listOptions?.prefix ?? '';
      const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;
      const cursor = listOptions?.cursor;
      const keys: string[] = [];
      try {
        for await (const entry of new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true })) {
          const key = entry.replaceAll('\\', '/');
          if (key.startsWith(`${META_DIR}/`)) continue;
          if (!key.startsWith(prefix)) continue;
          // The cursor IS the last key of the previous page — lexicographic order keeps it stable.
          if (cursor !== undefined && key <= cursor) continue;
          keys.push(key);
        }
      } catch {
        // A disk nobody has written to yet has no directory: an empty listing, not an error.
        return { objects: [], truncated: false };
      }
      keys.sort();
      const page = keys.slice(0, limit);
      const objects: StorageObject[] = [];
      for (const key of page) {
        const object = await head(key);
        if (object !== undefined) objects.push(object);
      }
      const truncated = keys.length > page.length;
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
  };
}
