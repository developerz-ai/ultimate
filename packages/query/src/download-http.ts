/**
 * A download query's route — the same `GET /_x/query/<kebab>` every read answers on, so the typed
 * client, `x routes`, the manifest and OpenAPI need no second URL rule. Without `_token` it MINTS
 * (`{ url, expiresAt }`, the policy deciding as for any read); with one it SERVES the file: bytes,
 * `content-disposition`, one `Range:` window, and `no-store` — the bytes are one actor's.
 */

import { assert, queryPath, useContext } from '@ultimat3/core';
import type { RateLimitDecision, Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import {
  byteWindow,
  contentRangeOf,
  jsonResponse,
  parseByteRange,
  publishRateLimit,
  RANGE_UNSATISFIABLE,
  type RequestedRange,
} from '@ultimat3/http';
import { policyCapability } from '@ultimat3/policy';
import { coerceQuery } from '@ultimat3/schema';
import type { DownloadFile } from './download';
import { mintDownloadUrl, serveDownloadFile } from './download';
import { DOWNLOAD_GRANT_PARAM } from './download-token';
import { QueryInputInvalidError } from './errors';
import { rateLimitedByHandler } from './http';
import { absentArraysOf } from './input-shape';
import { pageControlsOf } from './page-controls';
import type { AnyQuery } from './query';

/** The route for `target`, whose `download` is declared. `sunsetting` is `toQueryRoute`'s. */
export function toDownloadRoute(
  target: AnyQuery,
  name: string,
  sunsetting: Readonly<Record<string, string>> | undefined,
): Route {
  const handler = async (request: UltimateRequest): Promise<Response> => {
    if (sunsetting !== undefined) {
      for (const [header, value] of Object.entries(sunsetting)) {
        request.ctx.headers.set(header, value);
      }
    }
    const { values, token } = tokenOf(name, request.queryRaw());
    // A page of a file is not a thing: `_first`/`_after` are refused as on a single read.
    const { input: rest, page } = pageControlsOf(name, values);
    if (page !== undefined) {
      throw new QueryInputInvalidError(name, 'a download answers one file — it takes no _first');
    }
    const input = absentArraysOf(target.input, coerceQuery(target.input, rest));
    if (token === undefined) {
      const minted = await mintDownloadUrl(target, input, {
        surface: 'http',
        clientAddress: request.ctx.ip,
        onRateLimit: (decision: RateLimitDecision) =>
          publishRateLimit(request.ctx, decision, useContext().now().getTime()),
      });
      return jsonResponse(minted);
    }
    const file = await serveDownloadFile(target, input, token, { surface: 'http' });
    return fileResponse(file, request.header('range'));
  };

  const meta: RouteMeta = {
    name,
    // PUBLIC, and not unguarded: the mint runs this read's policy inside the handler like every
    // read (`enforcedBy`), and a serve is authorized by the sealed token the policy minted — the
    // reason a URL works in a `<video>` or a tab with no session header at all.
    auth: 'public',
    policy: policyCapability(target.policy),
    enforcedBy: 'handler',
    primitive: 'query',
    // One actor's bytes under a URL that names no actor: nothing may keep a copy.
    cache: { mode: 'no-store' },
    tags: ['query', 'download'],
    ...(target.rateLimit === undefined
      ? {}
      : { rateLimitedBy: rateLimitedByHandler(name, target.rateLimit) }),
  };
  return { method: 'GET', path: queryPath(name), handler, meta };
}

/** `_token` out of the search string — one string, or a refusal: two tokens are two grants. */
function tokenOf(
  name: string,
  values: Readonly<Record<string, string | readonly string[] | undefined>>,
): {
  readonly values: Record<string, string | readonly string[] | undefined>;
  readonly token: string | undefined;
} {
  const rest: Record<string, string | readonly string[] | undefined> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (key !== DOWNLOAD_GRANT_PARAM) rest[key] = value;
  }
  const token = values[DOWNLOAD_GRANT_PARAM];
  if (token === undefined || typeof token === 'string') return { values: rest, token };
  throw new QueryInputInvalidError(name, `${DOWNLOAD_GRANT_PARAM} was sent ${token.length} times`);
}

/** A C0 control or DEL — what turns one header value into two. */
const hasControl = (text: string): boolean =>
  [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/**
 * The handler's answer, held to its type before a header is written: a `contentType` or a
 * `filename` carrying a CR/LF would be a second header, and a body that is not bytes is a 500 the
 * handler's author has to see named.
 */
function assertFile(file: DownloadFile): void {
  const { body, contentType, filename, disposition, size } = file;
  assert(
    body instanceof Uint8Array || body instanceof Blob || body instanceof ReadableStream,
    'a download handle() answered a body that is not a Uint8Array, a Blob or a ReadableStream',
    "return { body: bytes, contentType: 'video/mp4', filename: 'run.mp4' } — bytes, never a base64 string",
  );
  assert(
    typeof contentType === 'string' && contentType !== '' && !hasControl(contentType),
    'a download handle() answered a contentType that is empty, not a string, or carries a control character',
    "return { body, contentType: 'video/mp4', filename }",
  );
  assert(
    typeof filename === 'string' && filename !== '' && !hasControl(filename),
    'a download handle() answered a filename that is empty, not a string, or carries a control character',
    "return { body, contentType, filename: 'run.mp4' }",
  );
  assert(
    disposition === undefined || disposition === 'attachment' || disposition === 'inline',
    `a download handle() answered disposition ${String(disposition)}`,
    "disposition: 'attachment' (the default) or 'inline'",
  );
  assert(
    size === undefined || (Number.isSafeInteger(size) && size >= 0),
    `a download handle() answered size ${String(size)}, which is not a whole number of bytes`,
    'size: the stream’s length in bytes — or omit it, and the stream is served whole',
  );
}

/**
 * `attachment; filename="run_1.mp4"; filename*=UTF-8''run%E2%80%931.mp4` — the quoted name ASCII
 * with every other character `_` (a quote or a backslash would end it), the starred one exact.
 */
export function contentDisposition(file: DownloadFile): string {
  const ascii = file.filename.replace(/[^\u0020-\u007e]|["\\]/g, '_');
  const exact = encodeURIComponent(file.filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${file.disposition ?? 'attachment'}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/** The body's length when it can be known without reading it. */
function sizeOf(file: DownloadFile): number | undefined {
  if (file.body instanceof Uint8Array) return file.body.byteLength;
  if (file.body instanceof Blob) return file.body.size;
  return file.size;
}

/**
 * A view `Response` accepts. A `Uint8Array` over a `SharedArrayBuffer` is not a body, so only that
 * case is copied; every other view is re-wrapped over its own buffer, no byte moved.
 */
function bytesBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
    : bytes.slice();
}

function bodyOf(file: DownloadFile, range?: RequestedRange): BodyInit {
  const { body } = file;
  if (body instanceof Uint8Array) {
    const whole = bytesBody(body);
    return range === undefined ? whole : whole.subarray(range.start, range.end + 1);
  }
  if (body instanceof Blob) {
    return range === undefined ? body : body.slice(range.start, range.end + 1);
  }
  return range === undefined ? body : byteWindow(body, range);
}

/** Status, headers and body for one file and the request's `Range:`, if it named one we serve. */
export function fileResponse(file: DownloadFile, rangeHeader: string | null): Response {
  assertFile(file);
  const headers = new Headers({
    'content-type': file.contentType,
    'content-disposition': contentDisposition(file),
    'x-content-type-options': 'nosniff',
    // A browser that renders it anyway gets an opaque origin, no script and no cookies — so a
    // file navigated to loads nothing that could carry this capability URL off in a `Referer`.
    'content-security-policy': 'sandbox',
  });
  const size = sizeOf(file);
  if (size === undefined) {
    headers.set('accept-ranges', 'none');
    return new Response(bodyOf(file), { headers });
  }
  headers.set('accept-ranges', 'bytes');
  const range = parseByteRange(rangeHeader, size);
  if (range === RANGE_UNSATISFIABLE) {
    if (file.body instanceof ReadableStream) void file.body.cancel().catch(() => undefined);
    headers.set('content-range', `bytes */${String(size)}`);
    return new Response(null, { status: 416, headers });
  }
  if (range === undefined) {
    headers.set('content-length', String(size));
    return new Response(bodyOf(file), { headers });
  }
  headers.set('content-range', contentRangeOf(range, size));
  headers.set('content-length', String(range.end - range.start + 1));
  return new Response(bodyOf(file, range), { status: 206, headers });
}
