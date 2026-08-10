import { describe, expect, test } from 'bun:test';
import {
  bodyInvalid,
  buildSkew,
  forbidden,
  HTTP_BORROWED_CODES,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HttpError,
  methodNotAllowed,
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

describe('HTTP_ERROR_CODES', () => {
  test('contains exactly the 10 documented codes', () => {
    expect(HTTP_ERROR_CODES.length).toBe(10);
    expect(HTTP_ERROR_CODES.includes('X_ROUTE_NOT_FOUND')).toBe(true);
    expect(HTTP_ERROR_CODES.includes('X_BUILD_SKEW')).toBe(true);
    expect(HTTP_ERROR_CODES.includes('X_METHOD_NOT_ALLOWED')).toBe(true);
    expect(HTTP_ERROR_CODES.includes('X_ROUTE_CONFLICT')).toBe(true);
    expect(HTTP_ERROR_CODES).toEqual([
      'X_ROUTE_NOT_FOUND',
      'X_METHOD_NOT_ALLOWED',
      'X_BODY_INVALID',
      'X_UNAUTHENTICATED',
      'X_FORBIDDEN',
      'X_RATE_LIMITED',
      'X_BUILD_SKEW',
      'X_ROUTE_CONFLICT',
      'X_SERVER_NOT_STARTED',
      'X_PIPELINE_NO_RESPONSE',
    ]);
  });
});

describe('HTTP_BORROWED_CODES', () => {
  test('is exactly the two codes owned by other packages', () => {
    expect(HTTP_BORROWED_CODES).toEqual(['X_UNAUTHENTICATED', 'X_FORBIDDEN']);
  });
});

describe('HTTP_ERROR_TITLES', () => {
  test('every documented code has a non-empty title', () => {
    for (const code of HTTP_ERROR_CODES) {
      const title = HTTP_ERROR_TITLES[code];
      expect(typeof title).toBe('string');
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
