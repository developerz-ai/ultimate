// Single responsibility: the local disk's sidecar — the JSON file under `.meta/` holding what a
// POSIX file has nowhere to keep (content type, etag, cache-control, user metadata), and the one
// parser that reads it back as untrusted bytes off a disk.

export interface Sidecar {
  readonly contentType: string;
  readonly etag: string;
  readonly cacheControl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
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
  return {
    contentType,
    etag,
    ...(typeof cacheControl === 'string' ? { cacheControl } : {}),
    ...(isStringRecord(metadata) ? { metadata } : {}),
  };
}
