// The two members of a problem document that answer "what kind of failure is this?" and "where do
// I read about it?" — and the reason they are no longer the same string. Split out of
// `error-map.test.ts`, which is at the 500-line ceiling `x verify`'s `filesize` step enforces.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { problemTypeFor, toProblem } from './error-facts';
import { bodyInvalid, forbidden, routeNotFound } from './errors';

/**
 * The half of the 9.x docs purge this package could get wrong in the other direction. `docs` was
 * `https://ultimate.dev/errors/<code>` and `type` was the SAME string, so every problem document
 * an app has ever served carried the dead link twice. `docs` is now core's one page — but `type`
 * is RFC 9457's primary identifier for the problem KIND, so collapsing it onto that page too
 * would have given a 422 and a 403 the same identifier, which is the one thing a `type` may not
 * do. Two members, two jobs, and neither may name a host that answers 404.
 */
describe("the problem document's type and docs are different questions", () => {
  test('type discriminates by code; docs is one page for every code', () => {
    const invalid = toProblem(bodyInvalid('/posts', ['title: required']));
    const denied = toProblem(forbidden('/posts/1', 'not an owner'));

    expect(invalid.type).toBe(problemTypeFor('X_BODY_INVALID'));
    expect(denied.type).toBe(problemTypeFor('X_FORBIDDEN'));
    expect(invalid.type).not.toBe(denied.type);

    expect(invalid.docs).toBe(ERROR_DOCS_URL);
    expect(denied.docs).toBe(ERROR_DOCS_URL);
    expect(invalid.docs).toBe(denied.docs);
  });

  test('neither member carries the host that answers 404', () => {
    // A throwable the framework did not build takes `factsOf`'s FALLBACK branch, which is the one
    // that spelled the dead URL out; an `UltimateError` resolved its own `docs` at construction.
    for (const document of [
      toProblem(routeNotFound('GET', '/missing')),
      toProblem(new TypeError('x is not a function')),
    ]) {
      expect(document.docs).toBe(ERROR_DOCS_URL);
      expect(document.type).not.toContain('ultimate.dev');
      expect(document.docs).not.toContain('ultimate.dev');
      // No per-code fragment either: a code lives in a table row, which has no anchor.
      expect(document.docs).not.toContain(document.code);
    }
  });

  test('a code a caller chose cannot smuggle a newline into the type', () => {
    // `code` comes off a throwable this package did not build, and `type` is rendered into a JSON
    // body and into logs. `singleLine` is the same escape `UltimateError`'s constructor applies.
    expect(problemTypeFor('X_A\nB')).toBe(String.raw`urn:ultimate:error:X_A\nB`);
    expect(problemTypeFor('X_A\nB')).not.toContain('\n');
  });
});
