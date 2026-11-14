// `defineError`: one declaration registers a code's title, its status and its retry, and returns
// the class. Each refusal is driven, and the registries are snapshotted so no row leaks to a later
// file in the same bun process.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { definedErrorSites, defineError } from './define-error';
import { describeErrorCode, errorCodeSnapshot, hasErrorCode } from './error-codes';
import { declaredErrorRetry, registeredErrorRetry, resetErrorRetry } from './error-retry';
import {
  appErrorStatus,
  appErrorStatusSnapshot,
  resetAppErrorStatus,
} from './error-status-declared';
import { isUltimateError, UltimateError } from './errors';
import {
  declaredProblemMeta,
  recordProblemMeta,
  resetDeclaredProblemMeta,
} from './problem-meta-declared';
import { hasPublicCause, resetPublicCauses } from './public-cause';

let restoreCodes: () => void = () => {};
let restoreStatus: () => void = () => {};
const retries = registeredErrorRetry();

beforeEach(() => {
  restoreCodes = errorCodeSnapshot();
  restoreStatus = appErrorStatusSnapshot();
});

afterEach(() => {
  restoreCodes();
  restoreStatus();
  resetErrorRetry(retries);
  resetDeclaredProblemMeta();
  resetPublicCauses();
});

const refusal = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('the declaration was accepted');
};

describe('unit · defineError', () => {
  test('one call registers the title and the status, and the class builds its error', () => {
    const NotFound = defineError<{ readonly ref: string }>({
      code: 'X_DEFINE_TEST_NOT_FOUND',
      title: 'the test row does not exist',
      status: 404,
      cause: (p) => `no row ${p.ref}`,
      fix: (p) => `psql "$DATABASE_URL" -c "SELECT id FROM rows WHERE ref = '${p.ref}'"`,
      meta: (p) => ({ ref: p.ref }),
    });
    expect(describeErrorCode('X_DEFINE_TEST_NOT_FOUND').title).toBe('the test row does not exist');
    expect(appErrorStatus('X_DEFINE_TEST_NOT_FOUND')).toBe(404);
    expect(NotFound.code).toBe('X_DEFINE_TEST_NOT_FOUND');
    expect(NotFound.status).toBe(404);

    const error = new NotFound({ ref: 'r-1' });
    expect(error).toBeInstanceOf(UltimateError);
    expect(error).toBeInstanceOf(NotFound);
    expect(error.code).toBe('X_DEFINE_TEST_NOT_FOUND');
    expect(error.title).toBe('the test row does not exist');
    expect(error.cause).toBe('no row r-1');
    expect(error.fix).toContain("ref = 'r-1'");
    expect(error.meta).toEqual({ ref: 'r-1' });
  });

  test('a string cause and fix need no params, and extra carries the source and a retry', () => {
    const Busy = defineError({
      code: 'X_DEFINE_TEST_BUSY',
      title: 'the test resource is busy',
      status: 409,
      cause: 'another writer holds the row',
      fix: 'x jobs list --json',
      callerFix: 'try again in a minute',
      retry: 'retryable',
    });
    const source = new UltimateError({ code: 'X_INTERNAL', cause: 'inner', fix: 'x verify' });
    const error = new Busy(undefined, { sourceError: source, retry: 'terminal' });
    expect(error.cause).toBe('another writer holds the row');
    expect(error.callerFix).toBe('try again in a minute');
    expect(error.sourceError).toBe(source);
    expect(error.retry).toBe('terminal');
    expect(new Busy().retry).toBe('retryable');
    expect(declaredErrorRetry('X_DEFINE_TEST_BUSY')).toBe('retryable');
  });

  test('offSocket declares no status', () => {
    const Boot = defineError({
      code: 'X_DEFINE_TEST_BOOT',
      title: 'the test boot failed',
      offSocket: true,
      cause: 'a boot-time fault',
      fix: 'x doctor --json',
    });
    expect(Boot.status).toBeUndefined();
    expect(appErrorStatus('X_DEFINE_TEST_BOOT')).toBeUndefined();
    expect(hasErrorCode('X_DEFINE_TEST_BOOT')).toBe(true);
  });

  test('is() accepts any Ultimate error with the code and refuses a plain look-alike', () => {
    const Gone = defineError({
      code: 'X_DEFINE_TEST_GONE',
      title: 'the test row is gone',
      status: 410,
      cause: 'deleted',
      fix: 'x verify',
    });
    const elsewhere = new UltimateError({
      code: 'X_DEFINE_TEST_GONE',
      cause: 'c',
      fix: 'x verify',
    });
    expect(Gone.is(elsewhere)).toBe(true);
    expect(Gone.is(new Gone())).toBe(true);
    expect(Gone.is({ code: 'X_DEFINE_TEST_GONE' })).toBe(false);
    expect(Gone.is(new UltimateError({ code: 'X_OTHER', cause: 'c', fix: 'x verify' }))).toBe(
      false,
    );
    expect(Gone.is(undefined)).toBe(false);
  });

  test('the same declaration twice is a no-op, which is a module re-evaluated under x dev', () => {
    const spec = {
      code: 'X_DEFINE_TEST_TWICE',
      title: 'declared twice',
      status: 422,
      cause: 'c',
      fix: 'x verify',
    } as const;
    defineError(spec);
    expect(() => defineError(spec)).not.toThrow();
    expect(appErrorStatus('X_DEFINE_TEST_TWICE')).toBe(422);
  });

  test('a different title or status for one code is X_ERROR_CODE_DUPLICATE, and writes nothing', () => {
    defineError({
      code: 'X_DEFINE_TEST_DUP',
      title: 'one',
      status: 404,
      cause: 'c',
      fix: 'x verify',
    });
    const title = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_DUP',
        title: 'two',
        status: 404,
        cause: 'c',
        fix: 'x verify',
      }),
    );
    expect(title.code).toBe('X_ERROR_CODE_DUPLICATE');
    expect(title.cause).toContain('"one"');
    const status = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_DUP',
        title: 'one',
        status: 409,
        cause: 'c',
        fix: 'x verify',
      }),
    );
    expect(status.code).toBe('X_ERROR_CODE_DUPLICATE');
    expect(status.cause).toContain('404');
    const offSocket = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_DUP',
        title: 'one',
        offSocket: true,
        cause: 'c',
        fix: 'x',
      }),
    );
    expect(offSocket.code).toBe('X_ERROR_CODE_DUPLICATE');
    expect(appErrorStatus('X_DEFINE_TEST_DUP')).toBe(404);

    const fresh = refusal(() =>
      defineError({ code: 'X_DEFINE_TEST_DUP', title: 'one', status: 409, cause: 'c', fix: 'x' }),
    );
    expect(fresh.meta).toEqual({ code: 'X_DEFINE_TEST_DUP' });
  });

  test('a refused status writes no title either', () => {
    defineError({ code: 'X_DEFINE_TEST_HALF', title: 'half', status: 404, cause: 'c', fix: 'x' });
    restoreCodes();
    refusal(() =>
      defineError({ code: 'X_DEFINE_TEST_HALF', title: 'half', status: 409, cause: 'c', fix: 'x' }),
    );
    expect(hasErrorCode('X_DEFINE_TEST_HALF')).toBe(false);
  });

  test('both, or neither, of status and offSocket is X_ERROR_DECLARATION_INVALID', () => {
    const both = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_BOTH',
        title: 't',
        status: 404,
        offSocket: true,
        cause: 'c',
        fix: 'x',
      } as never),
    );
    expect(both.code).toBe('X_ERROR_DECLARATION_INVALID');
    expect(both.cause).toContain('both');
    const neither = refusal(() =>
      defineError({ code: 'X_DEFINE_TEST_NEITHER', title: 't', cause: 'c', fix: 'x' } as never),
    );
    expect(neither.code).toBe('X_ERROR_DECLARATION_INVALID');
    expect(neither.cause).toContain('neither');
    expect(hasErrorCode('X_DEFINE_TEST_BOTH')).toBe(false);
  });

  test('a status outside 100-599, or not an integer, is X_ERROR_DECLARATION_INVALID', () => {
    for (const status of [99, 600, 404.5, Number.NaN]) {
      const error = refusal(() =>
        defineError({ code: 'X_DEFINE_TEST_RANGE', title: 't', status, cause: 'c', fix: 'x' }),
      );
      expect(error.code).toBe('X_ERROR_DECLARATION_INVALID');
    }
    expect(hasErrorCode('X_DEFINE_TEST_RANGE')).toBe(false);
  });

  test('a code that is not X_SCREAMING_SNAKE is X_ERROR_DECLARATION_INVALID', () => {
    for (const code of ['POST_NOT_FOUND', 'X_post_missing', 'X_', 'X_A__B', 'X_A_', 'toString']) {
      const error = refusal(() =>
        defineError({ code, title: 't', status: 404, cause: 'c', fix: 'x' }),
      );
      expect(error.code).toBe('X_ERROR_DECLARATION_INVALID');
    }
  });

  test('an unknown retry kind is refused before anything is written', () => {
    const error = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_RETRY',
        title: 't',
        status: 503,
        cause: 'c',
        fix: 'x',
        retry: 'sometimes' as never,
      }),
    );
    expect(error.code).toBe('X_ERROR_RETRY_INVALID');
    expect(hasErrorCode('X_DEFINE_TEST_RETRY')).toBe(false);
    expect(appErrorStatus('X_DEFINE_TEST_RETRY')).toBeUndefined();
  });
  test('a framework code is refused even under its own title: its status is not the app’s', () => {
    const title = describeErrorCode('X_ERROR_DECLARATION_INVALID').title;
    const error = refusal(() =>
      defineError({
        code: 'X_ERROR_DECLARATION_INVALID',
        title,
        status: 200,
        cause: 'c',
        fix: 'x',
      }),
    );
    expect(error.code).toBe('X_ERROR_CODE_DUPLICATE');
    expect(error.cause).toContain('by the framework');
    expect(appErrorStatus('X_ERROR_DECLARATION_INVALID')).toBeUndefined();
  });

  test('a status that cannot be printed is still a declaration refusal, never a TypeError', () => {
    const status = Object.create(null) as number;
    const error = refusal(() =>
      defineError({ code: 'X_DEFINE_TEST_PROTOLESS', title: 't', status, cause: 'c', fix: 'x' }),
    );
    expect(error.code).toBe('X_ERROR_DECLARATION_INVALID');
  });

  test('a reset forgets what defineError recorded, and a snapshot restores it', () => {
    defineError({ code: 'X_DEFINE_TEST_RESET', title: 'r', status: 404, cause: 'c', fix: 'x' });
    const undo = appErrorStatusSnapshot();
    resetAppErrorStatus();
    restoreCodes();
    restoreCodes = errorCodeSnapshot();
    expect(() =>
      defineError({
        code: 'X_DEFINE_TEST_RESET',
        title: 'r',
        offSocket: true,
        cause: 'c',
        fix: 'x',
      }),
    ).not.toThrow();
    undo();
    expect(appErrorStatus('X_DEFINE_TEST_RESET')).toBe(404);
    expect(
      refusal(() =>
        defineError({ code: 'X_DEFINE_TEST_RESET', title: 'r', status: 409, cause: 'c', fix: 'x' }),
      ).code,
    ).toBe('X_ERROR_CODE_DUPLICATE');
  });
});

// The problem-meta half of the declaration: what was `registerErrorStatus` + `registerProblemMeta`
// beside a hand-written class is now two fields of the one call, refused all-or-nothing.
describe('unit · defineError · problemMeta and publicCause', () => {
  test('one call declares the meta keys a document carries and a public 5xx cause', () => {
    defineError({
      code: 'X_DEFINE_TEST_BUSY',
      title: 'busy',
      status: 409,
      cause: 'c',
      fix: 'x',
      problemMeta: ['sessionId', 'state'],
    });
    expect(declaredProblemMeta('X_DEFINE_TEST_BUSY')).toEqual(['sessionId', 'state']);
    expect(hasPublicCause('X_DEFINE_TEST_BUSY')).toBe(false);
    defineError({
      code: 'X_DEFINE_TEST_UPSTREAM',
      title: 'upstream',
      status: 503,
      cause: 'c',
      fix: 'x',
      publicCause: true,
    });
    expect(hasPublicCause('X_DEFINE_TEST_UPSTREAM')).toBe(true);
    expect(declaredProblemMeta('X_DEFINE_TEST_UPSTREAM')).toBeUndefined();
  });

  test('the same declaration twice, keys included, is still a no-op', () => {
    const spec = {
      code: 'X_DEFINE_TEST_TWICE',
      title: 't',
      status: 409,
      cause: 'c',
      fix: 'x',
      problemMeta: ['id'],
    } as const;
    defineError(spec);
    expect(() => defineError(spec)).not.toThrow();
  });

  const refusedCases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
    ['a key that is not one', { status: 409, problemMeta: ['issues'] }, 'top level'],
    ['an empty key list', { status: 409, problemMeta: [] }, 'the key list is empty'],
    ['keys on an off-socket code', { offSocket: true, problemMeta: ['id'] }, 'offSocket'],
    ['a public cause on an off-socket code', { offSocket: true, publicCause: true }, 'offSocket'],
    ['a public cause on a 4xx', { status: 404, publicCause: true }, '5xx'],
  ];
  for (const [what, extra, says] of refusedCases) {
    test(`${what} is X_ERROR_DECLARATION_INVALID, and writes nothing`, () => {
      const code = 'X_DEFINE_TEST_META_REFUSED';
      const error = refusal(() =>
        defineError({ code, title: 't', cause: 'c', fix: 'x', ...extra } as never),
      );
      expect(error.code).toBe('X_ERROR_DECLARATION_INVALID');
      expect(error.cause).toContain(says);
      expect(hasErrorCode(code)).toBe(false);
      expect(appErrorStatus(code)).toBeUndefined();
      expect(declaredProblemMeta(code)).toBeUndefined();
      expect(hasPublicCause(code)).toBe(false);
    });
  }

  test('keys that disagree with an earlier declaration are refused before the title is written', () => {
    recordProblemMeta('X_DEFINE_TEST_DISAGREE', ['sessionId']);
    const error = refusal(() =>
      defineError({
        code: 'X_DEFINE_TEST_DISAGREE',
        title: 't',
        status: 409,
        cause: 'c',
        fix: 'x',
        problemMeta: ['other'],
      }),
    );
    expect(error.cause).toContain('already declared as [sessionId]');
    expect(hasErrorCode('X_DEFINE_TEST_DISAGREE')).toBe(false);
  });
});

// `recordSite` feeds a test-time source scan; a browser with no `Error.captureStackTrace` (Firefox
// before 136) runs the same declaration at island load and must not die on the bookkeeping.
describe('unit · defineError in an engine without Error.captureStackTrace', () => {
  test('declares the code and records no site', () => {
    const capture = Error.captureStackTrace;
    Reflect.deleteProperty(Error, 'captureStackTrace');
    try {
      const Gone = defineError({
        code: 'X_DEFINE_TEST_NO_CAPTURE',
        title: 'gone',
        status: 410,
        cause: 'c',
        fix: 'x',
      });
      expect(new Gone().code).toBe('X_DEFINE_TEST_NO_CAPTURE');
      expect(definedErrorSites().has('X_DEFINE_TEST_NO_CAPTURE')).toBe(false);
    } finally {
      Error.captureStackTrace = capture;
    }
  });
});
