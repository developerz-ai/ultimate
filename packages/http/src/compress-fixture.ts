// The requests, answers and bodies the `compress` stage's tests share: a cacheable stylesheet, a
// gzip-asking GET, and a body that fails the test if anything pulls it.
import { compressResponse } from './compress';
import { createCompressCache } from './compress-cache';

/**
 * An anonymous caller's answer: `compress-exposure.test.ts` holds the signed-in half. A fresh
 * coded-body cache per call, so no test is answered from another's coding.
 */
export const compressAnonymous = (request: Request, response: Response, signal?: AbortSignal) =>
  compressResponse(request, response, {
    anonymous: true,
    cache: createCompressCache(),
    ...(signal === undefined ? {} : { signal }),
  });

export const SOURCE = 'a { color: var(--text); }\n'.repeat(200);
export const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

export const answer = (
  body: BodyInit | null = SOURCE,
  headers: Record<string, string> = {},
  init: ResponseInit = {},
): Response =>
  new Response(body, {
    ...init,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(bytesOf(SOURCE).byteLength),
      ...headers,
    },
  });

export const asking = (accept: string | null = 'gzip', method = 'GET'): Request =>
  new Request('http://app.test/x', {
    method,
    headers: accept === null ? {} : { 'accept-encoding': accept },
  });

export const decoded = async (response: Response): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())));

/** The body a passed-through answer must never touch: pulling it is the test's failure. */
export const untouchable = (): {
  readonly body: ReadableStream<Uint8Array>;
  pulled: () => boolean;
} => {
  let pulled = false;
  return {
    // A high-water mark of 0: the default of 1 pulls at construction, before anyone has read.
    body: new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    pulled: () => pulled,
  };
};
