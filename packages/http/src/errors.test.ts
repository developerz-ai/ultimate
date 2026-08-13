// An error code is stable forever once shipped, and its cause/fix pair is the entire
// interface an agent gets when a request fails. These tests treat that as the contract it is:
// the code list cannot drift from what the docs promise, and no factory may emit a fix line
// that names nothing runnable.
import { describe, expect, test } from 'bun:test';
import {
  bodyInvalid,
  buildSkew,
  errorStatusInvalid,
  finalizeFailed,
  forbidden,
  HTTP_BORROWED_ERROR_CODES,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HTTP_OWNED_ERROR_CODES,
  HttpError,
  methodNotAllowed,
  noRequest,
  pathInvalid,
  pipelineNoResponse,
  rateLimited,
  routeConflict,
  routeNotFound,
  serverNotStarted,
  unauthenticated,
} from './errors';

describe('routeNotFound', () => {
  test('builds a route-not-found error with an actionable fix', () => {
    const error = routeNotFound('GET', '/x');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_ROUTE_NOT_FOUND');
    expect(error.cause).toContain('GET');
    expect(error.cause).toContain('/x');
    expect(error.fix).toBe('x routes list --json   # then: x g route /x');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_ROUTE_NOT_FOUND');
  });
});

describe('pathInvalid', () => {
  test('names the segment that would not decode and how to send it instead', () => {
    const error = pathInvalid('/posts/%ZZ', '%ZZ');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_PATH_INVALID');
    expect(error.cause).toContain('/posts/%ZZ');
    expect(error.cause).toContain('%ZZ');
    expect(error.fix).toContain('encodeURIComponent');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_PATH_INVALID');
  });
});

describe('methodNotAllowed', () => {
  test('cause and fix name the offending method and the allowed ones', () => {
    const error = methodNotAllowed('POST', '/posts', ['GET', 'PUT']);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_METHOD_NOT_ALLOWED');
    expect(error.cause).toContain('/posts');
    expect(error.cause).toContain('GET, PUT');
    expect(error.cause).toContain('POST');
    expect(error.fix).toBe('add a POST route for /posts or call it with GET');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_METHOD_NOT_ALLOWED');
  });

  test('an empty allow list falls back to GET in the fix line', () => {
    const error = methodNotAllowed('DELETE', '/posts', []);
    expect(error.fix).toBe('add a DELETE route for /posts or call it with GET');
  });
});

describe('bodyInvalid', () => {
  test('joins issues into the cause and points at the schema', () => {
    const error = bodyInvalid('/posts', ['title: required', 'body: too long']);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_BODY_INVALID');
    expect(error.cause).toContain('title: required');
    expect(error.cause).toContain('body: too long');
    expect(error.fix).toBe(
      'x schema show /posts --json   # then send a body matching the input schema',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_BODY_INVALID');
  });
});

describe('unauthenticated', () => {
  test('cause names the route, fix is the exact borrowed-code text', () => {
    const error = unauthenticated('/x');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_UNAUTHENTICATED');
    expect(error.cause).toContain('/x');
    expect(error.fix).toBe(
      "send a session cookie or Authorization header, or set meta.auth to 'public'",
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_UNAUTHENTICATED');
  });
});

describe('forbidden', () => {
  test('cause carries the pathname and the denial reason', () => {
    const error = forbidden('/x', 'not the owner');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_FORBIDDEN');
    expect(error.cause).toContain('/x');
    expect(error.cause).toContain('not the owner');
    expect(error.fix).toBe('x policy explain /x --json   # shows which clause denied');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_FORBIDDEN');
  });
});

describe('rateLimited', () => {
  test('cause carries the key and the retry window', () => {
    const error = rateLimited('posts.create|actor:a1', 7);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_RATE_LIMITED');
    expect(error.cause).toContain('posts.create|actor:a1');
    expect(error.cause).toContain('7s');
    expect(error.fix).toBe(
      'retry after the Retry-After header, or raise rateLimit.buckets in app.config.ts',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_RATE_LIMITED');
  });
});

describe('buildSkew', () => {
  test('cause mentions both the client and server build ids', () => {
    const error = buildSkew('abc123', 'def456');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_BUILD_SKEW');
    expect(error.cause).toContain('abc123');
    expect(error.cause).toContain('def456');
    expect(error.fix).toBe(
      'reload the page — the service worker will fetch the new build manifest',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_BUILD_SKEW');
  });
});

describe('serverNotStarted', () => {
  test('cause names the member read before start()', () => {
    const error = serverNotStarted('url()');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_SERVER_NOT_STARTED');
    expect(error.cause).toContain('url()');
    expect(error.fix).toBe('call createServer({ ... }).start() before reading url()');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_SERVER_NOT_STARTED');
  });
});

describe('pipelineNoResponse', () => {
  test('cause names the stage that finished without a response', () => {
    const error = pipelineNoResponse('handler');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_PIPELINE_NO_RESPONSE');
    expect(error.cause).toContain('handler');
    expect(error.fix).toBe(
      'return a Response from the route handler, or a Response from the stage that short-circuits',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_PIPELINE_NO_RESPONSE');
  });
});

describe('finalizeFailed', () => {
  test('cause names the stage and quotes the throw it wrapped', () => {
    const error = finalizeFailed('response', new TypeError('immutable headers'));
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_PIPELINE_FINALIZE_FAILED');
    expect(error.cause).toContain('"response"');
    expect(error.cause).toContain('immutable headers');
    expect(error.fix).toContain('redirect()');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_PIPELINE_FINALIZE_FAILED');
  });

  // A stage may throw anything at all — the cause line has to read as an instruction regardless.
  test('a non-Error throwable is still quoted, not rendered as [object Object]', () => {
    expect(finalizeFailed('cache-headers', 'headers are sealed').cause).toContain(
      'headers are sealed',
    );
  });
});

describe('routeConflict', () => {
  test('cause carries the path and the conflict detail', () => {
    const error = routeConflict('/posts/:id', 'GET /posts/:id already registered');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_ROUTE_CONFLICT');
    expect(error.cause).toContain('/posts/:id');
    expect(error.cause).toContain('GET /posts/:id already registered');
    expect(error.fix).toBe(
      'x routes list --json   # remove or rename one of the two routes at /posts/:id',
    );
    expect(error.docs).toBe('https://ultimate.dev/errors/X_ROUTE_CONFLICT');
  });
});

describe('HttpError', () => {
  test('is an UltimateError-shaped instance carrying code/cause/fix/docs together', () => {
    const error = new HttpError({ code: 'X_ROUTE_NOT_FOUND', cause: 'c', fix: 'f' });
    expect(error).toBeInstanceOf(HttpError);
    expect(error.name).toBe('HttpError');
    expect(error.code).toBe('X_ROUTE_NOT_FOUND');
    expect(error.cause).toBe('c');
    expect(error.fix).toBe('f');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_ROUTE_NOT_FOUND');
  });
});

describe('noRequest', () => {
  test('names the member that was read and where reading it is legal', () => {
    const error = noRequest('setRedirect()');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_NO_REQUEST');
    expect(error.cause).toContain('setRedirect()');
    expect(error.cause).toContain('outside an HTTP request');
    expect(error.fix).toContain('route handler');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_NO_REQUEST');
  });
});

describe('errorStatusInvalid', () => {
  test('carries the refused code and a fix naming the code being mapped', () => {
    const error = errorStatusInvalid('X_UNAUTHENTICATED', 'the framework already maps it to 401');
    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('X_ERROR_STATUS_INVALID');
    expect(error.cause).toContain('X_UNAUTHENTICATED');
    expect(error.cause).toContain('already maps it to 401');
    expect(error.fix).toContain('registerErrorStatus({ X_UNAUTHENTICATED: 422 })');
    expect(error.docs).toBe('https://ultimate.dev/errors/X_ERROR_STATUS_INVALID');
  });
});

/** Widened once: these lists are compared against plain strings, not against the literal union. */
const EVERY_CODE: readonly string[] = HTTP_ERROR_CODES;
const OWNED_CODES: readonly string[] = HTTP_OWNED_ERROR_CODES;
const BORROWED_CODES: readonly string[] = HTTP_BORROWED_ERROR_CODES;

describe('HTTP_ERROR_CODES', () => {
  test('contains exactly the 14 documented codes', () => {
    expect(HTTP_ERROR_CODES.length).toBe(14);
    expect([...EVERY_CODE].sort()).toEqual(
      [
        'X_ROUTE_NOT_FOUND',
        'X_METHOD_NOT_ALLOWED',
        'X_PATH_INVALID',
        'X_BODY_INVALID',
        'X_UNAUTHENTICATED',
        'X_FORBIDDEN',
        'X_RATE_LIMITED',
        'X_BUILD_SKEW',
        'X_ROUTE_CONFLICT',
        'X_SERVER_NOT_STARTED',
        'X_PIPELINE_NO_RESPONSE',
        'X_PIPELINE_FINALIZE_FAILED',
        'X_NO_REQUEST',
        'X_ERROR_STATUS_INVALID',
      ].sort(),
    );
  });
});

describe('HTTP_BORROWED_ERROR_CODES', () => {
  test('is exactly the two codes owned by other packages', () => {
    expect([...BORROWED_CODES]).toEqual(['X_UNAUTHENTICATED', 'X_FORBIDDEN']);
  });

  test('owned and borrowed are disjoint and together are every code http throws', () => {
    const owned = new Set(OWNED_CODES);
    for (const code of BORROWED_CODES) expect(owned.has(code)).toBe(false);
    expect([...EVERY_CODE].sort()).toEqual([...OWNED_CODES, ...BORROWED_CODES].sort());
  });
});

describe('HTTP_ERROR_TITLES', () => {
  test('every OWNED code has a non-empty title', () => {
    for (const code of HTTP_OWNED_ERROR_CODES) {
      const title = HTTP_ERROR_TITLES[code];
      expect(typeof title).toBe('string');
      expect(title.length).toBeGreaterThan(0);
    }
  });

  // `X_UNAUTHENTICATED` is auth's and `X_FORBIDDEN` is policy's. A copy of their titles here is a
  // copy that goes stale the day the owner edits theirs, with nothing to fail — so there is none.
  test('carries no title for a borrowed code; the owner registers the only one', () => {
    expect(Object.keys(HTTP_ERROR_TITLES).sort()).toEqual([...OWNED_CODES].sort());
  });
});
