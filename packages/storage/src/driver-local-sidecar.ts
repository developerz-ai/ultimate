// Single responsibility: the local disk's sidecar — the JSON file under `.meta/` holding what a
// POSIX file has nowhere to keep (content type, etag, cache-control, user metadata, the object
// lock), and the one parser that reads it back as untrusted bytes off a disk.

import { isRetentionMode, type ObjectLock, type RetentionMode } from './object-lock';

/** The lock as JSON holds it: the instant as an ISO string, the hold only when it is on. */
export interface SidecarLock {
  readonly retention?: { readonly mode: RetentionMode; readonly retainUntil: string } | undefined;
  readonly legalHold?: true | undefined;
}

export interface Sidecar extends SidecarLock {
  readonly contentType: string;
  readonly etag: string;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /**
   * The write's instant as ISO, read off the disk's injected `Clock` — what `put()`/`copy()`
   * returned, so a later `stat`/`get`/`list` reports the same instant (the memory disk's rule).
   * Absent on a sidecar written before it was recorded: the file's mtime answers instead.
   */
  readonly lastModified?: string | undefined;
}

/** `ObjectLock` → the fields a sidecar records. Nothing when nothing locks the object. */
export function sidecarLock(lock: ObjectLock | undefined): SidecarLock {
  if (lock === undefined) return {};
  return {
    ...(lock.retention === undefined
      ? {}
      : {
          retention: {
            mode: lock.retention.mode,
            retainUntil: lock.retention.retainUntil.toISOString(),
          },
        }),
    ...(lock.legalHold ? { legalHold: true } : {}),
  };
}

/** The recorded lock as `ObjectLock`. A retention that does not parse is no retention. */
export function lockOfSidecar(sidecar: SidecarLock | undefined): ObjectLock {
  const recorded = sidecar?.retention;
  return {
    ...(recorded === undefined
      ? {}
      : { retention: { mode: recorded.mode, retainUntil: new Date(recorded.retainUntil) } }),
    legalHold: sidecar?.legalHold === true,
  };
}

function parseRetention(raw: unknown): SidecarLock['retention'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const mode = (raw as Record<string, unknown>)['mode'];
  const until = (raw as Record<string, unknown>)['retainUntil'];
  if (!isRetentionMode(mode) || typeof until !== 'string') return undefined;
  if (!Number.isFinite(Date.parse(until))) return undefined;
  return { mode, retainUntil: until };
}

// `!Array.isArray` is the load-bearing clause, matching `isPlainObject` in
// `@ultimat3/schema`'s `builder.ts`: `typeof [] === 'object'` and every value of `['a','b']` is a
// string, so an array in the `metadata` slot was handed back through `head()`/`get()` as object
// metadata — against a `Record<string, string>` every reader downstream is typed on.
const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');

export function parseSidecar(raw: unknown): Sidecar | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const contentType = record['contentType'];
  const etag = record['etag'];
  if (typeof contentType !== 'string' || typeof etag !== 'string') return undefined;
  // `put()` writes cacheControl/metadata into the same sidecar — dropping them here silently
  // truncated what was just written, even though `Sidecar` itself declares both.
  const cacheControl = record['cacheControl'];
  const metadata = record['metadata'];
  const retention = parseRetention(record['retention']);
  const lastModified = record['lastModified'];
  return {
    contentType,
    etag,
    ...(typeof cacheControl === 'string' ? { cacheControl } : {}),
    ...(isStringRecord(metadata) ? { metadata } : {}),
    // An instant that does not parse is no instant — never an invalid `Date` handed to a reader.
    ...(typeof lastModified === 'string' && Number.isFinite(Date.parse(lastModified))
      ? { lastModified }
      : {}),
    ...(retention === undefined ? {} : { retention }),
    ...(record['legalHold'] === true ? { legalHold: true } : {}),
  };
}
