// The transport ceiling: the most bytes this process reads in one request, for any route. Bun's
// own `maxRequestBodySize` answered an empty, uncoded 413 before framework code ran, so the
// framework holds the limit instead — refused by declared length in `admit`, and counted on a
// streamed body — and Bun's is lifted out of the way.

import { HttpError } from './errors';

/** Bun's former default, so an app that declares nothing reads exactly what it read before. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 134_217_728;

/** What `Bun.serve` is given: no ceiling of its own. The framework's is `maxRequestBodyBytes`. */
export const BUN_MAX_REQUEST_BODY_SIZE = Number.MAX_SAFE_INTEGER;

export const requestBodyTooLarge = (pathname: string, bytes: number, ceiling: number): HttpError =>
  new HttpError({
    code: 'X_BODY_TOO_LARGE',
    cause: `${pathname} was sent at least ${bytes} bytes and the most this process reads in one request is ${ceiling} (http.maxRequestBodyBytes)`,
    fix: `configureHttp({ maxRequestBodyBytes: ${bytes} })   # in the app's http.ts — or send it in parts: storage's signPart/completeUpload for an upload`,
  });

/** The declared `content-length`, refused when it is already over the ceiling. */
export const assertDeclaredBody = (request: Request, pathname: string, ceiling: number): void => {
  const header = request.headers.get('content-length');
  if (header === null) return;
  const declared = Number.parseInt(header, 10);
  if (Number.isFinite(declared) && declared > ceiling) {
    throw requestBodyTooLarge(pathname, declared, ceiling);
  }
};

/**
 * A body with no declared length, counted: past `ceiling` the stream errors with
 * `X_BODY_TOO_LARGE`, so whoever reads it — the framework's capped reader or a handler's raw
 * `arrayBuffer()` — never holds more. A declared length needs nothing: HTTP framing ends the body
 * there, and `admit` already refused it if it was over.
 */
export const capStreamedBody = (request: Request, ceiling: number): Request => {
  if (request.body === null || request.headers.has('content-length')) return request;
  let total = 0;
  const pathname = new URL(request.url).pathname;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > ceiling) {
          controller.error(requestBodyTooLarge(pathname, total, ceiling));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body: counted, duplex: 'half' } as RequestInit);
};
