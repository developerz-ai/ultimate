// The app's half of the status table: the last line behind both writers, and the snapshot seam a
// test file restores so it never strips rows another file's modules declared at import.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appErrorStatus,
  appErrorStatusSnapshot,
  declareAppErrorStatus,
  isHttpStatus,
  resetAppErrorStatus,
} from './error-status-declared';
import { isUltimateError } from './errors';
import * as barrel from './index';

let restore: () => void = () => {};
beforeEach(() => {
  restore = appErrorStatusSnapshot();
});
afterEach(() => restore());

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('the row was accepted');
};

describe('unit · the app status table', () => {
  test('a row reads back, and the same row twice is a no-op', () => {
    declareAppErrorStatus('X_TABLE_TEST_A', 404);
    declareAppErrorStatus('X_TABLE_TEST_A', 404);
    expect(appErrorStatus('X_TABLE_TEST_A')).toBe(404);
    expect(appErrorStatus('X_TABLE_TEST_NONE')).toBeUndefined();
  });

  test('a name on Object.prototype is an ordinary key', () => {
    expect(appErrorStatus('toString')).toBeUndefined();
    declareAppErrorStatus('toString', 401);
    expect(appErrorStatus('toString')).toBe(401);
  });

  test('a second, different status is refused and the first stands', () => {
    declareAppErrorStatus('X_TABLE_TEST_B', 404);
    const error = refusal(() => declareAppErrorStatus('X_TABLE_TEST_B', 409));
    expect(error.code).toBe('X_ERROR_DECLARATION_INVALID');
    expect(error.cause).toContain('already declared it as 404');
    expect(appErrorStatus('X_TABLE_TEST_B')).toBe(404);
  });

  test('a status a Response cannot carry is refused', () => {
    for (const status of [99, 600, 404.5, Number.NaN]) {
      expect(refusal(() => declareAppErrorStatus('X_TABLE_TEST_C', status)).code).toBe(
        'X_ERROR_DECLARATION_INVALID',
      );
    }
    expect(appErrorStatus('X_TABLE_TEST_C')).toBeUndefined();
    expect(isHttpStatus(100)).toBe(true);
    expect(isHttpStatus(599)).toBe(true);
    expect(isHttpStatus('404')).toBe(false);
  });

  test('a code a shell would read never reaches the fix verbatim', () => {
    const error = refusal(() => declareAppErrorStatus('$(rm -rf ~)', 99));
    expect(error.fix).toContain('<CODE>');
    expect(error.fix).not.toContain('$(');
  });

  test('the snapshot restores what a reset took', () => {
    declareAppErrorStatus('X_TABLE_TEST_D', 410);
    const undo = appErrorStatusSnapshot();
    resetAppErrorStatus();
    expect(appErrorStatus('X_TABLE_TEST_D')).toBeUndefined();
    undo();
    expect(appErrorStatus('X_TABLE_TEST_D')).toBe(410);
  });
  // One public writer per question: an app declares through defineError, a re-raised library
  // code through http's registerErrorStatus. The table's own seams are internal, and
  // `appErrorStatus` was a public export once already, deleted (wiki/Upgrading.md).
  test('none of the table’s seams is on the barrel; the internal subpath carries them', async () => {
    for (const name of [
      'appErrorStatus',
      'appErrorStatusSnapshot',
      'declareAppErrorStatus',
      'resetAppErrorStatus',
    ]) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
    const internal = await import('@ultimat3/core/internal/error-status');
    expect(internal.appErrorStatus).toBe(appErrorStatus);
  });
});
