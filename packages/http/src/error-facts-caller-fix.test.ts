// A problem document's `fix` is for the CALLER outside dev: an error that declares a `callerFix`
// (a 403 whose `fix` is `x policy explain`) sends it; the developer's fix stays in dev and in the
// terminal lines. Split from `error-facts.test.ts` for the size ceiling.
import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { factsOf, renderErrorLines, toProblem } from './error-facts';
import { forbidden } from './errors';

describe('callerFix on the wire', () => {
  test('production sends the caller fix; dev and the terminal keep the developer fix', () => {
    const denied = forbidden('/settings', 'not the member', 'member:self');
    expect(toProblem(denied).fix).toContain('ask the account owner or an administrator');
    expect(toProblem(denied, { dev: true }).fix).toContain('x policy explain member:self');
    expect(renderErrorLines(denied)).toContain('x policy explain member:self');
  });

  test('an error with no callerFix sends its fix everywhere', () => {
    const plain = new UltimateError({ code: 'X_INPUT_INVALID', cause: 'c', fix: 'resend it' });
    expect(toProblem(plain).fix).toBe('resend it');
  });

  test("a foreign object's callerFix is remote text and is never carried", () => {
    expect(factsOf({ code: 'X_FORBIDDEN', cause: 'c', callerFix: 'rm -rf /' }).callerFix).toBe(
      undefined,
    );
  });

  test("an app error's docs uri reaches the problem document", () => {
    const error = new UltimateError({
      code: 'X_FORBIDDEN',
      cause: 'c',
      fix: 'f',
      docs: 'docs://recipes/request-access',
    });
    expect(toProblem(error).docs).toBe('docs://recipes/request-access');
  });
});
