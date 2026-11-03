// Single responsibility: the one correct answer to a GET for an object held elsewhere — its stored
// type, its validator, one `Range:` window, the sandbox for a type a browser would run. `/_storage`,
// `/media`, a download and an app's own route for an object a stranger may fetch all answer here.
// Structural, because this package imports no storage: anything with these fields is servable.

import {
  contentRangeOf,
  parseByteRange,
  RANGE_UNSATISFIABLE,
  type RequestedRange,
} from './byte-range';
import type { CacheHint } from './response';
import { applyCacheHeaders } from './response';
import { storedObjectHeaders } from './stored-object-headers';

/** What the answer needs to know before it opens anything. `StorageObject` is one of these. */
export interface ServableObject {
  /** The STORED type. An extension in the URL is the only party that can lie. */
  readonly contentType: string;
  readonly size: number;
  /** The object's own validator. Absent or `''` (unknowable): no `etag` header, and no 304. */
  readonly etag?: string | undefined;
  /** Omitted, never invented: a made-up date is a validator a cache would go on to trust. */
  readonly lastModified?: Date | undefined;
}

export interface ObjectSource {
  readonly object: ServableObject;
  /**
   * Exactly those bytes, or the whole object with no range. Opened only once a body will be sent: a
   * 304 and a 416 open nothing. Takes the range so a disk can serve a window, not drop a prefix.
   */
  readonly open: (range?: RequestedRange) => BodyInit | Promise<BodyInit>;
}

/** The one thing asked of the request, so a test or a non-pipeline caller needs no `Request`. */
export interface ObjectRequest {
  header(name: string): string | null;
}

export interface ObjectResponseOptions {
  /** Applied to every answer. Omitted, the route's declared `meta.cache` decides as for any route. */
  readonly cache?: CacheHint | undefined;
  /** Replaces the stored-object sandbox rule, for a caller with its own, as a download has. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** `*`, a weak validator and a comma list all count — the etag is what has to match. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * The 304 for a client already holding `etag`, or nothing for the caller to go on and answer. It
 * repeats the validator and whatever posture `headers` carry (RFC 9110 §15.4.5).
 */
export function notModified(
  request: ObjectRequest,
  etag: string,
  headers?: HeadersInit,
): Response | undefined {
  if (!etagMatches(request.header('if-none-match'), etag.replace(/^W\//, ''))) return undefined;
  const answer = new Headers(headers);
  answer.set('etag', etag);
  return new Response(null, { status: 304, headers: answer });
}

/**
 * Whether `if-range` still names these bytes. Compared strongly, and a date only if it is exactly
 * the object's: a window of an older revision spliced onto this one is two files in one download.
 */
function ifRangeHolds(header: string | null, etag: string | undefined, modified?: Date): boolean {
  if (header === null) return true;
  const validator = header.trim();
  if (validator.startsWith('W/')) return false;
  if (validator.startsWith('"')) return etag === validator;
  return modified?.toUTCString() === validator;
}

/** A provider's etag may arrive already quoted, and quoting it again answers an invalid header. */
const quotedEtag = (etag: string): string =>
  etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;

/**
 * Revalidation costs a request and no bytes, which is the trade an authorized response wants: the
 * bytes do not change under a validator, but the actor's permission to read them can be revoked.
 * The size is the object's description, so the length declared is the length `open` must deliver.
 */
export async function objectResponse(
  request: ObjectRequest,
  source: ObjectSource,
  options: ObjectResponseOptions = {},
): Promise<Response> {
  const { object } = source;
  const headers = new Headers({
    'content-type': object.contentType,
    'accept-ranges': 'bytes',
    // A type a browser would RUN (html, svg, xml) is a download, never a page on this origin.
    ...(options.headers ?? storedObjectHeaders(object.contentType)),
  });
  if (object.lastModified !== undefined) {
    headers.set('last-modified', object.lastModified.toUTCString());
  }
  const answer = (body: BodyInit | null, status: number): Response => {
    const response = new Response(body, { status, headers });
    return options.cache === undefined ? response : applyCacheHeaders(response, options.cache);
  };

  const etag =
    object.etag === undefined || object.etag === '' ? undefined : quotedEtag(object.etag);
  if (etag !== undefined) {
    headers.set('etag', etag);
    if (notModified(request, etag) !== undefined) return answer(null, 304);
  }

  const { size } = object;
  // A range of another revision is no range at all: the whole object, never a 416 either.
  const range = ifRangeHolds(request.header('if-range'), etag, object.lastModified)
    ? parseByteRange(request.header('range'), size)
    : undefined;
  if (range === RANGE_UNSATISFIABLE) {
    headers.set('content-range', `bytes */${String(size)}`);
    return answer(null, 416);
  }
  if (range === undefined) {
    headers.set('content-length', String(size));
    return answer(await source.open(), 200);
  }
  headers.set('content-range', contentRangeOf(range, size));
  headers.set('content-length', String(range.end - range.start + 1));
  return answer(await source.open(range), 206);
}
