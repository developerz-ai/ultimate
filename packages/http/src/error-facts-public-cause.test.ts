// Single responsibility: which 5xx documents may show their `cause`. Only codes with NO status row
// were blanked, and `X_DB_STATEMENT_FAILED` has one (500) — so a production 500 body carried the
// Postgres message and the SQL statement to whoever made the request.

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { toProblem } from './error-facts';
import { registerErrorStatus, resetErrorStatus } from './error-status';
import { registerProblemMeta, resetProblemMeta } from './problem-meta';

afterEach(() => {
  resetErrorStatus();
  resetProblemMeta();
});

const LEAK =
  '[SQLSTATE 42703] column "password_hash" does not exist — statement: select * from x_users';

const coded = (code: string, cause: string) =>
  new UltimateError({ code, cause, fix: 'x db migrate' });

describe('a 5xx shows its cause only when the code says it is public', () => {
  test('X_DB_STATEMENT_FAILED hides the server message and the statement', () => {
    const doc = toProblem(coded('X_DB_STATEMENT_FAILED', LEAK), { requestId: 'req-1' });
    expect(doc.status).toBe(500);
    expect(JSON.stringify(doc)).not.toContain('password_hash');
    expect(JSON.stringify(doc)).not.toContain('select * from');
    // Still addressable: the code and the request id are what an operator greps for.
    expect(doc.code).toBe('X_DB_STATEMENT_FAILED');
    expect(doc.requestId).toBe('req-1');
  });

  test.each(['X_DRAINING', 'X_OVERLOADED', 'X_FLIGHT_GATE_OVERLOADED', 'X_TIMEOUT'])(
    '%s keeps its cause — the instruction is the point of it',
    (code) => {
      const doc = toProblem(coded(code, 'retry in a second, this node is draining'));
      expect(doc.cause).toBe('retry in a second, this node is draining');
      expect(doc.detail).toBe('retry in a second, this node is draining');
    },
  );

  test('an app 5xx is hidden until the app opts it in', () => {
    registerErrorStatus({ X_APP_UPSTREAM_DOWN: 502 });
    const hidden = toProblem(coded('X_APP_UPSTREAM_DOWN', 'billing at 10.0.0.4 refused'));
    expect(JSON.stringify(hidden)).not.toContain('10.0.0.4');

    registerProblemMeta({ X_APP_UPSTREAM_DOWN: { publicCause: true } });
    const shown = toProblem(coded('X_APP_UPSTREAM_DOWN', 'billing is down, retry later'));
    expect(shown.cause).toBe('billing is down, retry later');
  });

  test('dev still shows everything, and a 4xx is untouched', () => {
    expect(toProblem(coded('X_DB_STATEMENT_FAILED', LEAK), { dev: true }).cause).toBe(LEAK);
    expect(toProblem(coded('X_FORBIDDEN', 'posts:write is not granted')).cause).toBe(
      'posts:write is not granted',
    );
  });

  test('a framework code cannot be opted in by an app', () => {
    expect(() => registerProblemMeta({ X_DB_STATEMENT_FAILED: { publicCause: true } })).toThrow();
  });
});
