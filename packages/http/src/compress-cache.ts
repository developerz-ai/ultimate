// The coded bodies one process keeps, so a public answer under a strong validator is coded once
// rather than on every hit. A bounded LRU over entries and bytes: past either bound the least
// recently used body goes, and a body the stage could not keep is simply coded again.

/** At most this many coded bodies; each is at most `COMPRESS_MAX_BYTES` before coding. */
export const COMPRESS_CACHE_MAX_ENTRIES = 512;

/** At most this many coded bytes, keys included — the static memo's idea of a byte budget. */
export const COMPRESS_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export interface CompressCache {
  get(key: string): Uint8Array<ArrayBuffer> | undefined;
  set(key: string, body: Uint8Array<ArrayBuffer>): void;
  readonly size: number;
  readonly bytes: number;
}

export interface CompressCacheBounds {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/**
 * The key: the URL, because a strong ETag is unique per resource and never across two; the coding
 * and the declared identity length beside it, so a validator reused for other bytes of another
 * length misses rather than answers. A forged `Host` makes a new key, which the bounds absorb.
 */
export const compressCacheKey = (
  url: string,
  etag: string,
  coding: string,
  identityLength: string,
): string => `${coding}\n${identityLength}\n${etag}\n${url}`;

export function createCompressCache({
  maxEntries = COMPRESS_CACHE_MAX_ENTRIES,
  maxBytes = COMPRESS_CACHE_MAX_BYTES,
}: CompressCacheBounds = {}): CompressCache {
  // A `Map` iterates in insertion order, so re-inserting on a hit makes the first key the LRU.
  const kept = new Map<string, Uint8Array<ArrayBuffer>>();
  let bytes = 0;
  const weigh = (key: string, body: Uint8Array): number => key.length + body.byteLength;
  const drop = (key: string): void => {
    const body = kept.get(key);
    if (body === undefined) return;
    kept.delete(key);
    bytes -= weigh(key, body);
  };
  return {
    get(key) {
      const body = kept.get(key);
      if (body === undefined) return undefined;
      kept.delete(key);
      kept.set(key, body);
      return body;
    },
    set(key, body) {
      drop(key);
      const weight = weigh(key, body);
      if (weight > maxBytes || maxEntries < 1) return;
      for (const oldest of kept.keys()) {
        if (kept.size < maxEntries && bytes + weight <= maxBytes) break;
        drop(oldest);
      }
      kept.set(key, body);
      bytes += weight;
    },
    get size() {
      return kept.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
