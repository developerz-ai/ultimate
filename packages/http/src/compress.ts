// The `compress` stage's one rule: which answers leave the container gzipped, and the read that
// gets their bytes. Bun's own coder and no option: a handler that must not be coded says
// `no-transform`. Every other answer is handed back as the same object, its body never touched.
import { logger } from '@ultimat3/core';
import { concatChunks, drainCounted, replayDrained } from './compress-read';
import { addVary } from './response';

/** Below this the gzip header and trailer eat what the coding saves. */
export const COMPRESS_MIN_BYTES = 1_024;

/**
 * The most one request may make `gzipSync` hold the event loop for. Measured 2026-11-03, level 6,
 * high-entropy text, median of 15: 2.35 ms at 256 KiB against 9.58 ms at 1 MiB (about 29 ms at
 * 1 MiB on slower hardware, where 1 MiB let ~34 anonymous req/s pin a core). Stylesheets code
 * about 15x faster than that worst case.
 */
export const COMPRESS_MAX_BYTES = 262_144;

const GZIP_LEVEL = 6;

/** Text only: images and fonts are coded already, and `text/event-stream` must never be held. */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'text/vtt',
]);

/**
 * BREACH: a private document reflects a secret beside attacker input, and a coded length measures
 * how well the two match. `no-cache` is here because it is the one spelling that passes the
 * `cache-headers` review on a signed-in answer without becoming `private`.
 */
const WITHHOLDS_CODING = /(?:^|[\s,])(?:private|no-store|no-cache|no-transform)(?=$|[\s,=])/i;

const DECLARED_LENGTH = /^\d+$/;

const IMMUTABLE = /(?:^|[\s,])immutable(?=$|[\s,=])/i;

/**
 * Whether a `content-type` is one this stage codes. Exported for the one reader that must agree
 * with it: `@ultimat3/cli`'s test holding every public framework route to a declared length.
 */
export const isCompressibleType = (contentType: string | null): boolean => {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type !== undefined && COMPRESSIBLE_TYPES.has(type);
};

/**
 * A signed-in answer is coded only when `immutable`: a header like `stale-while-revalidate=60`
 * withholds nothing and offers nothing, so the `cache-headers` review leaves it as written, and
 * the body beside it is still the visitor's. The ACTOR is what makes it personal, never the header.
 */
const compressibleKind = (headers: Headers, anonymous: boolean): boolean => {
  const cacheControl = headers.get('cache-control') ?? '';
  return (
    isCompressibleType(headers.get('content-type')) &&
    !WITHHOLDS_CODING.test(cacheControl) &&
    (anonymous || IMMUTABLE.test(cacheControl))
  );
};

/** HEAD is GET's headers with no body (RFC 9110 §9.3.2), so it is coded exactly as GET is. */
const CODED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** RFC 9110 §12.5.3, `gzip` by name. A `*` is not read as consent to a coding it never named. */
const acceptsGzip = (header: string | null): boolean => {
  for (const member of header?.split(',') ?? []) {
    const [coding, ...params] = member.split(';').map((part) => part.trim().toLowerCase());
    if (coding !== 'gzip') continue;
    const weight = params.find((param) => param.startsWith('q='));
    return weight === undefined || Number(weight.slice(2)) > 0;
  }
  return false;
};

const inBounds = (length: string | null): length is string =>
  length !== null &&
  DECLARED_LENGTH.test(length) &&
  Number(length) >= COMPRESS_MIN_BYTES &&
  Number(length) <= COMPRESS_MAX_BYTES;

const rebuilt = (response: Response, body: BodyInit | null, headers: Headers): Response =>
  new Response(body, { status: response.status, statusText: response.statusText, headers });

const coded = (response: Response, bytes: Uint8Array<ArrayBuffer>, head: boolean): Response => {
  const gzipped = Bun.gzipSync(bytes, { level: GZIP_LEVEL });
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.set('content-length', String(gzipped.byteLength));
  // A byte offset into the identity bytes means nothing in these.
  headers.delete('accept-ranges');
  headers.delete('transfer-encoding');
  const etag = headers.get('etag');
  // A strong validator promises these exact bytes, and the identity answer has other ones.
  if (etag !== null && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
  return rebuilt(response, head ? null : gzipped, headers);
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

export interface CompressContext {
  /** `isAnonymous(ctx.actor)`. Declared, never defaulted: a forgotten actor must not code. */
  readonly anonymous: boolean;
  /** The request's: past it, a body still being read goes out as identity. */
  readonly signal?: AbortSignal;
}

/**
 * The answer to send. Total: a compression failure is never a request failure, and the log line
 * carries it.
 */
export const compressResponse = async (
  request: Request,
  response: Response,
  { anonymous, signal }: CompressContext,
): Promise<Response> => {
  if (!compressibleKind(response.headers, anonymous)) return response;
  // On coded and identity alike, before any other refusal: a shared cache must not hand this
  // client's copy to one that refused the coding, whichever of the two this client got.
  addVary(response, ['accept-encoding']);
  const length = response.headers.get('content-length');
  if (
    !CODED_METHODS.has(request.method) ||
    response.status !== 200 ||
    !acceptsGzip(request.headers.get('accept-encoding')) ||
    response.headers.has('content-encoding') ||
    response.headers.has('content-range') ||
    !inBounds(length) ||
    response.body === null ||
    response.bodyUsed
  ) {
    return response;
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
  try {
    return coded(response, bytes, request.method === 'HEAD');
  } catch (failure) {
    logger.warn('http.compress_failed', {
      reason: 'gzip-failed',
      declaredBytes: Number(length),
      error: failure,
    });
    return identity(response, bytes);
  }
};
