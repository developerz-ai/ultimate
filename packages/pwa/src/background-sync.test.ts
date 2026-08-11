// The emitted background-sync block is code nobody type-checks: it leaves this package as a
// string and is next parsed by a browser. So these tests read it the way the browser will —
// parsing and running the class it defines — rather than trusting that it was spelled right.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode } from '@ultimat3/core';
import {
  backgroundSyncSource,
  DEFAULT_FLUSH_ENDPOINT,
  DEFAULT_RETRY,
  retryDelayMs,
  SYNC_TAG,
  shouldRetry,
} from './background-sync';
import { PwaSyncFlushFailedError, PwaSyncIncompleteError } from './errors';

/** The fields the emitted class promises — the same four `UltimateError` exposes, plus `message`. */
interface EmittedSyncError {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly message: string;
}

/**
 * The emitted block, evaluated the way a browser evaluates `sw.js`: `self` and `BUILD_ID` are the
 * two globals the service-worker realm supplies. Constructing the error is the only proof the
 * emitted class works — a substring assertion passes just as happily on source that throws a
 * `SyntaxError` on the first byte the browser reads.
 */
function emittedError(code: string): EmittedSyncError {
  const build = new Function(
    'self',
    'BUILD_ID',
    `${backgroundSyncSource()}
return new PwaSyncError(${JSON.stringify(code)},'the flush endpoint said no','run the fix command');`,
  );
  return build({ addEventListener: () => undefined }, 'build-1') as EmittedSyncError;
}

describe('backgroundSyncSource', () => {
  test('throws no bare Error — every failure in the generated realm is coded', () => {
    const source = backgroundSyncSource();

    expect(source).not.toContain('new Error(');
    expect([...source.matchAll(/throw new (\w+)\(/g)].map((match) => match[1])).toEqual([
      'PwaSyncError',
      'PwaSyncError',
    ]);
  });

  test('each failure throws the code errors.ts declares for it', () => {
    const source = backgroundSyncSource();

    const thrownWith = (code: string): string => `throw new PwaSyncError(${JSON.stringify(code)}`;
    expect(source).toContain(thrownWith(PwaSyncFlushFailedError.code));
    expect(source).toContain(thrownWith(PwaSyncIncompleteError.code));
  });

  test('each failure carries a fix an operator can run, not advice', () => {
    const source = backgroundSyncSource();

    // A rejected flush is reproducible against the endpoint the SW just called.
    expect(source).toContain("'curl -i -X POST '+FLUSH_ENDPOINT");
    // A partial flush is the outbox worker's business, or the retry ceiling's.
    expect(source).toContain('x dev --role sync');
    expect(source).toContain('pwa.backgroundSync.retry.maxAttempts in app.config.ts');
  });

  test('the emitted class exposes code, cause, fix and docs, like every other Ultimate error', () => {
    const error = emittedError(PwaSyncFlushFailedError.code);

    expect(error.code).toBe(PwaSyncFlushFailedError.code);
    expect(error.cause).toBe('the flush endpoint said no');
    expect(error.fix).toBe('run the fix command');
    // The docs host the SW builds its URL from is the one the registry declares here.
    expect(error.docs).toBe(describeErrorCode(PwaSyncFlushFailedError.code).docs);
  });

  test('the message alone still instructs — an uncaught waitUntil rejection prints nothing else', () => {
    const message = emittedError(PwaSyncIncompleteError.code).message;

    expect(message).toContain(PwaSyncIncompleteError.code);
    expect(message).toContain('the flush endpoint said no');
    expect(message).toContain('fix:   run the fix command');
    expect(message).toContain(describeErrorCode(PwaSyncIncompleteError.code).docs);
  });

  test('the handler is keyed on this package own sync tag and the configured endpoint', () => {
    const source = backgroundSyncSource({ flushEndpoint: '/custom/flush' });

    expect(source).toContain(`const SYNC_TAG="${SYNC_TAG}"`);
    expect(source).toContain('const FLUSH_ENDPOINT="/custom/flush"');
    expect(source).not.toContain(DEFAULT_FLUSH_ENDPOINT);
    expect(source).toContain("addEventListener('sync'");
  });

  test('is deterministic for identical input', () => {
    expect(backgroundSyncSource()).toBe(backgroundSyncSource());
    expect(backgroundSyncSource()).not.toContain('Date.now()');
  });
});

describe('retryDelayMs', () => {
  test('doubles per attempt and stops at the ceiling', () => {
    expect(retryDelayMs(1)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(retryDelayMs(3)).toBe(DEFAULT_RETRY.baseDelayMs * 4);
    expect(retryDelayMs(DEFAULT_RETRY.maxAttempts)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });

  test('an attempt below one or past the ceiling is clamped, never negative or unbounded', () => {
    expect(retryDelayMs(0)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(retryDelayMs(99)).toBe(retryDelayMs(DEFAULT_RETRY.maxAttempts));
  });
});

describe('shouldRetry', () => {
  test('stops at the attempt ceiling', () => {
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts - 1)).toBe(true);
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts)).toBe(false);
  });
});
