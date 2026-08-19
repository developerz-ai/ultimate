import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_ERROR_RETRY,
  declaredErrorRetry,
  isErrorRetry,
  registerErrorRetry,
  registeredErrorRetry,
  resetErrorRetry,
  retryFor,
} from './error-retry';
import { errorRetry, isUltimateError, UltimateError } from './errors';

afterEach(() => {
  resetErrorRetry();
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : 'not-ultimate';
  }
  return 'no-throw';
};

describe('registerErrorRetry', () => {
  test('refuses to reclassify a framework code', () => {
    expect(codeOf(() => registerErrorRetry({ X_DRAINING: 'terminal' }))).toBe(
      'X_ERROR_RETRY_INVALID',
    );
    expect(retryFor('X_DRAINING')).toBe('retryable');
  });

  test('refuses a second, different classification for the same app code', () => {
    registerErrorRetry({ X_PAYMENT_GATEWAY_DOWN: 'retryable' });
    expect(codeOf(() => registerErrorRetry({ X_PAYMENT_GATEWAY_DOWN: 'terminal' }))).toBe(
      'X_ERROR_RETRY_INVALID',
    );
  });

  test('refuses a value that is not a classification', () => {
    expect(
      codeOf(() =>
        registerErrorRetry({ X_WEIRD: 'maybe' } as unknown as Record<string, 'terminal'>),
      ),
    ).toBe('X_ERROR_RETRY_INVALID');
  });

  test('re-registering the same value is idempotent — a module imported twice is not a bug', () => {
    registerErrorRetry({ X_RATE_LIMITED: 'retry-after' });
    registerErrorRetry({ X_RATE_LIMITED: 'retry-after' });
    expect(retryFor('X_RATE_LIMITED')).toBe('retry-after');
  });

  test('lists what the app declared, sorted', () => {
    registerErrorRetry({ X_ZED: 'retryable', X_ALPHA: 'terminal' });
    expect(Object.keys(registeredErrorRetry())).toEqual(['X_ALPHA', 'X_ZED']);
  });
});

describe('retryFor', () => {
  test('an unclassified code is terminal — fail closed', () => {
    expect(retryFor('X_SOMETHING_NOBODY_CLASSIFIED')).toBe('terminal');
    expect(DEFAULT_ERROR_RETRY).toBe('terminal');
  });
});

describe('UltimateError.retry', () => {
  test('a config fault a client must never hammer defaults to terminal', () => {
    const error = new UltimateError({ code: 'X_DB_DRIFT', cause: 'c', fix: 'f' });
    expect(error.retry).toBe('terminal');
    expect(error.toJSON().retry).toBe('terminal');
  });

  test('takes the registered classification for its code', () => {
    registerErrorRetry({ X_OAUTH_EXCHANGE_FAILED: 'retryable' });
    expect(new UltimateError({ code: 'X_OAUTH_EXCHANGE_FAILED', cause: 'c', fix: 'f' }).retry).toBe(
      'retryable',
    );
  });

  test('an explicit init wins — one code can be transient at one call site', () => {
    const error = new UltimateError({
      code: 'X_INTERNAL',
      cause: 'c',
      fix: 'f',
      retry: 'retry-after',
    });
    expect(error.retry).toBe('retry-after');
  });
});

describe('errorRetry', () => {
  test('a bare thrown value is terminal', () => {
    expect(errorRetry(new Error('boom'))).toBe('terminal');
    expect(errorRetry('boom')).toBe('terminal');
  });

  test('reads an Ultimate error through the brand', () => {
    registerErrorRetry({ X_UPSTREAM_TIMEOUT: 'retryable' });
    expect(
      errorRetry(new UltimateError({ code: 'X_UPSTREAM_TIMEOUT', cause: 'c', fix: 'f' })),
    ).toBe('retryable');
  });
});

describe('isErrorRetry', () => {
  test('narrows only the three kinds', () => {
    expect(isErrorRetry('retry-after')).toBe(true);
    expect(isErrorRetry('sometimes')).toBe(false);
    expect(isErrorRetry(undefined)).toBe(false);
  });
});

describe('X_NOT_IMPLEMENTED', () => {
  test('is DECLARED terminal, not merely defaulted to it', () => {
    // The distinction is the whole fix. `classifyThrown` reads an UNREGISTERED code carrying
    // `terminal` as unclassified — a per-instance `terminal` is indistinguishable from the
    // default, and honouring it would dead-letter the first attempt of every job in every app
    // whose codes nobody has classified. So `retryFor` answering `terminal` is not enough;
    // `declaredErrorRetry` has to answer it too, or a job burns its whole retry policy on a
    // feature this build will still not have on attempt five.
    expect(declaredErrorRetry('X_NOT_IMPLEMENTED')).toBe('terminal');
    expect(retryFor('X_NOT_IMPLEMENTED')).toBe('terminal');
  });

  test('an unclassified code is still undeclared, so the distinction is real', () => {
    expect(retryFor('X_MADE_UP_CODE')).toBe('terminal');
    expect(declaredErrorRetry('X_MADE_UP_CODE')).toBeUndefined();
  });

  test('a package may not reclassify it — core owns the code', () => {
    expect(codeOf(() => registerErrorRetry({ X_NOT_IMPLEMENTED: 'retryable' }))).toBe(
      'X_ERROR_RETRY_INVALID',
    );
  });
});

describe('X_TIMEOUT', () => {
  test('a deadline that expired is retryable — a client that gave up on it was the bug', () => {
    expect(retryFor('X_TIMEOUT')).toBe('retryable');
    expect(new UltimateError({ code: 'X_TIMEOUT', cause: 'c', fix: 'f' }).retry).toBe('retryable');
  });

  test('is retryable, NOT retry-after: a timeout produced no time to honour', () => {
    expect(retryFor('X_TIMEOUT')).not.toBe('retry-after');
  });

  test('its twin X_ABORTED is terminal — the caller is gone, nobody wants the answer', () => {
    expect(retryFor('X_ABORTED')).toBe('terminal');
  });

  test('core owns the classification, so no package can move it', () => {
    expect(codeOf(() => registerErrorRetry({ X_TIMEOUT: 'terminal' }))).toBe(
      'X_ERROR_RETRY_INVALID',
    );
  });

  test('an Object.prototype key is unclassified, never Object itself', () => {
    // `CORE_ERROR_RETRY[code]` reached the prototype chain, so `retryFor('constructor')` answered
    // the `Object` FUNCTION through an `ErrorRetry` return type — and `UltimateError`'s
    // constructor calls `retryFor` unconditionally, so the function landed in `.retry` and in
    // `toJSON().retry`.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(retryFor(key)).toBe('terminal');
      expect(declaredErrorRetry(key)).toBeUndefined();
    }
    const error = new UltimateError({ code: 'constructor', cause: 'c', fix: 'f' });
    expect(error.retry).toBe('terminal');
    expect(JSON.parse(JSON.stringify(error.toJSON())).retry).toBe('terminal');
  });

  test('renders a real title, not the humanised fallback', () => {
    const error = new UltimateError({ code: 'X_TIMEOUT', cause: 'c', fix: 'f' });
    expect(error.title).toBe('operation exceeded its deadline');
    expect(error.title).not.toBe('timeout');
  });
});
