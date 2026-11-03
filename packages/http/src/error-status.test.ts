// The app's half of the status table, and a code that is also a name on `Object.prototype`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineError, describeErrorCode, errorCodeSnapshot } from '@ultimat3/core';
import { factsOf, toProblem } from './error-facts';
import {
  declaredStatusFor,
  registerErrorStatus,
  resetErrorStatus,
  statusFor,
} from './error-status';

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
});

// Both tables are object literals, so every name on `Object.prototype` reads as a member of them.
// `ERROR_STATUS['toString']` was a FUNCTION where a status belongs, and `new Response(body, {
// status })` raised `RangeError: The status provided (0) must be 101 or in the range of [200, 599]`
// — inside `recoverWith`'s fallback, the one frame with nothing above it, so `Pipeline.handle`
// REJECTED against its own contract and the socket got whatever the runtime printed. A `code` is a
// string off a throwable this package did not build; an app that throws `{ code: 'toString' }` is
// all it takes. `scripts/error-map.ts` reads the same table through `Object.hasOwn` already.
describe('a code that is also a name on Object.prototype', () => {
  afterEach(resetErrorStatus);

  const INHERITED = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

  test('is an ordinary unmapped code: 500, a string title, and no function anywhere', () => {
    for (const code of INHERITED) {
      expect(statusFor(code), `statusFor(${code})`).toBe(500);
      const facts = factsOf({ code, message: 'x' });
      expect(typeof facts.title, `title for ${code}`).toBe('string');
      expect(typeof facts.status, `status for ${code}`).toBe('number');
      expect(() => new Response(null, { status: facts.status })).not.toThrow();
    }
  });

  test('and the app may declare a status for it, because the framework maps no such code', () => {
    // The refusal read `the framework already maps it to function toString() { [native code] }`,
    // so an app whose own code collided with a prototype name could never register one at all.
    registerErrorStatus({ toString: 401 });
    expect(statusFor('toString')).toBe(401);
  });
});

// `defineError` (core) writes the same app table `registerErrorStatus` does: core may not import
// this package, so the table moved down and both writers meet there. The framework table is still
// read first, which is what keeps a definition from moving a framework code.
describe('a code declared with defineError', () => {
  let restoreCodes: () => void = () => {};
  beforeEach(() => {
    restoreCodes = errorCodeSnapshot();
  });
  afterEach(() => {
    restoreCodes();
    resetErrorStatus();
  });

  test('answers the status it declared', () => {
    defineError({
      code: 'X_HTTP_TEST_POST_NOT_FOUND',
      title: 'no such post',
      status: 404,
      cause: 'no post',
      fix: 'x queries list --json',
    });
    expect(statusFor('X_HTTP_TEST_POST_NOT_FOUND')).toBe(404);
    expect(declaredStatusFor('X_HTTP_TEST_POST_NOT_FOUND')).toBe(404);
    expect(toProblem({ code: 'X_HTTP_TEST_POST_NOT_FOUND' }).status).toBe(404);
  });

  test('cannot declare a framework code at all, so its status cannot move', () => {
    expect(() =>
      defineError({
        code: 'X_FORBIDDEN',
        title: describeErrorCode('X_FORBIDDEN').title,
        status: 200,
        cause: 'c',
        fix: 'x policy explain',
      }),
    ).toThrow('X_ERROR_CODE_DUPLICATE');
    expect(statusFor('X_FORBIDDEN')).toBe(403);
    expect(declaredStatusFor('X_FORBIDDEN')).toBe(403);
  });

  test('and registerErrorStatus disagreeing with it is refused, either way round', () => {
    defineError({ code: 'X_HTTP_TEST_A', title: 'a', status: 404, cause: 'c', fix: 'x verify' });
    expect(() => registerErrorStatus({ X_HTTP_TEST_A: 409 })).toThrow('X_ERROR_STATUS_INVALID');
    registerErrorStatus({ X_HTTP_TEST_A: 404 });
    registerErrorStatus({ X_HTTP_TEST_B: 409 });
    expect(() =>
      defineError({ code: 'X_HTTP_TEST_B', title: 'b', status: 404, cause: 'c', fix: 'x verify' }),
    ).toThrow('X_ERROR_CODE_DUPLICATE');
    expect(statusFor('X_HTTP_TEST_B')).toBe(409);
  });
});
