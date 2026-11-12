// The `compress` stage: which answers leave the container coded (`etag-form.ts` decides the offer),
// the read that gets their bytes, and the coder. Bun's own coders and no option: a handler that
// must not be coded says `no-transform`. Every other answer is handed back as the same object.
import { logger } from '@ultimat3/core';
import { type CompressCache, compressCacheKey, createCompressCache } from './compress-cache';
import {
  createPrecodeStore,
  isPrecodable,
  type PrecodeStore,
  type Precoding,
  precodeKey,
} from './compress-precode';
import { concatChunks, drainCounted, replayDrained } from './compress-read';
import {
  applyEtagForm,
  type ContentCoding,
  codingOffered,
  compressibleKind,
  isCompressibleType,
} from './etag-form';
import { addVary } from './response';

export { isCompressibleType };

/** Below this a coding's header and trailer eat what it saves. */
export const COMPRESS_MIN_BYTES = 1_024;

/**
 * The most one request may make `gzipSync` hold the event loop for. Measured 2026-11-03, level 6,
 * high-entropy text, median of 15: 2.35 ms at 256 KiB against 9.58 ms at 1 MiB (about 29 ms at
 * 1 MiB on slower hardware, where 1 MiB let ~34 anonymous req/s pin a core). Stylesheets code
 * about 15x faster than that worst case. zstd at level 3 is about 4x cheaper again.
 */
export const COMPRESS_MAX_BYTES = 262_144;

type Coder = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;

/**
 * The coder per offered coding: keyed by `etag-form.ts`'s `ContentCoding`, so offering a coding
 * with no coder here is a type error. Past the ceiling the same name is a `CompressionStream`.
 * Null-prototype: a key that reached here unvalidated answers `undefined`, never `Object.prototype`.
 */
const CODERS: Readonly<Record<ContentCoding, Coder>> = Object.assign(Object.create(null), {
  zstd: (bytes) => Bun.zstdCompressSync(bytes, { level: 3 }),
  gzip: (bytes) => Bun.gzipSync(bytes, { level: 6 }),
} satisfies Record<ContentCoding, Coder>);

/**
 * The coder for a body `compress-cache.ts` KEEPS — coded once per (URL, strong ETag), so the level
 * is paid once. Measured 2026-11-12 on the demo's 170,641 B sheet, Bun 1.4.4, median of 15: zstd 3
 * 27,136 B (0.7 ms) lost to gzip 6's 23,798 B; zstd 9 is 22,051 B in 3.2 ms; zstd 12 is 21,464 B
 * in 16 ms — the knee is 9. gzip 9: 23,674 B in 3.9 ms. Still on the loop, so never 19 here.
 */
const KEPT_CODERS: Readonly<Record<ContentCoding, Coder>> = Object.assign(Object.create(null), {
  zstd: (bytes) => Bun.zstdCompressSync(bytes, { level: 9 }),
  gzip: (bytes) => Bun.gzipSync(bytes, { level: 9 }),
} satisfies Record<ContentCoding, Coder>);

/**
 * Bun's `CompressionStream` codes `zstd` too (`Bun.CompressionFormat`); the DOM lib's constructor
 * type, which wins in this workspace, predates it. The probe in `etag-form.ts` is the proof.
 */
const CodingStream = CompressionStream as unknown as new (
  format: Bun.CompressionFormat,
) => CompressionStream;

/** A shared answer: the one kind whose coded bytes may serve the next visitor too. */
const SHARED = /(?:^|[\s,])(?:public|s-maxage)(?=$|[\s,=])/i;

/** The process's coded bodies, used when the caller hands none (`compress-cache.ts`). */
const processCache = createCompressCache();

/** The process's precoded immutable bodies, used when the caller hands none (`compress-precode.ts`). */
const processPrecode = createPrecodeStore();

const DECLARED_LENGTH = /^\d+$/;

const inBounds = (length: string | null): length is string =>
  length !== null &&
  DECLARED_LENGTH.test(length) &&
  Number(length) >= COMPRESS_MIN_BYTES &&
  Number(length) <= COMPRESS_MAX_BYTES;

const rebuilt = (response: Response, body: BodyInit | null, headers: Headers): Response =>
  new Response(body, { status: response.status, statusText: response.statusText, headers });

/**
 * A feed delivers each line as it is written, and `CompressionStream` emits only its header until
 * the source closes — so an undeclared feed is never coded. Declared, it is a document.
 */
const FEED_TYPES: ReadonlySet<string> = new Set(['application/x-ndjson']);

const isFeed = (contentType: string | null): boolean =>
  FEED_TYPES.has(contentType?.split(';')[0]?.trim().toLowerCase() ?? '');

/** Past the ceiling: coded as the client pulls (`CompressionStream`), never on the event loop. */
const pastCeiling = (length: string): boolean =>
  DECLARED_LENGTH.test(length) && Number(length) > COMPRESS_MAX_BYTES;

/** The headers of a coded answer: everything that described the identity bytes, corrected. */
const codedHeaders = (
  response: Response,
  coding: ContentCoding | Precoding,
  length: number | null,
) => {
  const headers = new Headers(response.headers);
  headers.set('content-encoding', coding);
  if (length === null) headers.delete('content-length');
  else headers.set('content-length', String(length));
  // A byte offset into the identity bytes means nothing in these.
  headers.delete('accept-ranges');
  headers.delete('transfer-encoding');
  return headers;
};

const coded = (
  response: Response,
  coding: ContentCoding | Precoding,
  body: Uint8Array<ArrayBuffer>,
  head: boolean,
) => rebuilt(response, head ? null : body, codedHeaders(response, coding, body.byteLength));

/** Bytes over a plain `ArrayBuffer`, the only kind the coder's `BufferSource` side accepts. */
const ownsPlainBuffer = (chunk: Uint8Array): chunk is Uint8Array<ArrayBuffer> =>
  chunk.buffer instanceof ArrayBuffer;

const codedStream = (
  response: Response,
  coding: ContentCoding,
  body: ReadableStream<Uint8Array>,
): Response => {
  // A chunk over shared memory is copied; every other one passes through untouched.
  const plain = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        controller.enqueue(ownsPlainBuffer(chunk) ? chunk : new Uint8Array(chunk));
      },
    }),
  );
  return rebuilt(
    response,
    plain.pipeThrough(new CodingStream(coding)),
    codedHeaders(response, coding, null),
  );
};

/** Identity after a read began. Never the declared length: the failed read just disproved it. */
const identity = (
  response: Response,
  body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>,
) => {
  const headers = new Headers(response.headers);
  if (body instanceof Uint8Array) headers.set('content-length', String(body.byteLength));
  else headers.delete('content-length');
  return rebuilt(response, body, headers);
};

/**
 * No declared length (`new Response(string)` declares none in Bun): read up to the floor first. A
 * body that ends under it leaves identity, whole, with its length; one that reaches it is coded as
 * a stream, the bytes already read first. A feed is never read. Bounded by the request's deadline.
 */
const codeUndeclared = async (
  response: Response,
  coding: ContentCoding,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Response> => {
  if (isFeed(response.headers.get('content-type'))) return response;
  const reader = body.getReader();
  const drained = await drainCounted(reader, COMPRESS_MIN_BYTES - 1, signal);
  if (drained.complete) return identity(response, concatChunks(drained.chunks));
  const rest = replayDrained(drained.chunks, reader, drained.pending);
  if (drained.reason === 'longer-than-declared') return codedStream(response, coding, rest);
  logger.warn('http.compress_failed', {
    reason: drained.reason,
    declaredBytes: null,
    ...(drained.failure === undefined ? {} : { error: drained.failure }),
  });
  return identity(response, rest);
};

/**
 * The key a coded body is kept under, or `undefined` when it must be coded afresh: only a strong
 * validator promises the same bytes next time, and only an anonymous, shared answer is the next
 * visitor's too. Read BEFORE `applyEtagForm` weakens the tag.
 */
const keptKey = (
  request: Request,
  response: Response,
  coding: ContentCoding,
  length: string,
  anonymous: boolean,
): string | undefined => {
  const etag = response.headers.get('etag');
  if (!anonymous || etag === null || etag.startsWith('W/')) return undefined;
  if (!SHARED.test(response.headers.get('cache-control') ?? '')) return undefined;
  return compressCacheKey(request.url, etag, coding, length);
};

export interface CompressContext {
  /** `isAnonymous(ctx.actor)`. Declared, never defaulted: a forgotten actor must not code. */
  readonly anonymous: boolean;
  /** The request's: past it, a body still being read goes out as identity. */
  readonly signal?: AbortSignal;
  /** Where coded public bodies are kept. Omitted: the process's own, bounded. */
  readonly cache?: CompressCache;
  /** Where `immutable` bodies are precoded. Omitted: the process's own, bounded. */
  readonly precode?: PrecodeStore;
}

/**
 * The answer to send. Total: a compression failure is never a request failure, and the log line
 * carries it.
 */
export const compressResponse = async (
  request: Request,
  response: Response,
  { anonymous, signal, cache = processCache, precode = processPrecode }: CompressContext,
): Promise<Response> => {
  if (!compressibleKind(response.headers, anonymous)) return response;
  // On coded and identity alike, before any other refusal: a shared cache must not hand this
  // client's copy to one that refused the coding, whichever of the two this client got.
  addVary(response, ['accept-encoding']);
  const coding = codingOffered(request.method, request.headers.get('accept-encoding'));
  if (
    coding === undefined ||
    response.headers.has('content-encoding') ||
    response.headers.has('content-range')
  ) {
    return response;
  }
  // The 304 names the validator the 200 named (RFC 9110 §15.4.5): one offer, one form.
  if (response.status === 304) {
    applyEtagForm(response.headers, coding);
    return response;
  }
  if (response.status !== 200) return response;
  const length = response.headers.get('content-length');
  // Read before `applyEtagForm`: a strong validator goes to the memo, which answers it unread.
  const precodable = inBounds(length) && isPrecodable(response.headers);
  const key =
    inBounds(length) && !precodable
      ? keptKey(request, response, coding, length, anonymous)
      : undefined;
  applyEtagForm(response.headers, coding);
  if (response.body === null || response.bodyUsed) return response;
  if (length === null) return codeUndeclared(response, coding, response.body, signal);
  if (pastCeiling(length)) return codedStream(response, coding, response.body);
  if (!inBounds(length)) return response;
  const head = request.method === 'HEAD';
  const kept = key === undefined ? undefined : cache.get(key);
  if (kept !== undefined) {
    // These bytes were coded from a body under this very validator: this one is never read.
    response.body.cancel().catch(() => {});
    return coded(response, coding, kept, head);
  }
  const reader = response.body.getReader();
  const drained = await drainCounted(reader, Number(length), signal);
  if (!drained.complete) {
    logger.warn('http.compress_failed', {
      reason: drained.reason,
      declaredBytes: Number(length),
      ...(drained.failure === undefined ? {} : { error: drained.failure }),
    });
    return identity(response, replayDrained(drained.chunks, reader, drained.pending));
  }
  const bytes = concatChunks(drained.chunks);
  if (precodable) {
    // Coded once, off the loop, after the first hit: from then on this answer runs no coder.
    const precodedKey = precodeKey(request.url, bytes);
    const kept = precode.pick(precodedKey, request.headers.get('accept-encoding'));
    if (kept !== undefined) return coded(response, kept.coding, kept.body, head);
    precode.schedule(precodedKey, bytes);
  }
  try {
    const out = (key === undefined ? CODERS : KEPT_CODERS)[coding](bytes);
    const body = ownsPlainBuffer(out) ? out : new Uint8Array(out);
    if (key !== undefined) cache.set(key, body);
    return coded(response, coding, body, head);
  } catch (failure) {
    logger.warn('http.compress_failed', {
      reason: `${coding}-failed`,
      declaredBytes: Number(length),
      error: failure,
    });
    return identity(response, bytes);
  }
};
