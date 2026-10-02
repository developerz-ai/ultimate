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

// A hidden document blanks the cause because the server wrote it. The `fix` is the same author:
// a driver or repo error builds its fix from the statement, the row or the path it failed on, so
// serving it beside a blanked cause put back what the blanking took out.
describe('a hidden 5xx carries no fix off the throwable', () => {
  const leaky = (code: string, callerFix?: string): UltimateError =>
    new UltimateError({
      code,
      cause: 'duplicate key (email)=(ada@example.com)',
      fix: "users.update({ email: 'ada@example.com' }, { email: 'ada+1@example.com' })",
      ...(callerFix === undefined ? {} : { callerFix }),
    });

  test('a classified 5xx with a withheld cause names its code, never the developer fix', () => {
    const document = toProblem(leaky('X_DB_STATEMENT_FAILED'));
    expect(document.status).toBeGreaterThanOrEqual(500);
    expect(document.fix).toBe('x errors explain X_DB_STATEMENT_FAILED --json');
    expect(JSON.stringify(document)).not.toContain('ada@example.com');
  });

  test('an unclassified 5xx does the same, and a code that is not one gets the listing', () => {
    expect(JSON.stringify(toProblem(leaky('X_APP_NOBODY_DECLARED')))).not.toContain('ada@');
    const foreign = toProblem(leaky('X_$(reboot)'));
    expect(foreign.fix).toBe('x errors list --json');
  });

  test('a declared callerFix is the caller’s own line and still goes out', () => {
    const document = toProblem(leaky('X_DB_STATEMENT_FAILED', 'retry in a minute'));
    expect(document.fix).toBe('retry in a minute');
  });

  test('dev keeps the developer fix, and a public-cause 5xx keeps its authored one', () => {
    expect(toProblem(leaky('X_DB_STATEMENT_FAILED'), { dev: true }).fix).toContain('users.update');
    const shed = new UltimateError({
      code: 'X_DRAINING',
      cause: 'stopping',
      fix: 'retry elsewhere',
    });
    expect(toProblem(shed).fix).toBe('retry elsewhere');
  });
});
