// Content-addressed answers coded ONCE, at the strongest settings, off the event loop: an
// `immutable` URL never changes its bytes, so its brotli, zstd and gzip bodies are made in the
// background after its first hit and every later hit is a lookup — no coder runs per request.
import { logger } from '@ultimat3/core';
import { type CompressCache, createCompressCache } from './compress-cache';
import { negotiateFrom } from './etag-form';

/**
 * Best first. Measured 2026-11-12 on the demo's three surface sheets (158–180 kB), Bun 1.4.4:
 * brotli q11 19,496 B in 318 ms, zstd 19 20,503 B in 107 ms, gzip 9 23,674 B in 3.5 ms — against
 * the per-request zstd 3 (27,136 B) and gzip 6 (23,798 B). Only affordable because it runs once.
 */
export const PRECODINGS = ['br', 'zstd', 'gzip'] as const;

export type Precoding = (typeof PRECODINGS)[number];

type Coder = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/** A thread-pool job resolved as a promise: `node:zlib`'s callback shape. */
const pooled = (
  run: (bytes: Uint8Array, done: (error: Error | null, out: Uint8Array) => void) => void,
  bytes: Uint8Array,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) =>
    run(bytes, (error, out) => (error ? reject(error) : resolve(out))),
  );

// why: Bun's only native brotli is `CompressionStream('brotli')`, fixed at quality 11 on the
// event loop; `node:zlib` codes on the thread pool. Resolved at the call: no browser graph.
function serverZlib(): typeof import('node:zlib') {
  // why: no Bun-native brotli coder with a quality setting or off the event loop.
  return process.getBuiltinModule('node:zlib');
}

/** The real coders, each on the thread pool. Keyed by `Precoding`: a missing one is a type error. */
export const PRECODERS: Readonly<Record<Precoding, Coder>> = {
  br: (bytes) => {
    const zlib = serverZlib();
    const params = {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    };
    return pooled((input, done) => zlib.brotliCompress(input, { params }, done), bytes);
  },
  zstd: (bytes) => Bun.zstdCompress(bytes, { level: 19 }),
  gzip: (bytes) => pooled((input, done) => serverZlib().gzip(input, { level: 9 }, done), bytes),
};

const IMMUTABLE = /(?:^|[\s,])immutable(?=$|[\s,=])/i;
const SHARED = /(?:^|[\s,])public(?=$|[\s,=])/i;

/**
 * An answer whose URL IS its bytes (`immutable`, `public`): an island chunk, a surface stylesheet,
 * a worker. One under a strong ETag is left to `compress-cache.ts`, which answers it unread.
 */
export const isPrecodable = (headers: Headers): boolean => {
  const cacheControl = headers.get('cache-control') ?? '';
  const etag = headers.get('etag');
  return (
    IMMUTABLE.test(cacheControl) &&
    SHARED.test(cacheControl) &&
    (etag === null || etag.startsWith('W/'))
  );
};

/**
 * The key: the path, not the URL — a forged `Host` must not start another 300 ms of brotli — plus
 * the length and a hash of the bytes, so a path whose bytes did move (a stale build, a dev save)
 * misses rather than answers with another body's coding.
 */
export const precodeKey = (url: string, bytes: Uint8Array): string =>
  `${new URL(url).pathname}\n${bytes.byteLength}\n${Bun.hash(bytes).toString(36)}`;

/** The best kept coding a request accepts: `etag-form.ts`'s one weight parser over `PRECODINGS`. */
export const precodingAccepted = (
  header: string | null,
  kept: (coding: Precoding) => boolean,
): Precoding | undefined => negotiateFrom(header, PRECODINGS, kept);

export interface Precoded {
  readonly coding: Precoding;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface PrecodeStore {
  /** The best kept coding of these bytes the client accepts, or `undefined` until one is made. */
  pick(key: string, acceptEncoding: string | null): Precoded | undefined;
  /** Codes `bytes` in every `PRECODINGS` entry, once per key, at most `concurrency` keys at once. */
  schedule(key: string, bytes: Uint8Array<ArrayBuffer>): void;
  /** Settles when nothing is being coded — what a test awaits instead of a clock. */
  idle(): Promise<void>;
}

export interface PrecodeOptions {
  /** Where the coded bodies are kept. Default: its own LRU, 512 entries / 16 MiB. */
  readonly cache?: CompressCache;
  /** Keys coded at once; past it a hit is coded per request as before, and asks again next time. */
  readonly concurrency?: number;
  readonly coders?: Readonly<Record<Precoding, Coder>>;
}

const plain = (out: Uint8Array): Uint8Array<ArrayBuffer> =>
  out.buffer instanceof ArrayBuffer ? (out as Uint8Array<ArrayBuffer>) : new Uint8Array(out);

export function createPrecodeStore({
  cache = createCompressCache(),
  concurrency = 2,
  coders = PRECODERS,
}: PrecodeOptions = {}): PrecodeStore {
  const running = new Map<string, Promise<void>>();
  const slot = (key: string, coding: Precoding): string => `${coding}\n${key}`;
  const code = async (key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    // `.then`, so a coder that throws SYNCHRONOUSLY is its coding's failure like any rejection.
    const coded = await Promise.allSettled(
      PRECODINGS.map((coding) => Promise.resolve().then(() => coders[coding](bytes))),
    );
    coded.forEach((outcome, index) => {
      const coding = PRECODINGS[index];
      if (coding === undefined) return;
      if (outcome.status === 'fulfilled') cache.set(slot(key, coding), plain(outcome.value));
      else
        logger.warn('http.precode_failed', {
          coding,
          bytes: bytes.byteLength,
          error: outcome.reason,
        });
    });
  };
  return {
    pick(key, acceptEncoding) {
      const coding = precodingAccepted(
        acceptEncoding,
        (c) => cache.get(slot(key, c)) !== undefined,
      );
      const body = coding === undefined ? undefined : cache.get(slot(key, coding));
      return coding === undefined || body === undefined ? undefined : { coding, body };
    },
    schedule(key, bytes) {
      if (running.has(key) || running.size >= concurrency) return;
      // Already coded: a hit that reached here asked for a coding this store does not make.
      if (PRECODINGS.some((coding) => cache.get(slot(key, coding)) !== undefined)) return;
      // A background job nobody awaits: anything it throws is logged, never an unhandled rejection.
      const job = code(key, bytes)
        .catch((error: unknown) => {
          logger.warn('http.precode_failed', { bytes: bytes.byteLength, error });
        })
        .finally(() => running.delete(key));
      running.set(key, job);
    },
    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}
