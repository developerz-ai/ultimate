// `parseBunTest` reads a coded throw as the failure's message: bun prints an uncaught
// `UltimateError` subclass as `DbError: X_CODE: cause`, never as `error: …`, and `tests.run`
// answered "no error message in the run output" for every one of them.

import { expect, test } from 'bun:test';
import { parseBunTest } from './mcp-test-output';

const RUN = `bun test v1.4.4

packages/mcp/src/tenant.contract.test.ts:
229 | export const dbUnavailable = (detail: string, sourceError?: unknown): DbError =>
230 |   new DbError({
        ^
DbError: X_DB_UNAVAILABLE: cannot reach the database — DATABASE_URL is not set
      title: "cannot reach the database",
       code: "X_DB_UNAVAILABLE"

      at dbUnavailable (/repo/packages/db/src/errors.ts:230:3)
(fail) one token drives Acme then Tinta [8.79ms]

 0 pass
 1 fail
Ran 1 test across 1 file. [10.00ms]`;

test('a coded error line is the failure’s message, code first', () => {
  expect(parseBunTest(RUN, 10).failures).toEqual([
    {
      test: 'one token drives Acme then Tinta',
      message: 'X_DB_UNAVAILABLE: cannot reach the database — DATABASE_URL is not set',
    },
  ]);
});

test('bun’s own error: line still reads as before', () => {
  const run = 'error: expect(received).toBe(expected)\n(fail) adds\n 0 pass\n 1 fail\n';
  expect(parseBunTest(run, 1).failures).toEqual([
    { test: 'adds', message: 'expect(received).toBe(expected)' },
  ]);
});

test('a source line that merely mentions an Error type is not a message', () => {
  const run = '229 | const e = new DbError({ code: "X_DB" });\n(fail) quiet\n 0 pass\n 1 fail\n';
  expect(parseBunTest(run, 1).failures).toEqual([
    { test: 'quiet', message: 'no error message in the run output' },
  ]);
});
