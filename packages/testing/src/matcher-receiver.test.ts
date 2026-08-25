// A matcher that is handed the WRONG KIND of thing must say so with its own code — the assertion
// is not false, it is unanswerable, and `pass: false` would read as "the schema accepted it".
//
// The reason this file exists: measured against Bun 1.4.0, a matcher declared `async` has any error
// it throws REPLACED by bun's own `Matcher \`x\` returned a promise that rejected`. Three of this
// package's matchers threw a coded error from inside an `async` body, so `X_TEST_SCHEMA_EXPECTED`
// and `X_TEST_JOB_EXPECTED` were declared, registered, titled — and unreachable by any caller.
// Nothing asserted them, which is why nobody noticed.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import './matchers';

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return `NOT AN UltimateError: ${error instanceof Error ? error.message : String(error)}`;
  }
  return expect.unreachable('the matcher answered where it could not');
};

describe('a matcher handed the wrong receiver', () => {
  test('toRejectInput names the schema it wanted', async () => {
    expect(await codeOf(() => expect({ not: 'a schema' }).toRejectInput({}))).toBe(
      'X_TEST_SCHEMA_EXPECTED',
    );
  });

  test('toAcceptInput names the schema it wanted', async () => {
    expect(await codeOf(() => expect(42).toAcceptInput({}))).toBe('X_TEST_SCHEMA_EXPECTED');
  });

  test('toEmitSteps names the job it wanted', async () => {
    expect(await codeOf(() => expect({ not: 'a job' }).toEmitSteps([]))).toBe(
      'X_TEST_JOB_EXPECTED',
    );
  });

  test('toBeVisible names the locator it wanted', async () => {
    expect(await codeOf(() => expect('#selector').toBeVisible({ timeout: 0, interval: 1 }))).toBe(
      'X_TEST_LOCATOR_EXPECTED',
    );
  });

  test('every one of them carries a fix a reader can paste', async () => {
    const calls: readonly (() => Promise<unknown>)[] = [
      () => expect({}).toRejectInput({}),
      () => expect({}).toAcceptInput({}),
      () => expect({}).toEmitSteps([]),
      () => expect({}).toBeVisible({ timeout: 0, interval: 1 }),
    ];
    for (const call of calls) {
      try {
        await call();
        expect.unreachable('the matcher answered where it could not');
      } catch (error) {
        expect(error).toBeInstanceOf(UltimateError);
        expect((error as UltimateError).fix.length).toBeGreaterThan(10);
      }
    }
  });
});
