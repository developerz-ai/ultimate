import { afterEach, describe, expect, test } from 'bun:test';
import {
  appErrorStatus,
  ERROR_STATUS,
  factsOf,
  registerErrorStatus,
  renderErrorLines,
  resetErrorStatus,
  statusFor,
  toProblem,
} from './error-map';
import { bodyInvalid, forbidden, HTTP_ERROR_CODES, rateLimited, routeNotFound } from './errors';

describe('error -> status', () => {
  test('every code this package can throw has a row', () => {
    for (const code of HTTP_ERROR_CODES) {
      expect(ERROR_STATUS[code], `missing status row for ${code}`).toBeNumber();
    }
  });

  test('maps the codes callers depend on', () => {
    expect(statusFor('X_ROUTE_NOT_FOUND')).toBe(404);
    expect(statusFor('X_METHOD_NOT_ALLOWED')).toBe(405);
    expect(statusFor('X_BODY_INVALID')).toBe(422);
    expect(statusFor('X_UNAUTHENTICATED')).toBe(401);
    expect(statusFor('X_FORBIDDEN')).toBe(403);
    expect(statusFor('X_RATE_LIMITED')).toBe(429);
    expect(statusFor('X_BUILD_SKEW')).toBe(409);
  });

  test('codes owned by other packages are mapped here, not there', () => {
    expect(statusFor('X_NOT_FOUND')).toBe(404);
    expect(statusFor('X_INVARIANT_VIOLATED')).toBe(422);
    expect(statusFor('X_ENTITY_DUPLICATE')).toBe(409);
    expect(statusFor('X_NOT_IMPLEMENTED')).toBe(501);
  });

  // The image routes are the framework's only caller-supplied query string, so both of these are
  // the caller's mistake to fix — a 500 would send an agent hunting a server fault it cannot see.
  test('a bad image transform request blames the caller, not the server', () => {
    expect(statusFor('X_IMAGE_QUERY_INVALID')).toBe(400);
    expect(statusFor('X_IMAGE_UNSUPPORTED')).toBe(415);
  });

  test('an unmapped code is a loud 500, never a quiet 200', () => {
    expect(statusFor('X_SOMETHING_NEW')).toBe(500);
  });
});

// Every app-defined code answered 500, and `pipeline.ts` reports `status >= 500` to the error
// monitor — so a wrong password paged the on-call. The table above is the framework's and stays
// closed; this is the app's half of it.
describe('an app declares the status for its own codes', () => {
  afterEach(resetErrorStatus);

  test('an undeclared app code is still a loud 500', () => {
    expect(statusFor('X_CREDENTIALS_INVALID')).toBe(500);
  });

  test('a declared code answers its declared status', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401, X_SIGNUP_CLOSED: 403 });
    expect(statusFor('X_CREDENTIALS_INVALID')).toBe(401);
    expect(statusFor('X_SIGNUP_CLOSED')).toBe(403);
    expect(factsOf({ code: 'X_CREDENTIALS_INVALID' }).status).toBe(401);
    expect(toProblem({ code: 'X_SIGNUP_CLOSED' }).status).toBe(403);
  });

  test('a code the app never declared keeps defaulting to 500', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 });
    expect(statusFor('X_SOMETHING_ELSE')).toBe(500);
  });

  test('the framework’s own codes are not negotiable', () => {
    expect(() => registerErrorStatus({ X_UNAUTHENTICATED: 200 })).toThrow('X_ERROR_STATUS_INVALID');
    expect(statusFor('X_UNAUTHENTICATED')).toBe(401);
  });

  test('a status outside 100-599 is refused', () => {
    expect(() => registerErrorStatus({ X_WEIRD: 999 })).toThrow('X_ERROR_STATUS_INVALID');
    expect(() => registerErrorStatus({ X_WEIRD: 401.5 })).toThrow('X_ERROR_STATUS_INVALID');
  });

  test('registering the same code twice with a different status is refused', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 });
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 }); // idempotent: a re-import is not a bug
    expect(() => registerErrorStatus({ X_CREDENTIALS_INVALID: 403 })).toThrow(
      'X_ERROR_STATUS_INVALID',
    );
  });

  test('appErrorStatus projects what the app declared, sorted', () => {
    registerErrorStatus({ X_SIGNUP_CLOSED: 403, X_CREDENTIALS_INVALID: 401 });
    expect(Object.keys(appErrorStatus())).toEqual(['X_CREDENTIALS_INVALID', 'X_SIGNUP_CLOSED']);
  });
});

describe('factsOf', () => {
  test('keeps code, cause and fix from an UltimateError', () => {
    const facts = factsOf(routeNotFound('GET', '/missing'));
    expect(facts.code).toBe('X_ROUTE_NOT_FOUND');
    expect(facts.cause).toContain('GET /missing');
    expect(facts.fix).toContain('x routes list');
    expect(facts.status).toBe(404);
    expect(facts.docs).toBe('https://ultimate.dev/errors/X_ROUTE_NOT_FOUND');
  });

  test('titles a borrowed code from its owning package, without repeating the code', () => {
    // `X_FORBIDDEN` is policy's and `X_UNAUTHENTICATED` is auth's, so http holds no title for
    // either. Reading `message` instead once produced `X_FORBIDDEN: policy denied this actor — …`
    // as the *title*, which `renderErrorLines` then printed with the code a second time.
    const facts = factsOf(forbidden('/x', 'not an owner'));
    expect(facts.code).toBe('X_FORBIDDEN');
    expect(facts.title).not.toContain('X_FORBIDDEN');
    expect(facts.title).not.toContain('not an owner');
    expect(renderErrorLines(forbidden('/x', 'not an owner')).split('\n')[0]).toBe(
      `X_FORBIDDEN: ${facts.title}`,
    );
  });

  test('gives a foreign throwable a code and a fix too', () => {
    const facts = factsOf(new TypeError('x is not a function'));
    expect(facts.code).toBe('X_INTERNAL');
    expect(facts.status).toBe(500);
    expect(facts.fix.length).toBeGreaterThan(0);
  });

  test('renders the same three lines the terminal prints', () => {
    const lines = renderErrorLines(rateLimited('actor:1', 30)).split('\n');
    expect(lines[0]).toStartWith('X_RATE_LIMITED:');
    expect(lines[1]?.trim()).toStartWith('cause:');
    expect(lines[2]?.trim()).toStartWith('fix:');
  });
});

describe('toProblem', () => {
  test('is RFC-9457 shaped and carries the framework contract', () => {
    const document = toProblem(bodyInvalid('/posts', ['title: required']), {
      instance: '/posts',
      requestId: 'req-1',
    });
    expect(document.status).toBe(422);
    expect(document.type).toBe('https://ultimate.dev/errors/X_BODY_INVALID');
    expect(document.detail).toContain('title: required');
    expect(document.code).toBe('X_BODY_INVALID');
    expect(document.fix).toContain('x schema show');
    expect(document.instance).toBe('/posts');
    expect(document.requestId).toBe('req-1');
  });

  test('forbidden denials stay safe to log', () => {
    const document = toProblem(forbidden('/posts/1', 'actor does not own post'));
    expect(document.status).toBe(403);
    expect(document.cause).toContain('actor does not own post');
  });
});
