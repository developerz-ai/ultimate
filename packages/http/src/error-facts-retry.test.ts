// `retry` on the problem document: the class a client maps to an exception, on every status, with
// nothing about the failure beside it when the document is hidden.
import { describe, expect, test } from 'bun:test';
import { type ErrorRetry, UltimateError } from '@ultimat3/core';
import { toProblem } from './error-facts';
import { rateLimited } from './rate-limit-errors';

describe('retry, the class a client maps to an exception', () => {
  const coded = (code: string, retry?: ErrorRetry): UltimateError =>
    new UltimateError({ code, cause: 'c', fix: 'f', ...(retry === undefined ? {} : { retry }) });

  test('on a 400, a 401, a 404 and a 429, each its own class', () => {
    expect(toProblem(coded('X_PATH_INVALID')).status).toBe(400);
    expect(toProblem(coded('X_PATH_INVALID')).retry).toBe('terminal');
    expect(toProblem(coded('X_UNAUTHENTICATED')).status).toBe(401);
    expect(toProblem(coded('X_UNAUTHENTICATED')).retry).toBe('terminal');
    expect(toProblem(coded('X_ROUTE_NOT_FOUND')).status).toBe(404);
    expect(toProblem(coded('X_ROUTE_NOT_FOUND')).retry).toBe('terminal');
    const limited = toProblem(rateLimited('actor:1', 30));
    expect(limited.status).toBe(429);
    expect(limited.retry).toBe('retry-after');
  });

  test('a hidden 5xx answers the class and still no cause', () => {
    const thrown = coded('X_DB_SERIALIZATION_FAILURE', 'retryable');
    const document = toProblem(thrown);
    expect(document.status).toBeGreaterThanOrEqual(500);
    expect(document.retry).toBe('retryable');
    expect(document.cause).not.toBe('c');
  });

  test('an opaque 500 is terminal: nobody classified it', () => {
    const document = toProblem(new TypeError('postgres://user:pw@db/app refused'));
    expect(document.status).toBe(500);
    expect(document.retry).toBe('terminal');
    expect(JSON.stringify(document)).not.toContain('postgres://');
  });

  test('a throwable that refuses to be read cannot take the document with it', () => {
    const hostile = new UltimateError({ code: 'X_TIMEOUT', cause: 'c', fix: 'f' });
    Object.defineProperty(hostile, 'retry', {
      get() {
        throw coded('X_TIMEOUT');
      },
    });
    expect(toProblem(hostile).retry).toBe('terminal');
  });

  test('the member lands at the document root, serialised', () => {
    const served = JSON.parse(JSON.stringify(toProblem(rateLimited('actor:1', 30))));
    expect(served.retry).toBe('retry-after');
    expect(served.meta).toBeUndefined();
  });
});
