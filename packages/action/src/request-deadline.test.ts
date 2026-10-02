import { afterEach, describe, expect, test } from 'bun:test';
import { configureHttp, defineHttpConfig, resetHttpConfig } from '@ultimat3/http';
import { requestDeadlineMs } from './request-deadline';

describe('the request deadline an idempotency record is reclaimed after', () => {
  afterEach(resetHttpConfig);

  test('undeclared, it is the http default — read from http, never restated here', () => {
    const http = defineHttpConfig({ rateLimit: { scope: 'process' } });
    expect(requestDeadlineMs()).toBe(http.requestTimeoutMs);
  });

  test('declared, it is the app’s — and a later declaration is seen, not a cached first answer', () => {
    configureHttp({ requestTimeoutMs: 45_000 });
    expect(requestDeadlineMs()).toBe(45_000);
    configureHttp({ requestTimeoutMs: 5_000 });
    expect(requestDeadlineMs()).toBe(5_000);
  });

  test('0 stays "no deadline"', () => {
    configureHttp({ requestTimeoutMs: 0 });
    expect(requestDeadlineMs()).toBe(0);
  });
});
